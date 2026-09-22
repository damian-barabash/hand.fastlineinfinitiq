// ── hand-api — silnik produktu AI Łowca Leadów (Hand) ─────────────────────────────
// Odpowiada za wszystko, czego panel Hand nie może zrobić sam:
//   • wyszukiwanie leadów (LinkedIn przez Unipile, Google Places, otwarty web)
//   • kwalifikację leadów modelem (jedno wywołanie na partię, nie na lead)
//   • pisanie pierwszej wiadomości z bazy wiedzy projektu
//   • wysyłkę w limitach dziennych i w godzinach pracy (cron „tick")
//   • odbiór odpowiedzi (webhook Unipile) i pełną historię rozmów
//
// Zasady, które trzymają to przy życiu w izolacie Supabase (150 s wall-clock
// i twardy limit CPU, po którym worker ginie BEZ logu):
//   • jedno wywołanie modelu na akcję, nigdy pętla po leadach,
//   • każdy fetch ma AbortSignal.timeout, każdy run ma własny deadline,
//   • treść stron tniemy do SCAN_CAP zanim puścimy na nią regexy.
//
// Autoryzacja: token sesji z brain_sessions (ta sama sesja co Brain — platforma
// jest jedna), albo x-hand-key = HAND_CRON_KEY dla crona i webhooka.
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const db = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-hand-key",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const J = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });

const SCAN_CAP = 300_000; // ile znaków strony w ogóle oglądamy (CPU izolatu)
const PRODUCT = "hand";

// ── domyślna konfiguracja projektu ──────────────────────────────────────────
// Wartości ustalone z klientem: autopilot z progiem 70, 40 zaproszeń i 80
// wiadomości dziennie, pn–sob 8:00–19:00, ton „po polsku, na Ty".
const DEFAULT_CONFIG = {
  autopilot: false,
  score_threshold: 70,
  sources: { linkedin: true, maps: true, web: true },
  icp: {
    industry: "",
    titles: "właściciel, prezes, dyrektor, manager",
    location: "Polska",
    company_size: "",
    keywords: "",
    exclude: "",
  },
  unipile_account_id: "",
  limits: { invites_per_day: 40, messages_per_day: 80, hours: [8, 19], days: [1, 2, 3, 4, 5, 6] },
  tone: { form: "ty", language: "pl", signature: "", max_chars: 400, template: "" },
  email: { enabled: true, from: "", subject: "" },
  // Kim agent jest dla odbiorcy. Na LinkedInie ZAWSZE właściciel podłączonego
  // konta (to jego profil — nie da się pisać jako ktoś inny). W e-mailu `name`
  // to osoba, która się podpisuje (puste = nazwa nadawcy skrzynki). Firma to
  // marka, którą się przedstawia — nazwa projektu („FRA b2b") do tego się nie nadaje.
  // intro_*: własne zdanie przedstawienia na kanał (puste = „Nazywam się X i piszę z Y.");
  // zmienne {imie} {firma}. Właściciel chce np. „Jestem kierowcą wyścigowym i prowadzę FRA".
  identity: { name: "", company: "", intro_linkedin: "", intro_email: "" },
};

// Notatka do zaproszenia LinkedIn ma twardy limit u LinkedIna (300 znaków) —
// dłuższy tekst i tak byśmy ucięli w pół zdania.
const LI_INVITE_MAX = 280;

type Cfg = typeof DEFAULT_CONFIG & Record<string, unknown>;

function mergeCfg(stored: unknown): Cfg {
  const s = (stored ?? {}) as Record<string, unknown>;
  const out = { ...DEFAULT_CONFIG } as Record<string, unknown>;
  for (const [k, v] of Object.entries(s)) {
    const base = (DEFAULT_CONFIG as Record<string, unknown>)[k];
    out[k] = base && typeof base === "object" && !Array.isArray(base) && v && typeof v === "object"
      ? { ...(base as Record<string, unknown>), ...(v as Record<string, unknown>) }
      : v;
  }
  return out as Cfg;
}

// Konto LinkedIn projektu: najpierw wybór admina w hand_config, a gdy go nie ma —
// konto podłączone przez klienta linkiem (fiq_project_accounts, wspólne dla produktów;
// link generuje się w Integracjach, obsługuje go brain-admin + brain-hook).
async function withLinkedIn(projectId: string, cfg: Cfg): Promise<Cfg> {
  if (!cfg.unipile_account_id) {
    const { data } = await db.from("fiq_project_accounts").select("account_id").eq("project_id", projectId)
      .eq("provider", "LINKEDIN").eq("status", "OK").order("connected_at", { ascending: false }).limit(1);
    if (data?.[0]?.account_id) cfg.unipile_account_id = String(data[0].account_id);
  }
  return cfg;
}
async function loadCfg(projectId: string): Promise<Cfg> {
  const { data } = await db.from("hand_config").select("config").eq("project_id", projectId).maybeSingle();
  return await withLinkedIn(projectId, mergeCfg(data?.config));
}

// ── autoryzacja ─────────────────────────────────────────────────────────────
type User = { id: string; role: string; workspace_id: string | null };

async function authUser(token: string): Promise<User | null> {
  if (!token) return null;
  const { data: s } = await db
    .from("brain_sessions").select("user_id, expires_at").eq("token", token).maybeSingle();
  if (!s || new Date(s.expires_at) < new Date()) return null;
  const { data: u } = await db
    .from("brain_users").select("id, role, workspace_id, disabled").eq("id", s.user_id).maybeSingle();
  if (!u || u.disabled) return null;
  return { id: u.id, role: u.role, workspace_id: u.workspace_id };
}

// Projekt musi należeć do workspace'u użytkownika, a workspace mieć produkt Hand.
async function assertProject(user: User, projectId: string) {
  if (!projectId) throw new Error("brak projektu");
  const { data: p } = await db.from("brain_projects").select("workspace_id").eq("id", projectId).maybeSingle();
  if (!p) throw new Error("projekt nie istnieje");
  if (user.role === "admin") return p.workspace_id as string;
  if (p.workspace_id !== user.workspace_id) throw new Error("brak dostępu do projektu");
  const { data: link } = await db
    .from("fiq_workspace_products").select("product_key").eq("workspace_id", p.workspace_id).eq("product_key", PRODUCT)
    .maybeSingle();
  if (!link) throw new Error("workspace nie ma dostępu do AI Łowca Leadów");
  // przypisanie klienta do konkretnych projektów (puste = wszystkie w workspace)
  const { data: mine } = await db.from("brain_user_projects").select("project_id").eq("user_id", user.id);
  if (mine?.length && !mine.some((r: { project_id: string }) => r.project_id === projectId)) {
    throw new Error("brak dostępu do projektu");
  }
  return p.workspace_id as string;
}

// ── klucze integracji (wklejone w panelu albo z sekretów) ───────────────────
async function integrationKey(key: string, defaultSecret: string) {
  const { data } = await db.from("brain_settings").select("value").eq("key", key).maybeSingle();
  const cfg = (data?.value ?? {}) as Record<string, string>;
  const token = (cfg.api_key || "").trim() || Deno.env.get((cfg.key_secret || defaultSecret).trim()) || "";
  return { cfg, token };
}

async function unipile() {
  const { cfg, token } = await integrationKey("unipile", "UNIPILE_TOKEN");
  const dsn = String(cfg.dsn ?? "").trim().replace(/^https?:\/\//, "").replace(/\/+$/, "");
  return { dsn, token, ready: !!(dsn && token) };
}

async function uniFetch(path: string, init: RequestInit = {}, timeout = 25_000) {
  const { dsn, token, ready } = await unipile();
  if (!ready) throw new Error("Unipile nieskonfigurowane — wklej DSN i token w panelu admina (Integracje)");
  const r = await fetch(`https://${dsn}/api/v1${path}`, {
    ...init,
    headers: { "X-API-KEY": token, accept: "application/json", "Content-Type": "application/json", ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(timeout),
  });
  const text = await r.text();
  let data: unknown = {};
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text.slice(0, 400) };
  }
  if (!r.ok) throw new Error(`Unipile ${r.status}: ${text.slice(0, 200)}`);
  return data as Record<string, unknown>;
}

// ── dostawca AI (ten sam co w Brain: ustawienie ai_provider) ────────────────
type AiCfg = { base_url?: string; model?: string; temperature?: number; max_tokens?: number; key_secret?: string; api_key?: string };

// Cennik DeepSeek (USD za 1M tokenów, stan 2026-09): [wejście bez cache, wejście z cache, wyjście]
// w godzinach szczytu; poza szczytem połowa. Szczyt: pn–pt 01:00–04:00 i 06:00–10:00 UTC.
// Model lokalny (qwen na Barabash AI) kosztuje 0 — serwer jest własny.
// TEN SAM blok w brain-chat / brain-sales / brain-admin (żelazna zasada synchronizacji).
const PRICES: Record<string, [number, number, number]> = {
  "deepseek-v4-pro": [1.32, 0.044, 3.96],
  "deepseek-reasoner": [1.32, 0.044, 3.96],
  "deepseek-flash": [0.3, 0.006, 1.2],
  "deepseek-chat": [0.3, 0.006, 1.2],
  "deepseek": [0.3, 0.006, 1.2],
  "gpt-4o-mini": [0.15, 0.075, 0.6],
  "gpt-4o": [2.5, 1.25, 10],
};
function isPeakUtc(d = new Date()) {
  const day = d.getUTCDay(), h = d.getUTCHours();
  return day >= 1 && day <= 5 && ((h >= 1 && h < 4) || (h >= 6 && h < 10));
}
type Usage = { prompt_tokens?: number; completion_tokens?: number; prompt_cache_hit_tokens?: number; prompt_cache_miss_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } };
function costUsd(model: string, u: Usage | undefined) {
  const m = model.toLowerCase();
  const k = Object.keys(PRICES).find((p) => m.includes(p));
  if (!k || !u) return 0;
  const [inMiss, inHit, out] = PRICES[k].map((x) => (isPeakUtc() ? x : x / 2));
  const pt = Number(u.prompt_tokens ?? 0);
  const hit = Number(u.prompt_cache_hit_tokens ?? u.prompt_tokens_details?.cached_tokens ?? 0);
  const miss = Number(u.prompt_cache_miss_tokens ?? Math.max(0, pt - hit));
  return +((miss / 1e6) * inMiss + (hit / 1e6) * inHit + (Number(u.completion_tokens ?? 0) / 1e6) * out).toFixed(6);
}
// modele „myślące" (DeepSeek V4) zjadają max_tokens na rozumowanie i oddają pustą treść —
// nasze zadania są krótkie i instrukcyjne, myślenie wyłączamy; lokalny qwen tego pola nie zna i ignoruje
function usageParts(u: Usage | undefined) {
  const pt = Number(u?.prompt_tokens ?? 0);
  const hit = Number(u?.prompt_cache_hit_tokens ?? u?.prompt_tokens_details?.cached_tokens ?? 0);
  const miss = Number(u?.prompt_cache_miss_tokens ?? Math.max(0, pt - hit));
  return { pt, hit, miss, ct: Number(u?.completion_tokens ?? 0), peak: isPeakUtc() };
}
const isDeepSeek = (model: string) => /deepseek/i.test(model);
// słaby model lokalny wymaga dodatkowych przebiegów (redaktor, pytanie); mocny robi to w jednym
const isWeakModel = (model: string) => /qwen|llama|mistral|gemma|phi|:\d+b/i.test(model);

async function currentModel() {
  return providerConfig(await aiConfig()).model;
}

async function aiConfig(): Promise<AiCfg> {
  const { data } = await db.from("brain_settings").select("value").eq("key", "ai_provider").maybeSingle();
  return (data?.value ?? {}) as AiCfg;
}

function providerConfig(ai: AiCfg) {
  let baseUrl = (ai.base_url || Deno.env.get("BARABASH_AI_URL") || "").trim().replace(/\/+$/, "");
  if (baseUrl.endsWith("/chat/completions")) baseUrl = baseUrl.slice(0, -"/chat/completions".length);
  if (baseUrl && !baseUrl.endsWith("/v1")) baseUrl += "/v1";
  // klucz wklejony w panelu ma pierwszeństwo nad sekretem Supabase
  const apiKey = (ai.api_key || "").trim() || Deno.env.get((ai.key_secret || "BRAIN_AI_KEY").trim()) || "";
  return { baseUrl, apiKey, model: (ai.model || "").trim() || "qwen3.5:9b" };
}

// Jedno wywołanie modelu + zapis kosztu. Zwraca surowy tekst albo null.
async function ask(projectId: string, action: string, system: string, user: string, maxTokens = 700, temperature?: number) {
  const ai = await aiConfig();
  const { baseUrl, apiKey, model } = providerConfig(ai);
  if (!baseUrl || !apiKey) {
    console.error("hand: brak konfiguracji dostawcy AI");
    return null;
  }
  // Wspólna bramka AI (Brain, audyty, Hand) bywa nasycona — jedno czknięcie nie
  // może kończyć się dla klienta pustym ekranem, więc próbujemy drugi raz.
  const call = () =>
    fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        stream: false,
        temperature: temperature ?? ai.temperature ?? 0.5,
        max_tokens: maxTokens,
        messages: [{ role: "system", content: system }, { role: "user", content: user }],
        ...(isDeepSeek(model) ? { thinking: { type: "disabled" } } : {}),
      }),
      signal: AbortSignal.timeout(70_000),
    });
  let r: Response | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt) await new Promise((res) => setTimeout(res, 1200));
    try {
      r = await call();
    } catch (e) {
      console.error("hand: dostawca niedostępny", String(e).slice(0, 200));
      r = null;
      continue;
    }
    if (r.ok) break;
    console.error("hand: dostawca", r.status, (await r.text().catch(() => "")).slice(0, 300));
    r = null;
  }
  if (!r) return null;
  const data = await r.json().catch(() => ({}));
  const text = String(data?.choices?.[0]?.message?.content ?? "").trim();
  const pt = Number(data?.usage?.prompt_tokens ?? 0);
  const ct = Number(data?.usage?.completion_tokens ?? 0);
  await db.from("fiq_ai_usage").insert({
    product_key: PRODUCT,
    project_id: projectId,
    action,
    model,
    prompt_tokens: pt,
    completion_tokens: ct,
    cost_usd: costUsd(model, data?.usage as Usage),
    ...(() => { const x = usageParts(data?.usage as Usage); return { cache_hit_tokens: x.hit, cache_miss_tokens: x.miss, peak: x.peak }; })(),
  });
  return text || null;
}

// Odpowiedź ucięta limitem tokenów: tablica bez „]" — bierzemy wszystkie KOMPLETNE obiekty,
// zamiast wyrzucać całą partię (20 leadów po 50 bez uzasadnienia — 22.09).
function salvageArray<T>(text: string): T[] {
  const out: T[] = [];
  let depth = 0, start = -1, inStr = false, esc = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inStr) { if (esc) esc = false; else if (ch === "\\") esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') { inStr = true; continue; }
    if (ch === "{") { if (depth === 0) start = i; depth++; }
    else if (ch === "}") { depth--; if (depth === 0 && start >= 0) { try { out.push(JSON.parse(text.slice(start, i + 1)) as T); } catch { /* niepełny */ } start = -1; } }
  }
  return out;
}

// Model bywa gadatliwy — wyłuskujemy pierwszy poprawny JSON z odpowiedzi.
function parseJson<T>(text: string | null): T | null {
  if (!text) return null;
  const clean = text.replace(/```json|```/g, "").trim();
  const start = clean.search(/[[{]/);
  if (start < 0) return null;
  const open = clean[start];
  const close = open === "[" ? "]" : "}";
  const end = clean.lastIndexOf(close);
  if (end <= start) return null;
  try {
    return JSON.parse(clean.slice(start, end + 1)) as T;
  } catch {
    return null;
  }
}

// ── baza wiedzy projektu (wspólna z Brain) ──────────────────────────────────
// Strona WWW zapisana do wiedzy zaczyna się od menu („Przejdź do treści Koszyk
// 0,00 zł O nas Oferta…") — przy cięciu do 800 znaków model dostawał SAMO menu
// i nic o ofercie. Tniemy więc wstęp do pierwszego prawdziwego zdania.
function dropNav(text: string) {
  const m = text.match(/(?:^|[.!?…]\s+)([A-ZĄĆĘŁŃÓŚŹŻ][^.!?]{50,}[.!?])/);
  if (!m || m.index === undefined) return text;
  const start = m.index + m[0].length - m[1].length;
  return start > 120 ? text.slice(start) : text;
}

async function knowledge(projectId: string, cap = 7000) {
  const { data: items } = await db
    .from("brain_kb_items").select("type, title, content, url").eq("project_id", projectId).order("sort").limit(40);
  const { data: prods } = await db
    .from("brain_products").select("name, description, manual_notes, price, price_currency").eq("project_id", projectId).order("sort").limit(20);
  const parts: string[] = [];
  // opis produktu jest już streszczeniem jego źródeł — idzie pierwszy i w całości
  for (const p of prods ?? []) {
    parts.push(
      `[produkt] ${p.name}: ${String(p.description ?? "").slice(0, 1200)}${p.manual_notes ? ` | Od właściciela: ${String(p.manual_notes).slice(0, 400)}` : ""}` +
        (p.price ? ` (od ${p.price} ${p.price_currency ?? "PLN"})` : ""),
    );
  }
  const seen = new Set<string>();
  for (const it of items ?? []) {
    let body = String(it.content ?? it.url ?? "").replace(/\s+/g, " ").trim();
    if (!body) continue;
    // ta sama strona dodana dwa razy (do firmy i do produktu) nie ma zajmować miejsca dwa razy
    const key = body.slice(0, 300);
    if (seen.has(key)) continue;
    seen.add(key);
    if (it.type === "url") body = dropNav(body);
    parts.push(`[${it.type}] ${it.title ?? ""}: ${body.slice(0, 2200)}`);
  }
  return parts.join("\n").slice(0, cap);
}

// ── wskazówki trenera (poprawki z testowego czatu) ───────────────────────────
// Ten sam mechanizm co u doradcy i sprzedawcy w Brain (brain_feedback), osobny
// scope — uwaga dobra dla Łowcy („nie pytaj o budżet w pierwszej wiadomości")
// nie ma nic wspólnego z doradcą na czacie.
// Ten sam układ, który uratował doradcę (brain-chat v27): instrukcje właściciela stoją
// NA GÓRZE jako najwyższy priorytet i wracają NA KOŃCU jako lista kontrolna — model 9B
// gubił wskazówkę doklejoną raz na końcu, gdy reguła wyżej mówiła co innego.
async function lessons(projectId: string): Promise<{ top: string; tail: string }> {
  const { data } = await db
    .from("brain_feedback").select("note, corrected").eq("project_id", projectId).eq("scope", "hand")
    .eq("status", "approved").order("created_at", { ascending: true }).limit(12);
  const rows = (data ?? []) as { note: string; corrected: string }[];
  if (!rows.length) return { top: "", tail: "" };
  const list = rows
    .map((r, i) => `${i + 1}. ${String(r.note).slice(0, 300)}${r.corrected ? ` (wzór: ${String(r.corrected).slice(0, 300)})` : ""}`)
    .join("\n");
  return {
    top: `INSTRUKCJE WŁAŚCICIELA FIRMY (NAJWYŻSZY PRIORYTET — ważniejsze niż wszystkie reguły niżej; gdy coś się kłóci, wygrywa ta lista):\n${list}\n\n`,
    tail: `\n\nZANIM ODDASZ TEKST — SPRAWDŹ PO KOLEI:\n${list}\nJeśli którykolwiek punkt nie jest spełniony, popraw tekst przed oddaniem.`,
  };
}

// Drugi przebieg: model 9B nie trzyma zakazów („nie pisz, że firma czegoś potrzebuje")
// w jednym przejściu — w 3 z 4 prób pisał je mimo instrukcji na górze i listy na końcu.
// Dlatego po napisaniu tekstu osobne wywołanie sprawdza go punkt po punkcie i poprawia
// TYLKO to, co narusza instrukcje właściciela (jak `syncProductDescription` w Brain).
async function enforceLessons(projectId: string, L: { top: string; tail: string }, text: string, kind: "linkedin" | "email" | "reply") {
  if (!L.top || !text) return text;
  const out = await ask(
    projectId,
    "draft",
    L.top +
      "Jesteś redaktorem. Dostajesz gotową wiadomość i sprawdzasz ją WYŁĄCZNIE względem powyższych instrukcji właściciela, punkt po punkcie. " +
      (kind === "reply"
        ? "To ODPOWIEDŹ w trwającej rozmowie: bez powitania i bez przedstawiania się — instrukcje o powitaniu i pierwszej wiadomości tu nie obowiązują; nie dopisuj „Cześć”. "
        : "") +
      "Jeśli wszystko jest spełnione — zwracasz dokładnie: OK. " +
      "Jeśli coś jest naruszone — zwracasz CAŁĄ wiadomość poprawioną tak, żeby każdy punkt był spełniony; zmieniasz tylko naruszające fragmenty, resztę zostawiasz dosłownie (powitanie, zdanie przedstawienia, pytanie na końcu, podpis" +
      (kind === "email" ? ", linię TEMAT" : "") + "). " +
      "Nie dodajesz komentarza, nie używasz cudzysłowów wokół treści, nie skracasz bez potrzeby. Nie pisz „Poprawiona wersja:”.",
    `WIADOMOŚĆ DO SPRAWDZENIA:\n${text}`,
    kind === "linkedin" ? 320 : 600,
    0.1,
  );
  if (!out) return text;
  const clean = out.replace(/^["„]+|["”]+$/g, "").trim();
  if (/^ok[.!]?$/i.test(clean) || clean.length < 40) return text;
  return clean;
}

// ── kim agent jest dla odbiorcy ──────────────────────────────────────────────
// Wiadomość bez „kto pisze" wygląda jak spam, a z wymyślonym nazwiskiem — jak
// oszustwo. Nazwisko bierzemy z konta, z którego wiadomość naprawdę wychodzi.
type Identity = { name: string; company: string; email: string };

async function senderIdentity(projectId: string, cfg: Cfg, channel: "linkedin" | "email"): Promise<Identity> {
  const id = (cfg.identity ?? { name: "", company: "" }) as { name?: string; company?: string };
  let name = "";
  let email = "";
  if (channel === "linkedin") {
    if (cfg.unipile_account_id) {
      const { data } = await db.from("fiq_project_accounts").select("account_name").eq("account_id", cfg.unipile_account_id).maybeSingle();
      name = String(data?.account_name ?? "").trim();
    }
  } else {
    name = String(id.name ?? "").trim();
    const mail = await projectEmail(projectId);
    const own = String(cfg.email.from || "").trim(); // „Imię <adres>" albo sam adres
    const m = own.match(/^(.*?)\s*<([^>]+)>$/);
    email = (m ? m[2] : own) || String(mail.from_email ?? "");
    if (!name) name = (m ? m[1].trim() : "") || String(mail.from_name ?? "").trim();
  }
  let company = String(id.company ?? "").trim();
  if (!company) {
    const { data } = await db.from("brain_projects").select("name").eq("id", projectId).maybeSingle();
    company = String(data?.name ?? "").trim();
  }
  return { name, company, email };
}

// ── realny stan integracji ──────────────────────────────────────────────────
// Sam fakt, że klucz jest wklejony, nic nie znaczy: klucz Google potrafi być
// poprawny, a Places API wyłączone w projekcie — wtedy pierwsze wyszukiwanie
// kończy się błędem, którego nikt się nie spodziewa. Dlatego pytamy dostawcę
// naprawdę, a wynik trzymamy przez CHECK_TTL, żeby nie robić tego przy każdym
// otwarciu ekranu.
const CHECK_TTL_MS = 10 * 60_000;
const PLACES_CONSOLE = "https://console.cloud.google.com/apis/library/places.googleapis.com";
const UNIPILE_CONSOLE = "https://dashboard.unipile.com";

type Status = { ok: boolean; reason?: string; url?: string; checked_at?: string };

async function readStatus(key: string): Promise<Status | null> {
  const { data } = await db.from("brain_settings").select("value").eq("key", `${key}_status`).maybeSingle();
  const v = (data?.value ?? null) as Status | null;
  if (!v?.checked_at) return null;
  return Date.now() - new Date(v.checked_at).getTime() < CHECK_TTL_MS ? v : null;
}

async function writeStatus(key: string, st: Status) {
  const value = { ...st, checked_at: new Date().toISOString() };
  await db.from("brain_settings").upsert({ key: `${key}_status`, value, updated_at: new Date().toISOString() });
  return value;
}

async function checkMaps(force = false): Promise<Status> {
  const { token } = await integrationKey("maps", "GOOGLE_MAPS_KEY");
  if (!token) return { ok: false, reason: "Brak klucza Google — wklej go w panelu admina (Integracje)", url: PLACES_CONSOLE };
  if (!force) {
    const cached = await readStatus("maps");
    if (cached) return cached;
  }
  try {
    const r = await fetch("https://places.googleapis.com/v1/places:searchText", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Goog-Api-Key": token, "X-Goog-FieldMask": "places.displayName" },
      body: JSON.stringify({ textQuery: "warsztat Kraków", languageCode: "pl", maxResultCount: 1 }),
      signal: AbortSignal.timeout(15_000),
    });
    const data = await r.json().catch(() => ({}));
    if (r.ok) return await writeStatus("maps", { ok: true });
    const msg = String(data?.error?.message ?? `HTTP ${r.status}`);
    // najczęstszy przypadek: klucz działa, ale Places API (New) nie jest włączone
    const url = String(data?.error?.details?.[0]?.metadata?.activationUrl ?? PLACES_CONSOLE);
    const short = /has not been used|is disabled|SERVICE_DISABLED/i.test(msg)
      ? "Places API (New) nie jest włączone w projekcie Google"
      : msg.slice(0, 160);
    return await writeStatus("maps", { ok: false, reason: short, url });
  } catch (e) {
    return { ok: false, reason: `Google nie odpowiada: ${String((e as Error).message ?? e).slice(0, 120)}`, url: PLACES_CONSOLE };
  }
}

async function checkLinkedIn(force = false): Promise<Status> {
  const { dsn, token, ready } = await unipile();
  if (!ready) {
    return {
      ok: false,
      reason: dsn ? "Brak tokenu Unipile — wklej go w panelu admina (Integracje)" : "Brak DSN i tokenu Unipile",
      url: UNIPILE_CONSOLE,
    };
  }
  if (!force) {
    const cached = await readStatus("unipile");
    if (cached) return cached;
  }
  try {
    const r = await fetch(`https://${dsn}/api/v1/accounts`, {
      headers: { "X-API-KEY": token, accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!r.ok) {
      const body = (await r.text().catch(() => "")).slice(0, 160);
      return await writeStatus("unipile", { ok: false, reason: `Unipile ${r.status}: ${body}`, url: UNIPILE_CONSOLE });
    }
    const data = await r.json().catch(() => ({}));
    const n = ((data?.items ?? data?.accounts ?? []) as unknown[]).length;
    return await writeStatus(
      "unipile",
      n ? { ok: true } : { ok: false, reason: "Token działa, ale nie ma podłączonego żadnego konta LinkedIn", url: UNIPILE_CONSOLE },
    );
  } catch (e) {
    return { ok: false, reason: `Unipile nie odpowiada: ${String((e as Error).message ?? e).slice(0, 120)}`, url: UNIPILE_CONSOLE };
  }
}

async function integrationsStatus(force = false) {
  const [linkedin, maps] = await Promise.all([checkLinkedIn(force), checkMaps(force)]);
  return { linkedin, maps, web: { ok: true } as Status };
}

// ── źródła leadów ───────────────────────────────────────────────────────────
type Cand = {
  source: string;
  full_name?: string;
  headline?: string;
  company?: string;
  title?: string;
  location?: string;
  li_urn?: string;
  li_url?: string;
  website?: string;
  email?: string;
  phone?: string;
  meta?: Record<string, unknown>;
};

const LOC_CACHE = new Map<string, string>();
async function linkedInLocationId(accountId: string, name: string): Promise<string> {
  const key = name.trim().toLowerCase();
  if (!key) return "";
  if (LOC_CACHE.has(key)) return LOC_CACHE.get(key)!;
  try {
    const data = await uniFetch(
      `/linkedin/search/parameters?account_id=${encodeURIComponent(accountId)}&type=LOCATION&keywords=${encodeURIComponent(name.trim())}&limit=5`,
      {},
      20_000,
    );
    const items = (data?.items ?? []) as Array<{ id?: string; title?: string }>;
    // „Polska" → LinkedIn zna kraj jako „Poland": bierzemy pierwszy wynik (najlepsze dopasowanie), nie pełne dopasowanie nazwy
    const id = String(items[0]?.id ?? "");
    LOC_CACHE.set(key, id);
    return id;
  } catch (e) {
    console.error("linkedin location lookup:", String(e).slice(0, 160));
    return "";
  }
}

// LinkedIn przez Unipile. Wyszukiwarka Unipile zwraca listę profili dla zapytania
// „classic" (odpowiednik zwykłego wyszukiwania LinkedIn) — bierzemy pierwszą stronę.
async function searchLinkedIn(cfg: Cfg, query: string, limit: number): Promise<Cand[]> {
  const accountId = String(cfg.unipile_account_id || "");
  if (!accountId) throw new Error("Nie wybrano konta LinkedIn dla tego projektu (Integracje)");
  const body: Record<string, unknown> = {
    api: "classic",
    category: "people",
    keywords: query,
  };
  // `location` przyjmuje WYŁĄCZNIE identyfikatory geograficzne LinkedIna (np. Polska = 105072130), nie nazwy —
  // z nazwą Unipile odpowiadał 400 invalid_parameters i wyszukiwanie padało. Nazwę z ICP tłumaczymy na id
  // przez /linkedin/search/parameters; gdy się nie da, szukamy bez lokalizacji (lepsze niż błąd).
  const locId = await linkedInLocationId(accountId, String(cfg.icp.location || ""));
  if (locId) body.location = [locId];
  const data = await uniFetch(
    `/linkedin/search?account_id=${encodeURIComponent(accountId)}&limit=${Math.min(limit, 50)}`,
    { method: "POST", body: JSON.stringify(body) },
    45_000,
  );
  const items = (data?.items ?? data?.results ?? []) as Array<Record<string, unknown>>;
  return items.slice(0, limit).map((p) => ({
    source: "linkedin",
    full_name: String(p.name ?? [p.first_name, p.last_name].filter(Boolean).join(" ") ?? "").trim(),
    headline: String(p.headline ?? p.subtitle ?? ""),
    company: String((p.current_company as Record<string, unknown> | undefined)?.name ?? p.company ?? ""),
    title: String(p.title ?? p.position ?? ""),
    location: String(p.location ?? ""),
    li_urn: String(p.id ?? p.provider_id ?? p.public_identifier ?? ""),
    li_url: String(p.profile_url ?? p.public_profile_url ?? ""),
    meta: { raw_keys: Object.keys(p).slice(0, 20) },
  }));
}

// Google Places (New). Daje to, czego LinkedIn nie ma: telefon, adres, stronę.
async function searchMaps(query: string, limit: number): Promise<Cand[]> {
  const { token } = await integrationKey("maps", "GOOGLE_MAPS_KEY");
  if (!token) throw new Error("Brak klucza Google Places — wklej go w panelu admina (Integracje)");
  const r = await fetch("https://places.googleapis.com/v1/places:searchText", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": token,
      "X-Goog-FieldMask":
        "places.displayName,places.formattedAddress,places.nationalPhoneNumber,places.websiteUri,places.rating,places.userRatingCount,places.primaryTypeDisplayName,places.googleMapsUri",
    },
    body: JSON.stringify({ textQuery: query, languageCode: "pl", maxResultCount: Math.min(limit, 20) }),
    signal: AbortSignal.timeout(25_000),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const url = String(data?.error?.details?.[0]?.metadata?.activationUrl ?? "");
    throw new Error(
      String(data?.error?.message ?? `Google ${r.status}`).slice(0, 200) + (url ? ` — włącz API: ${url}` : ""),
    );
  }
  return ((data?.places ?? []) as Array<Record<string, unknown>>).map((p) => ({
    source: "maps",
    company: String((p.displayName as Record<string, unknown> | undefined)?.text ?? ""),
    location: String(p.formattedAddress ?? ""),
    phone: String(p.nationalPhoneNumber ?? ""),
    website: cleanSite(String(p.websiteUri ?? "")),
    headline: String((p.primaryTypeDisplayName as Record<string, unknown> | undefined)?.text ?? ""),
    meta: { rating: p.rating ?? null, reviews: p.userRatingCount ?? null, maps_url: p.googleMapsUri ?? "" },
  }));
}

// adres strony bez parametrów śledzących (utm z wizytówki Google) — inaczej ta sama
// firma z dwóch źródeł wygląda jak dwie różne i dedup po stronie nie działa
const cleanSite = (u: string) => {
  try {
    const x = new URL(u);
    return `${x.protocol}//${x.host}${x.pathname.replace(/\/+$/, "")}`;
  } catch {
    return u;
  }
};

const stripHtml = (h: string) =>
  h.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();

// Otwarty web: Yahoo PL — jedyna wyszukiwarka, która z IP Supabase odpowiada
// (sprawdzone przy audytach; Bing/DDG blokują, Brave rzuca 429). Parser jest
// przeniesiony 1:1 z audytów: wynik organiczny to blok class="…algo…",
// prawdziwy adres siedzi w parametrze RU=, a tytuł w aria-label nagłówka.
// Yahoo oddaje tytuły z encjami HTML — bez tego w bazie ląduje „Krak&oacute;w".
const NAMED: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  oacute: "ó", Oacute: "Ó", aacute: "á", eacute: "é", uacute: "ú",
  sup2: "²", laquo: "«", raquo: "»", hellip: "…", ndash: "–", mdash: "—",
};
const decodeEntities = (t: string) =>
  t
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-zA-Z][a-zA-Z0-9]{1,8});/g, (m, n) => NAMED[n] ?? m);
const extract = (re: RegExp, t: string) => (t.match(re)?.[1] ?? "").trim();

async function searchWeb(query: string, limit: number): Promise<Cand[]> {
  const url = `https://pl.search.yahoo.com/search?p=${encodeURIComponent(query)}&vl=lang_pl`;
  const once = () =>
    fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
        "Accept-Language": "pl-PL,pl;q=0.9",
        Accept: "text/html",
      },
      signal: AbortSignal.timeout(20_000),
    });
  // Yahoo potrafi zamknąć TLS bez close_notify — jedno czknięcie sieci nie może
  // kończyć całego wyszukiwania błędem u klienta
  let r: Response;
  try {
    r = await once();
  } catch (e) {
    console.error("web search retry po:", String(e).slice(0, 160));
    await new Promise((res) => setTimeout(res, 800));
    r = await once();
  }
  if (!r.ok) throw new Error(`Wyszukiwarka odpowiedziała ${r.status}`);
  const html = (await r.text()).slice(0, 1_500_000);
  const out: Cand[] = [];
  const seen = new Set<string>();
  for (const raw of html.split(/<div class="[^"]*\balgo\b[^"]*"/).slice(1)) {
    if (out.length >= limit) break;
    const seg = raw.slice(0, 7000);
    const h3 = extract(/(<h3[^>]*class="title"[^>]*>[\s\S]*?<\/h3>)/i, seg) || seg;
    const ru = h3.match(/RU=([^/"&]+)/) || seg.match(/RU=([^/"&]+)/);
    if (!ru) continue;
    let href = "";
    try {
      href = decodeURIComponent(ru[1]);
    } catch {
      continue;
    }
    if (!/^https?:\/\//i.test(href)) continue;
    // katalogi, social i encyklopedie to nie są leady — to szum
    if (/yahoo\.com|facebook\.com|linkedin\.com|youtube\.com|wikipedia\.org|instagram\.com|olx\.pl|allegro\./i.test(href)) {
      continue;
    }
    let host = "";
    try {
      host = new URL(href).hostname.replace(/^www\./, "");
    } catch {
      continue;
    }
    if (seen.has(host)) continue;
    seen.add(host);
    const title = decodeEntities(extract(/aria-label="([^"]+)"/i, h3)) || stripHtml(h3).slice(0, 140);
    if (!title || /Wyszukiwania zwi\u0105zane|Powi\u0105zane wyszukiwania/i.test(title)) continue;
    const snippet = stripHtml(extract(/class="compText[^"]*"[^>]*>([\s\S]*?)<\/div>/i, seg)).slice(0, 220);
    out.push({
      source: "web",
      company: title.slice(0, 140),
      headline: snippet,
      website: `https://${host}`,
      meta: { url: href },
    });
  }
  return out;
}

// ── dane kontaktowe ze strony firmy ─────────────────────────────────────────
// Lead z Maps albo z weba nie ma LinkedIna — bez maila nie da się do niego napisać.
// Wchodzimy więc na stronę i wyciągamy adres i telefon. Twarde ograniczenia:
// najwyżej MAX_ENRICH stron, po 4 równolegle, z własnym deadline'em, a treść
// tniemy do SCAN_CAP zanim puścimy na nią regexy (CPU izolatu).
const MAX_ENRICH = 12;
const BAD_MAIL = /(example|sentry|wixpress|godaddy|\.png|\.jpg|\.webp|@2x)/i;

async function pageText(url: string, ms: number) {
  const r = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
      "Accept-Language": "pl-PL,pl;q=0.9",
    },
    redirect: "follow",
    signal: AbortSignal.timeout(ms),
  });
  if (!r.ok) return "";
  return (await r.text()).slice(0, SCAN_CAP);
}

async function enrichFromSite(c: Cand, deadline: number) {
  if (!c.website || (c.email && c.phone)) return;
  const budget = Math.min(9000, deadline - Date.now());
  if (budget < 2500) return;
  let html = "";
  try {
    html = await pageText(c.website, budget);
  } catch {
    return;
  }
  if (!html) return;
  // strona kontaktowa ma dane częściej niż strona główna — jeśli starczy czasu
  if (!/mailto:|@[a-z0-9-]+\.[a-z]{2,}/i.test(html) && Date.now() < deadline - 4000) {
    const link = html.match(/href="([^"]*(kontakt|contact)[^"]*)"/i)?.[1];
    if (link) {
      try {
        html += await pageText(new URL(link, c.website).href, Math.min(6000, deadline - Date.now()));
      } catch { /* strona kontaktowa bywa martwa — zostajemy przy głównej */ }
    }
  }
  const mail = [...html.matchAll(/mailto:([^"'?\s>]+)/gi)].map((m) => m[1])
    .concat([...html.matchAll(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi)].map((m) => m[0]))
    .find((m) => !BAD_MAIL.test(m));
  if (mail && !c.email) {
    // z „mailto:" potrafi wyjść adres strony albo śmieć z parametrów — do bazy trafia tylko poprawny adres
    const addr = decodeURIComponent(mail).toLowerCase().trim().slice(0, 120);
    if (/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/.test(addr)) c.email = addr;
  }
  if (!c.phone) {
    const tel = html.match(/(?:tel:|telefon[^0-9+]{0,12})(\+?48[\s-]?)?((?:\d[\s-]?){9})/i);
    if (tel) c.phone = (tel[0].replace(/^[^+0-9]*/, "")).replace(/\s+/g, " ").slice(0, 24);
  }
  // tytuł strony bywa czystszą nazwą firmy niż nagłówek z wyszukiwarki
  const title = decodeEntities(stripHtml(html.match(/<title[^>]*>([\s\S]{0,160})<\/title>/i)?.[1] ?? ""));
  if (title && (!c.company || c.company.length > 60)) c.company = title.split(/[|–—-]/)[0].trim().slice(0, 120);
}

async function enrichAll(cands: Cand[], deadline: number) {
  const todo = cands.filter((c) => c.website && !c.li_urn && !c.email).slice(0, MAX_ENRICH);
  for (let i = 0; i < todo.length; i += 4) {
    if (Date.now() > deadline - 3000) break;
    await Promise.all(todo.slice(i, i + 4).map((c) => enrichFromSite(c, deadline).catch(() => {})));
  }
}

// ── kwalifikacja: JEDNO wywołanie modelu na całą partię ─────────────────────
async function qualify(projectId: string, cfg: Cfg, kb: string, cands: Cand[]) {
  if (!cands.length) return [];
  const list = cands
    .map((c, i) => {
      const m = (c.meta ?? {}) as Record<string, unknown>;
      const maps = c.source === "maps" && m.rating ? `Google: ${m.rating}★ (${m.reviews ?? 0} opinii)` : "";
      return `${i}. ${[c.full_name, c.title, c.company, c.headline, c.location, c.website, maps, c.email ? "mail: " + c.email : "bez maila"]
        .filter(Boolean).join(" | ")}`;
    })
    .join("\n").slice(0, 8000);
  const system =
    "Jesteś analitykiem sprzedaży B2B. Oceniasz, czy dany podmiot pasuje jako klient firmy opisanej w bazie wiedzy. " +
    "Odpowiadasz WYŁĄCZNIE tablicą JSON, bez komentarza. Piszesz po polsku.";
  const systemFull = system + `

BAZA WIEDZY FIRMY (co sprzedajemy):
${kb || "(brak — oceniaj po profilu idealnego klienta)"}

PROFIL IDEALNEGO KLIENTA:
branża: ${cfg.icp.industry || "(dowolna)"}
stanowiska: ${cfg.icp.titles || "(dowolne)"}
lokalizacja: ${cfg.icp.location || "(dowolna)"}
wielkość firmy: ${cfg.icp.company_size || "(dowolna)"}
słowa kluczowe: ${cfg.icp.keywords || "-"}
wyklucz: ${cfg.icp.exclude || "-"}`;
  const user = `KANDYDACI:
${list}

Zasady oceny:
- Oceniasz KAŻDEGO kandydata osobno, po jego własnych danych. Dwa różne podmioty nie mogą dostać identycznego uzasadnienia — w "why" wskaż konkret z tego wiersza (co robi, dla kogo, gdzie, skala).
- Score 0 tylko dla stron, które NIE są firmą-klientem: katalog firm, porównywarka, ranking („10 najlepszych…"), portal ogłoszeniowy, encyklopedia, blog. Zwykła firma, nawet z ogólną nazwą, to firma — oceń ją normalnie.
- KONKURENCJA to nie klient: podmiot, który sprzedaje to samo, co my (patrz baza wiedzy), albo pośredniczy w tej samej usłudze (agencja, broker, organizator) — score maksymalnie 20, a w "why" napisz „konkurencja/pośrednik". Klient to ten, kto KUPUJE naszą usługę dla siebie, swoich ludzi albo swoich klientów.
- Rozróżniaj: 90-100 = dokładnie profil idealnego klienta i widać powód do kontaktu; 70-89 = pasuje, ale bez wyraźnego haka; 40-69 = pasuje częściowo (inna wielkość, inna rola, pośrednik); poniżej 40 = nie pasuje albo wykluczony.
- Brak maila obniża użyteczność, nie dopasowanie — nie zmieniaj przez to score.
- NIE przypisuj kandydatowi cech z profilu idealnego klienta, których nie ma w jego wierszu (np. „organizuje integracje" — tego nie wiesz). Gdy dopasowanie wynika tylko z branży i lokalizacji, score najwyżej 80, a w "why" napisz to, co naprawdę widać: co robi, gdzie, jaka skala (opinie Google, opis).

Dla każdego kandydata zwróć obiekt:
{"i": <numer>, "score": <0-100 dopasowanie>, "industry": "<branża 1-3 słowa>", "fakty": "<jedno zdanie: co WIADOMO o kandydacie z jego wiersza — co robi, gdzie, jaka skala; bez domysłów>", "ocena": "<3-8 słów: dlaczego pasuje albo nie>"}
Zwróć tablicę dla WSZYSTKICH kandydatów, w tej samej kolejności.`;
  // niska temperatura: ocena ma być powtarzalna, nie kreatywna. „why" składa kod z faktów
  // i oceny — gdy model dostawał jedno pole, wpisywał w nie cechy z profilu klienta, których
  // o kandydacie nie wiedział („organizuje integracje dla pracowników").
  // Limit tokenów rośnie z liczbą kandydatów (~220 na osobę) — 20 kandydatów w 1600 tokenach
  // ucinało JSON i cała partia dostawała 50 bez uzasadnienia.
  type Q = { i: number; score: number; industry?: string; why?: string; fakty?: string; ocena?: string };
  const raw = await ask(projectId, "qualify", systemFull, user, Math.min(6000, Math.max(900, cands.length * 220)), 0.2);
  let parsed = parseJson<Q[]>(raw);
  if ((!parsed || !Array.isArray(parsed)) && raw) {
    parsed = salvageArray<Q>(raw);
    console.error(`qualify: JSON niepełny, uratowano ${parsed.length}/${cands.length}`);
  }
  return (parsed ?? []).map((r) => ({
    ...r,
    // fakty kończą się kropką, ocena zaczyna wielką literą — jedno zdanie, potem drugie
    why: r.fakty || r.ocena
      ? [String(r.fakty ?? "").trim().replace(/[.,;:]+$/, ""), String(r.ocena ?? "").trim().replace(/^./, (c) => c.toUpperCase())].filter(Boolean).join(". ").replace(/\.$/, "") + "."
      : r.why,
  }));
}

// Kwalifikacja w partiach: jedno wywołanie na ≤8 kandydatów — krótsza odpowiedź, mniejsze ryzyko
// ucięcia, a przy padnięciu jednej partii reszta ma oceny.
async function qualifyAll(projectId: string, cfg: Cfg, kb: string, cands: Cand[]) {
  const out = new Map<number, { score: number; industry?: string; why?: string }>();
  for (let from = 0; from < cands.length; from += 8) {
    const part = cands.slice(from, from + 8);
    const scores = await qualify(projectId, cfg, kb, part);
    for (const sc of scores) {
      const idx = from + Number(sc.i);
      if (Number.isFinite(idx) && idx >= from && idx < from + part.length) out.set(idx, sc);
    }
  }
  return out;
}
const NO_SCORE_WHY = "Kwalifikacja nie powiodła się (model nie ocenił tego kandydata), oceń ręcznie albo kliknij „Oceń ponownie”.";

// ── pierwsza wiadomość ──────────────────────────────────────────────────────
// Kanał wynika z leada: profil LinkedIn → zaproszenie z notatką, inaczej e-mail.
const channelOf = (lead: Record<string, unknown>): "linkedin" | "email" => (lead.li_urn ? "linkedin" : "email");

// E-mail dostaje od modelu temat w pierwszej linii („TEMAT: …") — generyczne
// „Krótkie pytanie" w każdym mailu wygląda jak masówka.
function splitSubject(text: string) {
  const m = text.match(/^\s*TEMAT:\s*(.+?)\s*\n+([\s\S]*)$/i);
  if (!m) return { subject: "", text: text.trim() };
  return { subject: m[1].replace(/^["„]|["”]$/g, "").trim().slice(0, 120), text: m[2].trim() };
}

// Myślnik/pauza nie ma prawa wyjść do klienta (decyzja właściciela 2026-09-22) — model lubi je wstawiać
// mimo reguły, więc pilnuje kod: zamiana na przecinek, bez podwójnych znaków.
function noDashes(t: string): string {
  return t
    .replace(/\s*[—–]\s*/g, ", ")
    .replace(/,\s*,/g, ",")
    .replace(/([.!?:]),\s/g, "$1 ")
    .replace(/^,\s*/gm, "")
    // tylko na samym końcu tekstu — przecinek po „Dzień dobry," na końcu linii jest poprawny
    .replace(/,\s*$/, "");
}

type Draft = { text: string; subject: string; channel: "linkedin" | "email" };
// model nie zawsze oddaje linię TEMAT — mail bez tematu nie może wyjść
const defaultSubject = (lead: Record<string, unknown>) =>
  lead.company ? `Krótkie pytanie do ${String(lead.company).slice(0, 60)}` : "Krótkie pytanie";

async function draftMessage(projectId: string, cfg: Cfg, kb: string, lead: Record<string, unknown>): Promise<Draft | null> {
  const channel = channelOf(lead);
  const who = await senderIdentity(projectId, cfg, channel);
  const signature = cfg.tone.signature || [who.name, who.company].filter(Boolean).join(", ");
  const id = (cfg.identity ?? {}) as Record<string, string>;
  const custom = String((channel === "linkedin" ? id.intro_linkedin : id.intro_email) ?? "").trim();
  const intro = noDashes(custom
    ? custom.replace(/\{imie\}/gi, who.name).replace(/\{firma\}/gi, who.company)
    : who.name && who.company
    ? `Nazywam się ${who.name} i piszę z ${who.company}.`
    : who.company ? `Piszę z ${who.company}.` : "(nie przedstawiaj się z nazwiska, bo go nie znasz)");
  if (cfg.tone.template) {
    // sztywny szablon: tylko podstawienie zmiennych, zero improwizacji
    const text = String(cfg.tone.template)
      .replace(/\{imie\}/gi, String(lead.full_name ?? "").split(" ")[0] || "")
      .replace(/\{nazwisko\}/gi, String(lead.full_name ?? "").split(" ").slice(1).join(" "))
      .replace(/\{firma\}/gi, String(lead.company ?? ""))
      .replace(/\{miasto\}/gi, String(lead.location ?? ""))
      .replace(/\{branza\}/gi, String(lead.industry ?? ""))
      .replace(/\{podpis\}/gi, signature);
    return { text, subject: String(cfg.email.subject || ""), channel };
  }
  const form = cfg.tone.form === "pan" ? "formę grzecznościową (Pan/Pani)" : "formę bezpośrednią (na Ty)";
  const maxChars = channel === "linkedin" ? Math.min(cfg.tone.max_chars, LI_INVITE_MAX) : cfg.tone.max_chars;
  const L = await lessons(projectId);
  const weak = isWeakModel(await currentModel());
  const system = L.top +
    `Jesteś ${who.name || "przedstawicielem"} z firmy ${who.company || "(firma z bazy wiedzy)"}. ` +
    `Piszesz pierwszą wiadomość sprzedażową ${channel === "linkedin" ? "jako notatkę do zaproszenia na LinkedIn" : "jako e-mail"}. Po polsku, ${form}. ` +
    `Maksymalnie ${maxChars} znaków treści. Bez korpo-lania, bez „mam nadzieję, że mail zastaje Pana dobrze". ` +
    "Układ: (1) jedno zdanie nawiązujące do odbiorcy (branża, miasto, to, co widać) — NIE twierdzisz, czego odbiorca potrzebuje ani co robi w środku firmy, bo tego nie wiesz; (2) zdanie przedstawienia — DOSŁOWNIE to podane niżej, (3) JEDNA korzyść dopasowana do jego branży, (4) krótkie pytanie na koniec, (5) podpis. " +
    "Powitanie: jeśli znasz imię odbiorcy — „Cześć <imię>,” (na Ty) albo „Dzień dobry Panie/Pani <imię>,”; jeśli NIE znasz imienia — samo „Dzień dobry,” albo „Cześć,”. " +
    "NIGDY „Witaj w <nazwa firmy>” ani „Witaj <nazwa firmy>” — tak wita strona internetowa, nie człowiek. " +
    "NIGDY nie wymyślasz imienia ani nazwiska odbiorcy i nie używasz nazwy firmy jako imienia. " +
    "Wymieniasz TYLKO atrakcje, samochody, tory, liczby, ceny i terminy, które stoją w bazie wiedzy; jeśli w bazie nie ma listy samochodów, piszesz ogólnie („samochody sportowe z naszej floty”). Nie używasz markdown ani emoji. " +
    "JĘZYK: wyłącznie naturalna polszczyzna, jak w rozmowie między ludźmi; bez angielskich wtrąceń (nie „team building”, „event”, „feedback”, tylko „integracja zespołu”, „wydarzenie”, „opinia”; nazwy własne i nazwy produktów zostają); bez myślników i pauz (— –), zamiast nich przecinek albo kropka; bez kalek z korpomowy. " +
    (channel === "email"
      ? "Pierwsza linia odpowiedzi to „TEMAT: <temat maila, 3-7 słów, bez clickbaitu>”, potem pusta linia i treść, na końcu podpis. "
      : "Zwracasz wyłącznie treść notatki, bez tematu i BEZ podpisu — odbiorca widzi Twój profil. To krótka notatka: dokładnie 3 zdania po maksymalnie 15 słów (konkret o odbiorcy · przedstawienie · korzyść zakończona pytaniem). ") +
    "Bez cudzysłowów wokół treści." + L.tail +
    // baza wiedzy w system prompcie: stały prefiks między leadami → DeepSeek liczy go jako cache hit (50× taniej)
    `\n\nCO SPRZEDAJEMY (baza wiedzy):\n${kb || "(brak)"}`;
  const user = `ODBIORCA:
imię i nazwisko: ${lead.full_name || "NIEZNANE — nie wymyślaj imienia"}
stanowisko: ${lead.title || lead.headline || "-"}
firma: ${lead.company ?? "-"}
branża: ${lead.industry ?? "-"}
lokalizacja: ${lead.location ?? "-"}
strona: ${lead.website ?? "-"}
dlaczego pasuje: ${lead.why ?? "-"}

Zdanie przedstawienia (użyj dosłownie, jako drugie zdanie): ${intro}
${channel === "email" ? `Podpisz się dokładnie tak: ${signature}` : "Bez podpisu."}`;
  const raw = await ask(projectId, "draft", system, user, channel === "linkedin" ? 300 : 520);
  if (!raw) return null;
  let { subject, text } = splitSubject(noDashes(raw.replace(/^["„]+|["”]+$/g, "")));
  if (weak) text = await enforceLessons(projectId, L, text, channel);
  // redaktor mógł oddać tekst z linią TEMAT — zdejmujemy ją ponownie
  if (channel === "email") {
    const again = splitSubject(text);
    if (again.subject) subject = again.subject;
    text = again.text;
  }
  // model 9B potrafi „zapomnieć" podpisu albo powitać jak strona WWW — pilnuje kod, nie nadzieja
  text = text.replace(/^\s*Witaj(?:cie)?\s+(?:w\s+)?[^,\n!]{2,60}[,!]?\s*/i, "Dzień dobry,\n\n");
  if (channel === "email" && !text.includes(signature.split(",")[0])) text = `${text.trim()}\n\n${signature}`;
  if (channel === "linkedin") {
    // notatka do zaproszenia: LinkedIn odrzuca dłuższe, a cięcie w pół zdania wygląda jak awaria —
    // zdejmujemy podpis, jeśli model go dopisał, i tniemy na końcu ostatniego pełnego zdania
    text = text.replace(new RegExp(`\\s*${signature.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`), "").trim();
    // model podpisuje się też własnymi wariantami („Mariusz Miękoś, kierowca wyścigowy…") — zdejmujemy
    // każdą KOŃCOWĄ linię zaczynającą się od imienia i nazwiska, byle nie było to zdanie przedstawienia
    if (who.name) {
      const lines = text.split(/\n+/);
      while (lines.length > 1 && lines[lines.length - 1].trim().startsWith(who.name) && !lines[lines.length - 1].includes(intro)) lines.pop();
      text = lines.join("\n").trim();
    }
    if (weak && !/\?\s*$/.test(text)) {
      // bez pytania na końcu notatka jest ślepa — dopisujemy je osobnym, krótkim wywołaniem
      // (z instrukcjami właściciela: on decyduje, JAKIE pytania wolno zadać)
      const q = await ask(
        projectId,
        "draft",
        // bez L.tail: lista kontrolna „popraw tekst" sprawiała, że model oddawał całą notatkę zamiast pytania
        L.top + "Dopisz na końcu tej notatki JEDNO krótkie pytanie (do 10 słów), naturalne, na które łatwo odpowiedzieć „tak”, zgodne z instrukcjami powyżej. Zwróć TYLKO to pytanie, nic więcej.",
        text,
        60,
        0.3,
      );
      let qq = (q ?? "").split(/\n/).map((l) => l.trim()).filter(Boolean).pop() ?? "";
      qq = qq.replace(/^(pytanie|odpowiedź)\s*:\s*/i, "").replace(/^["„]+|["”]+$/g, "").trim();
      if (qq && !/\?$/.test(qq) && /^(czy|jak|co|kiedy|gdzie|ile|chcesz|masz|widzisz|macie|widzicie|zainteres)/i.test(qq)) qq += "?";
      if (qq && /\?$/.test(qq) && qq.length <= 100) text = `${text.trim()} ${qq}`;
      // ostatnia deska: pytanie otwarte, bez „czy organizujecie wkrótce" (właściciel tego nie chce)
      if (!/\?\s*$/.test(text)) {
        for (const fb of ["Widzisz u siebie miejsce na coś takiego w najbliższym czasie?", "Widzisz u siebie miejsce na coś takiego?"]) {
          if (text.length + 1 + fb.length <= LI_INVITE_MAX) { text = `${text.trim()} ${fb}`; break; }
        }
      }
    }
    if (text.length > LI_INVITE_MAX) {
      // model 9B nie liczy znaków — zamiast ucinać (ginęło pytanie na końcu) prosimy o skrót
      const shorter = await ask(
        projectId,
        "draft",
        L.top + `Skracasz notatkę do zaproszenia LinkedIn do maksymalnie ${LI_INVITE_MAX - 20} znaków. Zostaw powitanie, zdanie „${intro}” bez zmian i pytanie na końcu; skróć albo usuń środek. Bez podpisu, bez cudzysłowów. Zwracasz tylko skrócony tekst.` + L.tail,
        text,
        220,
        0.2,
      );
      if (shorter && shorter.length <= LI_INVITE_MAX) {
        let t = shorter.replace(/^["„]+|["”]+$/g, "").trim();
        // skrót gubi pytanie na końcu — wracamy do pytania z pełnej wersji, jeśli się zmieści
        if (!/\?\s*$/.test(t)) {
          const q = (text.match(/[^.!?]*\?/g) ?? []).pop()?.trim() ?? "";
          if (q && t.length + 1 + q.length <= LI_INVITE_MAX) t = `${t} ${q}`;
          else if (t.length + 32 <= LI_INVITE_MAX) t = `${t} Porozmawiamy 15 minut w tym tygodniu?`;
        }
        text = t;
      }
    }
    // notatka ma kończyć się pytaniem — model 9B co drugi raz kończy stwierdzeniem
    if (!/\?\s*$/.test(text) && text.length + 38 <= LI_INVITE_MAX) text = `${text.trim()} Porozmawiamy 15 minut w tym tygodniu?`;
    if (text.length > LI_INVITE_MAX) {
      const cut = text.slice(0, LI_INVITE_MAX);
      const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("? "), cut.lastIndexOf("! "), cut.lastIndexOf(".\n"));
      text = end > 80 ? cut.slice(0, end + 1) : cut.replace(/\s+\S*$/, "");
    }
  }
  return {
    text: text.slice(0, maxChars + 160),
    subject: channel === "email" ? subject || String(cfg.email.subject || "") || defaultSubject(lead) : "",
    channel,
  };
}

// Odpowiedź w toczącej się rozmowie — z LinkedIna (webhook) i z testowego czatu.
async function replyMessage(projectId: string, cfg: Cfg, lead: Record<string, unknown>, convo: string) {
  const channel = channelOf(lead);
  const who = await senderIdentity(projectId, cfg, channel);
  const kb = await knowledge(projectId, 4500);
  const L = await lessons(projectId);
  const reply = await ask(
    projectId,
    "reply",
    L.top + `Jesteś ${who.name || "przedstawicielem"} z firmy ${who.company || "(firma z bazy wiedzy)"}. ` +
      `Prowadzisz rozmowę sprzedażową po polsku, ${cfg.tone.form === "pan" ? "Pan/Pani" : "na Ty"}. ` +
      "Odpowiadasz krótko (2-4 zdania), konkretnie, bez lania wody, na KAŻDE pytanie rozmówcy z ostatniej wiadomości. Celem jest umówienie krótkiej rozmowy — na końcu proponujesz konkret (np. 15 minut telefonicznie w tym tygodniu). " +
      `Trzymasz formę ${cfg.tone.form === "pan" ? "Pan/Pani" : "na Ty"} konsekwentnie, niezależnie od tego, jak pisze rozmówca. ` +
      "Nie witasz się i nie przedstawiasz ponownie — rozmowa już trwa. Nie komentujesz własnych wcześniejszych wiadomości i nie pytasz o nie. Liczby (osoby, dni, ceny) podajesz tylko takie, jakie są w bazie wiedzy; bez nich mówisz, że ustalicie to w rozmowie. " +
      "Jeśli rozmówca odmawia — dziękujesz i kończysz. Jeśli pyta o cenę, której nie ma w bazie wiedzy — mówisz, że wycena zależy od liczby osób i zakresu, i proponujesz rozmowę. " +
      "Źródłem prawdy jest wyłącznie blok CO SPRZEDAJEMY: jeśli wcześniej w rozmowie padło coś, czego tam już nie ma (oferta mogła się zmienić), mówisz wprost, że oferta została zaktualizowana, i podajesz stan aktualny. " +
      "Bez markdown i emoji. JĘZYK: wyłącznie naturalna polszczyzna, jak w rozmowie między ludźmi; bez angielskich wtrąceń (nie „team building”, „event”, „feedback”, tylko „integracja zespołu”, „wydarzenie”, „opinia”; nazwy własne i nazwy produktów zostają); bez myślników i pauz (— –), zamiast nich przecinek albo kropka; bez kalek z korpomowy. Zwracasz wyłącznie treść odpowiedzi." + L.tail + `\n\nCO SPRZEDAJEMY:\n${kb}`,
    `ROZMOWA (MY = ${who.name || "my"}, ON = rozmówca):\n${convo}`,
    360,
  );
  if (!reply) return reply;
  const checked = isWeakModel(await currentModel()) ? await enforceLessons(projectId, L, reply, "reply") : reply;
  // w trwającej rozmowie nie ma powitania — model (i redaktor ze wskazówką „tylko Cześć") i tak je dopisywał
  const noHello = noDashes(checked).replace(/^\s*(cześć|hej|dzień dobry|witaj|witam)(\s+[^,\n!.]{0,30})?[,!.]?\s*/i, "").trim();
  return noHello.charAt(0).toUpperCase() + noHello.slice(1);
}

// ── limity dzienne i okno pracy ─────────────────────────────────────────────
function inWorkHours(cfg: Cfg, now = new Date()) {
  // czas polski; edge chodzi w UTC, więc przesuwamy ręcznie (CET/CEST ±1/2 h)
  const warsaw = new Date(now.getTime() + (isDst(now) ? 2 : 1) * 3600_000);
  const day = warsaw.getUTCDay() === 0 ? 7 : warsaw.getUTCDay();
  const hour = warsaw.getUTCHours();
  const [from, to] = cfg.limits.hours;
  return cfg.limits.days.includes(day) && hour >= from && hour < to;
}
// ostatnia niedziela marca → ostatnia niedziela października
function isDst(d: Date) {
  const y = d.getUTCFullYear();
  const last = (m: number) => {
    const x = new Date(Date.UTC(y, m + 1, 0));
    x.setUTCDate(x.getUTCDate() - ((x.getUTCDay() + 7) % 7));
    return x;
  };
  return d >= last(2) && d < last(9);
}

async function sentToday(projectId: string, channel?: string) {
  const since = new Date(Date.now() - 24 * 3600_000).toISOString();
  let q = db.from("hand_messages").select("id", { count: "exact", head: true })
    .eq("project_id", projectId).eq("direction", "out").gte("created_at", since);
  if (channel) q = q.eq("channel", channel);
  const { count } = await q;
  return count ?? 0;
}

// ── wysyłka ─────────────────────────────────────────────────────────────────
// Ślad wysyłki przez Unipile — brain-hook po nim odróżnia wiadomość Łowcy (wraca webhookiem jako „własna")
// od człowieka piszącego z tego samego konta LinkedIn; ten drugi wycisza agenta w tym czacie na 48 h.
async function logUniSent(projectId: string, chatId: string, messageId: string, text: string) {
  const t = String(text ?? "").replace(/\s+/g, " ").trim().slice(0, 240);
  await db.from("brain_events").insert({ project_id: projectId, type: "uni_sent", data: { chat_id: chatId, message_id: messageId, t, by: "hand" } });
}

async function sendLinkedIn(cfg: Cfg, lead: Record<string, unknown>, text: string) {
  const accountId = String(cfg.unipile_account_id || "");
  if (!accountId) throw new Error("brak konta LinkedIn w konfiguracji projektu");
  const urn = String(lead.li_urn ?? "");
  if (!urn) throw new Error("lead nie ma identyfikatora LinkedIn");
  // Najpierw zaproszenie (bez połączenia nie da się napisać), potem wiadomość.
  // Jeśli zaproszenie już istnieje, Unipile zwraca błąd — traktujemy jak sukces.
  try {
    await uniFetch("/users/invite", {
      method: "POST",
      body: JSON.stringify({ account_id: accountId, provider_id: urn, message: text.slice(0, 280) }),
    });
    // notatka z zaproszenia pojawia się w czacie dopiero po jego przyjęciu (bywa, że po dniach) — ślad bez chat_id
    await logUniSent(String(lead.project_id ?? ""), "", "", text.slice(0, 280));
    return { channel: "linkedin", provider_msg_id: "", status: "invited" as const };
  } catch (e) {
    const msg = String(e);
    if (!/already|exist|duplicate|connected/i.test(msg)) throw e;
  }
  const res = await uniFetch("/chats", {
    method: "POST",
    body: JSON.stringify({ account_id: accountId, attendees_ids: [urn], text }),
  });
  await logUniSent(String(lead.project_id ?? ""), String(res?.chat_id ?? ""), String(res?.message_id ?? ""), text);
  return { channel: "linkedin", provider_msg_id: String(res?.message_id ?? res?.id ?? ""), status: "sent" as const };
}

// Wspólny kanał e-mail PROJEKTU (`fiq_project_integrations`, kind='email') — ten sam,
// który ustawia się w dowolnym produkcie. Stary układ (konfiguracja w sprzedawcy Brain)
// zostaje jako fallback dla projektów sprzed migracji.
async function projectEmail(projectId: string) {
  const { data } = await db
    .from("fiq_project_integrations").select("config").eq("project_id", projectId).eq("kind", "email").maybeSingle();
  const shared = (data?.config ?? {}) as Record<string, string>;
  if (shared.resend_key) return shared;
  const { data: sales } = await db.from("brain_sales").select("config").eq("project_id", projectId).maybeSingle();
  const legacy = ((sales?.config ?? {}) as Record<string, Record<string, string>>)?.email ?? {};
  return legacy as Record<string, string>;
}

async function sendEmail(projectId: string, cfg: Cfg, lead: Record<string, unknown>, text: string, subject = "") {
  const mail = await projectEmail(projectId);
  const key = String(mail.resend_key ?? "");
  const sender = mail.from_name && mail.from_email ? `${mail.from_name} <${mail.from_email}>` : String(mail.from_email ?? mail.from ?? "");
  const from = String(cfg.email.from || sender || "");
  if (!key || !from) throw new Error("kanał e-mail nieskonfigurowany — uzupełnij klucz Resend i adres nadawcy w Integracjach");
  const to = String(lead.email ?? "").trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(to)) throw new Error("lead nie ma poprawnego adresu e-mail");
  // podpis ze wspólnego kanału projektu (stopka) — pod treścią, jeśli agent sam się nie podpisał tak samo
  const footer = String(mail.signature ?? "").trim();
  const body = footer && !text.includes(footer) ? `${text}\n\n${footer}` : text;
  // odpowiedź klienta ma trafić do człowieka — reply_to z ustawień, pusty = nadawca
  const replyTo = String(mail.reply_to ?? "").trim();
  const payload: Record<string, unknown> = {
    from,
    to,
    subject: (subject || cfg.email.subject || defaultSubject(lead)).trim(),
    text: body,
  };
  if (replyTo) payload.reply_to = replyTo;
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(20_000),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Resend ${r.status}: ${JSON.stringify(data).slice(0, 160)}`);
  return { channel: "email", provider_msg_id: String(data?.id ?? ""), status: "sent" as const };
}

async function deliver(projectId: string, cfg: Cfg, lead: Record<string, unknown>, text: string, subject = "") {
  if (lead.li_urn) return await sendLinkedIn(cfg, lead, text);
  if (lead.email && cfg.email.enabled) return await sendEmail(projectId, cfg, lead, text, subject);
  if (lead.email) throw new Error("lead ma tylko e-mail, a wysyłka maili jest wyłączona (Integracje → E-mail)");
  throw new Error("lead nie ma kanału kontaktu (brak LinkedIna i maila)");
}

// Lead, do którego nie ma jak napisać, nie może stać w kolejce „do wysyłki" —
// tick próbowałby trzy razy i oznaczał go jako błąd. Ląduje w „Do akceptacji".
const reachable = (c: { li_urn?: string; email?: string }, cfg: Cfg) => !!(c.li_urn || (c.email && cfg.email.enabled));

// ── uruchomienie wyszukiwania ───────────────────────────────────────────────
// Kilka zapytań w jednym polu („właściciel, prezes, HR manager") — LinkedIn szuka wszystkich
// słów naraz, więc jedna fraza z ośmiu tytułów dawała 3 osoby. Każdy kawałek idzie osobno,
// wyniki się sumują i deduplikują.
function splitQueries(q: string | string[]): string[] {
  const raw = Array.isArray(q) ? q : String(q ?? "").split(/[\n;|,]/);
  const out: string[] = [];
  for (const x of raw) {
    const t = String(x).trim();
    if (t && !out.includes(t)) out.push(t);
  }
  return out.slice(0, 12);
}

type SearchResult = { ok: boolean; found: number; added: number; skipped: number; sent?: number; error?: string };

// Rdzeń wyszukiwania: ręczne „Szukaj" i kampanie idą tą samą drogą, różni się tylko źródło wywołania.
async function doSearch(projectId: string, source: string, queries: string[], limit: number, campaignId: string | null = null): Promise<SearchResult> {
  const cfg = await loadCfg(projectId);
  const { data: run } = await db
    .from("hand_runs").insert({ project_id: projectId, source, query: queries.join(", "), status: "running", campaign_id: campaignId }).select("id").single();
  const runId = run!.id as string;
  const fail = async (msg: string): Promise<SearchResult> => {
    await db.from("hand_runs").update({ status: "error", error: msg.slice(0, 400), finished_at: new Date().toISOString() }).eq("id", runId);
    return { ok: false, found: 0, added: 0, skipped: 0, error: msg };
  };
  try {
    if (!["linkedin", "maps", "web"].includes(source)) return await fail("nieznane źródło");
    if (!queries.length) return await fail("Wpisz, czego szukamy");
    // limit dzieli się między zapytania (min 5 na zapytanie), całość obcinamy do limitu na końcu
    const per = Math.max(5, Math.ceil(limit / queries.length));
    const deadline = Date.now() + 70_000;
    const seenKey = new Set<string>();
    let cands: Cand[] = [];
    for (const q of queries) {
      if (Date.now() > deadline) break;
      let part: Cand[] = [];
      try {
        if (source === "linkedin") part = await searchLinkedIn(cfg, q, per);
        else if (source === "maps") part = await searchMaps(q, per);
        else part = await searchWeb(q, per);
      } catch (e) {
        // jedno zapytanie padło (np. Yahoo 500) — reszta niech idzie; błąd tylko gdy wszystkie padną
        if (queries.length === 1) throw e;
        console.error("search part failed:", q, String(e).slice(0, 160));
        continue;
      }
      for (const c of part) {
        const k = c.li_urn ? "u:" + c.li_urn : c.website ? "w:" + c.website : "c:" + (c.company ?? "").toLowerCase();
        if (seenKey.has(k)) continue;
        seenKey.add(k);
        cands.push(c);
      }
    }
    cands = cands.slice(0, limit);

    // odsiewamy to, co już mamy — po LinkedIn URN, stronie albo nazwie firmy
    const { data: existing } = await db
      .from("hand_leads").select("li_urn, website, company").eq("project_id", projectId).limit(3000);
    const known = new Set<string>();
    for (const e of existing ?? []) {
      if (e.li_urn) known.add("u:" + e.li_urn);
      if (e.website) known.add("w:" + String(e.website).replace(/^https?:\/\/(www\.)?/, "").replace(/\/+$/, ""));
      if (e.company) known.add("c:" + String(e.company).toLowerCase());
    }
    const fresh = cands.filter((c) => {
      const keys = [
        c.li_urn ? "u:" + c.li_urn : "",
        c.website ? "w:" + c.website.replace(/^https?:\/\/(www\.)?/, "").replace(/\/+$/, "") : "",
        c.company ? "c:" + c.company.toLowerCase() : "",
      ].filter(Boolean);
      return !keys.some((k) => known.has(k));
    });

    // zanim ocenimy — dociągamy mail i telefon ze stron, żeby lead dało się zaczepić
    if (source !== "linkedin") await enrichAll(fresh, Date.now() + 45_000);

    const kb = await knowledge(projectId);
    const byIdx = await qualifyAll(projectId, cfg, kb, fresh);

    const rows = fresh.map((c, i) => {
      const s = byIdx.get(i);
      // brak oceny = do akceptacji z jawnym powodem, nigdy „50 bez słowa"
      const score = s ? Math.max(0, Math.min(100, Number(s.score ?? 0))) : 0;
      return {
        project_id: projectId,
        source: c.source,
        // próg decyduje: powyżej — do wysyłki, poniżej — do ręcznej akceptacji;
        // bez kanału kontaktu zawsze do akceptacji (ktoś musi dopisać mail)
        status: s && score >= cfg.score_threshold && reachable(c, cfg) ? "ready" : "review",
        full_name: c.full_name ?? "",
        headline: c.headline ?? "",
        company: c.company ?? "",
        title: c.title ?? "",
        location: c.location ?? "",
        industry: s?.industry ?? "",
        li_urn: c.li_urn ?? "",
        li_url: c.li_url ?? "",
        website: c.website ?? "",
        email: c.email ?? "",
        phone: c.phone ?? "",
        score,
        why: s?.why || NO_SCORE_WHY,
        meta: { ...(c.meta ?? {}), ...(campaignId ? { campaign_id: campaignId } : {}), ...(s ? {} : { unscored: true }) },
      };
    });
    let added = 0;
    if (rows.length) {
      // błąd zapisu MUSI być widoczny — cicho odrzucona partia wygląda jak
      // „wyszukiwarka nic nie znalazła" i szuka się jej godzinami
      const { data: ins, error } = await db.from("hand_leads").insert(rows).select("id");
      if (error) throw new Error(`Zapis leadów odrzucony przez bazę: ${error.message}`);
      added = ins?.length ?? 0;
    }
    await db.from("hand_runs")
      .update({ status: "done", found: cands.length, added, finished_at: new Date().toISOString() }).eq("id", runId);
    // autopilot: nie czekamy na cron — piszemy od razu do tego, co właśnie znaleźliśmy (w godzinach pracy i w limitach)
    let sent = 0;
    if (added && cfg.autopilot && inWorkHours(cfg)) {
      const r = await sendBatch(projectId, cfg, 10, Date.now() + 60_000);
      sent = r.sent;
    }
    return { ok: true, found: cands.length, added, skipped: cands.length - fresh.length, sent };
  } catch (e) {
    return await fail(String((e as Error).message ?? e));
  }
}

async function runSearch(projectId: string, source: string, query: string | string[], limit: number) {
  const r = await doSearch(projectId, source, splitQueries(query), limit);
  return r.ok ? J(r) : J({ error: r.error }, 400);
}

// ── kampanie: to samo wyszukiwanie codziennie o stałej porze ────────────────
type Campaign = { id: string; project_id: string; name: string; source: string; queries: string[]; per_run: number; hour: number; days: number[]; status: string; next_run_at: string | null; runs_count: number; found_total: number; added_total: number };

// następny termin: najbliższy dzień z listy o zadanej godzinie czasu polskiego, ale nie wcześniej niż za chwilę
function nextRunAt(hour: number, days: number[], from = new Date()): string {
  const offs = isDst(from) ? 2 : 1;
  for (let d = 0; d <= 8; d++) {
    const local = new Date(from.getTime() + offs * 3600_000 + d * 864e5);
    const day = local.getUTCDay() === 0 ? 7 : local.getUTCDay();
    if (!days.includes(day)) continue;
    const at = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), hour, 0, 0) - offs * 3600_000;
    if (at > from.getTime() + 60_000) return new Date(at).toISOString();
  }
  return new Date(from.getTime() + 864e5).toISOString();
}

async function runCampaign(c: Campaign): Promise<SearchResult> {
  const r = await doSearch(c.project_id, c.source, splitQueries(c.queries), Math.min(Math.max(c.per_run || 20, 5), 40), c.id);
  await db.from("hand_campaigns").update({
    last_run_at: new Date().toISOString(),
    next_run_at: nextRunAt(c.hour, c.days),
    runs_count: (c.runs_count ?? 0) + 1,
    found_total: (c.found_total ?? 0) + r.found,
    added_total: (c.added_total ?? 0) + r.added,
    last_error: r.ok ? null : String(r.error ?? "").slice(0, 300),
    updated_at: new Date().toISOString(),
  }).eq("id", c.id);
  return r;
}

// cron co 5 min: jedna zaległa kampania na wywołanie (wyszukiwanie + kwalifikacja ≈ 30–70 s,
// izolat żyje 150 s) — kolejne kampanie tego samego dnia idą w kolejnych przebiegach
async function campaignsRun() {
  const { data } = await db
    .from("hand_campaigns").select("*").eq("status", "active").lte("next_run_at", new Date().toISOString())
    .order("next_run_at").limit(1);
  const c = (data ?? [])[0] as Campaign | undefined;
  if (!c) return J({ ok: true, ran: 0 });
  // rezerwacja: przesuwamy termin ZANIM ruszy wyszukiwanie — dwa równoległe przebiegi nie zrobią tego samego
  await db.from("hand_campaigns").update({ next_run_at: nextRunAt(c.hour, c.days) }).eq("id", c.id).eq("next_run_at", c.next_run_at);
  const r = await runCampaign(c);
  return J({ ran: 1, campaign: c.id, ...r });
}

// ── tick: wysyłka w limitach (cron co minutę) ───────────────────────────────
// Wysyłka partii do leadów „gotowych" (status ready = decyzja: próg albo ręczna akceptacja).
// Wspólna dla crona (autopilot), przycisku „Wyślij do nowych" i wysyłki zaraz po wyszukiwaniu.
// ⚠️ Bez filtra po score: lead zaakceptowany ręcznie spod progu też ma status ready i MA wyjść —
// stary tick filtrował `score >= próg`, więc ręczna akceptacja nic nie dawała.
async function sendBatch(pid: string, cfg: Cfg, max: number, deadline: number): Promise<{ sent: number; failed: number; left: number }> {
  const outToday = await sentToday(pid);
  const room = Math.max(0, cfg.limits.messages_per_day - outToday);
  const take = Math.min(room, max);
  const { count: readyCount } = await db.from("hand_leads").select("id", { count: "exact", head: true }).eq("project_id", pid).eq("status", "ready");
  if (take <= 0) return { sent: 0, failed: 0, left: readyCount ?? 0 };
  const { data: leads } = await db
    .from("hand_leads").select("*").eq("project_id", pid).eq("status", "ready")
    .or(`next_at.is.null,next_at.lte.${new Date().toISOString()}`)
    .order("score", { ascending: false }).limit(take);
  if (!leads?.length) return { sent: 0, failed: 0, left: readyCount ?? 0 };
  const kb = await knowledge(pid);
  let sent = 0, failed = 0;
  for (const lead of leads) {
    if (Date.now() > deadline) break;
    try {
      const draft = await draftMessage(pid, cfg, kb, lead);
      if (!draft?.text) throw new Error("model nie zwrócił treści");
      const res = await deliver(pid, cfg, lead, draft.text, draft.subject);
      await db.from("hand_messages").insert({
        lead_id: lead.id,
        project_id: pid,
        channel: res.channel,
        direction: "out",
        content: draft.subject && res.channel === "email" ? `Temat: ${draft.subject}\n\n${draft.text}` : draft.text,
        status: res.status,
        provider_msg_id: res.provider_msg_id || null,
      });
      await db.from("hand_leads").update({
        status: "contacted",
        last_out_at: new Date().toISOString(),
        attempts: (lead.attempts ?? 0) + 1,
        updated_at: new Date().toISOString(),
      }).eq("id", lead.id);
      sent++;
    } catch (e) {
      failed++;
      // nie blokujemy kolejki jednym leadem — odkładamy go i lecimy dalej
      await db.from("hand_leads").update({
        status: (lead.attempts ?? 0) >= 2 ? "failed" : "ready",
        attempts: (lead.attempts ?? 0) + 1,
        why: String((e as Error).message ?? e).slice(0, 300),
        next_at: new Date(Date.now() + 3600_000).toISOString(),
        updated_at: new Date().toISOString(),
      }).eq("id", lead.id);
    }
  }
  const { count: after } = await db.from("hand_leads").select("id", { count: "exact", head: true }).eq("project_id", pid).eq("status", "ready");
  return { sent, failed, left: after ?? 0 };
}

async function tick() {
  const { data: cfgs } = await db.from("hand_config").select("project_id, config").limit(200);
  const report: Record<string, unknown>[] = [];
  const deadline = Date.now() + 100_000; // zostawiamy zapas do 150 s izolatu
  for (const row of cfgs ?? []) {
    if (Date.now() > deadline) break;
    const pid = row.project_id as string;
    const cfg = await withLinkedIn(pid, mergeCfg(row.config));
    if (!cfg.autopilot || !inWorkHours(cfg)) continue;
    const r = await sendBatch(pid, cfg, 4, deadline); // max 4 na tick — rozkłada wysyłkę w czasie
    if (r.sent || r.failed) report.push({ project_id: pid, ...r });
  }
  return J({ ok: true, projects: report });
}

// ── odpowiedź przychodząca ──────────────────────────────────────────────────
// Autopilot rządzi tylko wysyłką zimnych wiadomości. Na odpowiedź odpisujemy
// ZAWSZE — tak samo jak sprzedawca w Brain przy wyłączonym autopilocie.
async function handleInbound(payload: Record<string, unknown>) {
  const urn = String(
    (payload?.sender as Record<string, unknown> | undefined)?.attendee_provider_id ??
      payload?.provider_id ?? payload?.attendee_provider_id ?? "",
  );
  const text = String(payload?.message ?? payload?.text ?? "");
  if (!urn || !text) return J({ ok: true, skipped: "brak nadawcy albo treści" });
  const { data: lead } = await db
    .from("hand_leads").select("*").eq("li_urn", urn).order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (!lead) return J({ ok: true, skipped: "nieznany lead" });
  await db.from("hand_messages").insert({
    lead_id: lead.id,
    project_id: lead.project_id,
    channel: "linkedin",
    direction: "in",
    content: text,
    status: "received",
    provider_msg_id: String(payload?.message_id ?? "") || null,
  });
  await db.from("hand_leads").update({
    status: "replied",
    unread: true,
    last_in_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }).eq("id", lead.id);

  // człowiek przejął tę rozmowę z konta LinkedIn (brain-hook wyciszył agenta na 48 h) — zapisujemy, nie odpowiadamy
  if (payload?.muted === true) return J({ ok: true, replied: false, reason: "human_takeover" });

  const cfg = await loadCfg(lead.project_id);
  const { data: history } = await db
    .from("hand_messages").select("direction, content").eq("lead_id", lead.id).order("id").limit(20);
  const convo = (history ?? []).map((m) => `${m.direction === "out" ? "MY" : "ON"}: ${m.content}`).join("\n").slice(0, 4000);
  const reply = await replyMessage(lead.project_id, cfg, lead, convo);
  if (!reply) return J({ ok: true, replied: false });
  try {
    const res = await sendLinkedIn(cfg, lead, reply);
    await db.from("hand_messages").insert({
      lead_id: lead.id,
      project_id: lead.project_id,
      channel: "linkedin",
      direction: "out",
      content: reply,
      status: res.status,
      provider_msg_id: res.provider_msg_id || null,
    });
    await db.from("hand_leads").update({ last_out_at: new Date().toISOString() }).eq("id", lead.id);
  } catch (e) {
    console.error("hand inbound reply:", String(e).slice(0, 200));
    return J({ ok: true, replied: false, error: String((e as Error).message ?? e) });
  }
  return J({ ok: true, replied: true });
}


// ── HTTP ────────────────────────────────────────────────────────────────────
serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const action = String(body.action ?? "");

  // Cron i webhook wchodzą przed bramką logowania — inaczej dostają „wymagane logowanie".
  const cronKey = req.headers.get("x-hand-key") ?? "";
  const isCron = !!cronKey && cronKey === (Deno.env.get("HAND_CRON_KEY") ?? "___");
  if (isCron && action === "tick") return await tick();
  if (isCron && action === "campaigns.run") return await campaignsRun();
  if (isCron && action === "webhook") return await handleInbound((body.payload ?? body) as Record<string, unknown>);

  const user = await authUser(String(body.token ?? ""));
  if (!user) return J({ error: "Wymagane logowanie" }, 401);
  const admin = user.role === "admin";

  try {
    switch (action) {
      case "config.get": {
        const pid = String(body.project_id ?? "");
        await assertProject(user, pid);
        const { data } = await db.from("hand_config").select("config").eq("project_id", pid).maybeSingle();
        const cfg = await withLinkedIn(pid, mergeCfg(data?.config));
        // id konta LinkedIn to ustawienie administracyjne — klient go nie widzi
        if (!admin) cfg.unipile_account_id = cfg.unipile_account_id ? "(ustawione)" : "";
        return J({ config: cfg, integrations: await integrationsStatus() });
      }
      case "config.set": {
        const pid = String(body.project_id ?? "");
        await assertProject(user, pid);
        const incoming = mergeCfg(body.config);
        if (!admin) {
          // wybór konta LinkedIn zostaje po stronie admina
          const { data } = await db.from("hand_config").select("config").eq("project_id", pid).maybeSingle();
          incoming.unipile_account_id = String(mergeCfg(data?.config).unipile_account_id ?? "");
        }
        await db.from("hand_config")
          .upsert({ project_id: pid, config: incoming, updated_at: new Date().toISOString() });
        return J({ ok: true, config: incoming });
      }
      case "run.start": {
        const pid = String(body.project_id ?? "");
        await assertProject(user, pid);
        const source = String(body.source ?? "web");
        const query = String(body.query ?? "").trim();
        if (!query) return J({ error: "Wpisz, czego szukamy" }, 400);
        return await runSearch(pid, source, query, Math.min(Number(body.limit) || 20, 40));
      }
      // ── kampanie ──────────────────────────────────────────────────────
      case "campaign.list": {
        const pid = String(body.project_id ?? "");
        await assertProject(user, pid);
        const { data } = await db.from("hand_campaigns").select("*").eq("project_id", pid).order("created_at", { ascending: false });
        return J({ campaigns: data ?? [] });
      }
      case "campaign.create": {
        const pid = String(body.project_id ?? "");
        await assertProject(user, pid);
        const queries = splitQueries((body.queries as string[] | string) ?? "");
        if (!queries.length) return J({ error: "Wpisz przynajmniej jedno zapytanie" }, 400);
        const source = ["linkedin", "maps", "web"].includes(String(body.source)) ? String(body.source) : "linkedin";
        const hour = Math.min(23, Math.max(0, Number(body.hour) || 9));
        const days = (Array.isArray(body.days) ? body.days : [1, 2, 3, 4, 5]).map(Number).filter((d) => d >= 1 && d <= 7);
        const row = {
          project_id: pid,
          name: String(body.name ?? "").trim().slice(0, 120),
          source,
          queries,
          per_run: Math.min(40, Math.max(5, Number(body.per_run) || 20)),
          hour,
          days: days.length ? days : [1, 2, 3, 4, 5],
          status: "active",
          next_run_at: nextRunAt(hour, days.length ? days : [1, 2, 3, 4, 5]),
        };
        const { data, error } = await db.from("hand_campaigns").insert(row).select("*").single();
        if (error) return J({ error: error.message }, 400);
        return J({ campaign: data });
      }
      case "campaign.set": {
        const id = String(body.id ?? "");
        const { data: c } = await db.from("hand_campaigns").select("*").eq("id", id).maybeSingle();
        if (!c) return J({ error: "nie znaleziono" }, 404);
        await assertProject(user, c.project_id);
        const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
        if (body.status !== undefined) {
          const st = String(body.status);
          if (!["active", "paused", "stopped"].includes(st)) return J({ error: "zły status" }, 400);
          patch.status = st;
          // wznowienie: liczymy termin od nowa, żeby zaległe dni nie ruszyły wszystkie naraz
          if (st === "active") patch.next_run_at = nextRunAt(c.hour, c.days);
        }
        await db.from("hand_campaigns").update(patch).eq("id", id);
        return J({ ok: true });
      }
      case "campaign.delete": {
        const id = String(body.id ?? "");
        const { data: c } = await db.from("hand_campaigns").select("project_id").eq("id", id).maybeSingle();
        if (!c) return J({ error: "nie znaleziono" }, 404);
        await assertProject(user, c.project_id);
        await db.from("hand_campaigns").delete().eq("id", id);
        return J({ ok: true });
      }
      // „Szukaj teraz" — ten sam przebieg co z crona, na żądanie
      case "campaign.run": {
        const id = String(body.id ?? "");
        const { data: c } = await db.from("hand_campaigns").select("*").eq("id", id).maybeSingle();
        if (!c) return J({ error: "nie znaleziono" }, 404);
        await assertProject(user, c.project_id);
        const r = await runCampaign(c as Campaign);
        return J(r.ok ? r : { ...r, error: r.error });
      }
      case "runs.list": {
        const pid = String(body.project_id ?? "");
        await assertProject(user, pid);
        const { data } = await db.from("hand_runs").select("*").eq("project_id", pid)
          .order("started_at", { ascending: false }).limit(30);
        return J({ runs: data ?? [] });
      }
      case "leads.list": {
        const pid = String(body.project_id ?? "");
        await assertProject(user, pid);
        let q = db.from("hand_leads").select("*").eq("project_id", pid)
          .order("score", { ascending: false }).order("created_at", { ascending: false })
          .limit(Math.min(Number(body.limit) || 200, 500));
        if (body.status) q = q.eq("status", String(body.status));
        if (body.source) q = q.eq("source", String(body.source));
        const { data } = await q;
        return J({ leads: data ?? [] });
      }
      // „Wyślij do nowych": jedna partia do leadów gotowych (do 10 na klik, w limicie dziennym; godziny pracy
      // nie obowiązują — to świadoma decyzja człowieka). Przycisk pokazuje, ile zostało, i można kliknąć znów.
      // „Oceń ponownie": ta sama kwalifikacja dla leadów, które oceny nie dostały (albo wskazanych id)
      case "leads.requalify": {
        const pid = String(body.project_id ?? "");
        await assertProject(user, pid);
        const cfg = await loadCfg(pid);
        let q = db.from("hand_leads").select("*").eq("project_id", pid).in("status", ["review", "ready"]);
        if (Array.isArray(body.ids) && body.ids.length) q = q.in("id", (body.ids as string[]).slice(0, 80));
        else q = q.or(`why.eq.,why.eq.${NO_SCORE_WHY},meta->>unscored.eq.true`);
        const { data: leads } = await q.limit(80);
        if (!leads?.length) return J({ ok: true, scored: 0 });
        const cands: Cand[] = leads.map((l) => ({
          source: l.source, full_name: l.full_name, headline: l.headline, company: l.company, title: l.title,
          location: l.location, li_urn: l.li_urn, website: l.website, email: l.email, meta: l.meta ?? {},
        }));
        const byIdx = await qualifyAll(pid, cfg, await knowledge(pid), cands);
        let scored = 0;
        for (let i = 0; i < leads.length; i++) {
          const sc = byIdx.get(i);
          if (!sc) continue;
          const score = Math.max(0, Math.min(100, Number(sc.score ?? 0)));
          await db.from("hand_leads").update({
            score,
            industry: sc.industry ?? leads[i].industry,
            why: sc.why || "",
            status: leads[i].status === "ready" ? "ready" : score >= cfg.score_threshold && reachable(cands[i], cfg) ? "ready" : "review",
            meta: { ...(leads[i].meta ?? {}), unscored: false },
            updated_at: new Date().toISOString(),
          }).eq("id", leads[i].id);
          scored++;
        }
        return J({ ok: true, scored, total: leads.length });
      }
      case "leads.sendNew": {
        const pid = String(body.project_id ?? "");
        await assertProject(user, pid);
        const cfg = await loadCfg(pid);
        const r = await sendBatch(pid, cfg, Math.min(Number(body.max) || 10, 10), Date.now() + 110_000);
        return J({ ok: true, ...r, limit_left: Math.max(0, cfg.limits.messages_per_day - (await sentToday(pid))) });
      }
      case "lead.act": {
        const id = String(body.id ?? "");
        const { data: lead } = await db.from("hand_leads").select("project_id, status").eq("id", id).maybeSingle();
        if (!lead) return J({ error: "nie znaleziono" }, 404);
        await assertProject(user, lead.project_id);
        const act = String(body.act ?? "");
        const map: Record<string, string> = { approve: "ready", reject: "rejected", archive: "archived", reset: "review" };
        if (!map[act]) return J({ error: "nieznana operacja" }, 400);
        await db.from("hand_leads")
          .update({ status: map[act], attempts: 0, updated_at: new Date().toISOString() }).eq("id", id);
        return J({ ok: true });
      }
      case "lead.messages": {
        const id = String(body.id ?? "");
        const { data: lead } = await db.from("hand_leads").select("*").eq("id", id).maybeSingle();
        if (!lead) return J({ error: "nie znaleziono" }, 404);
        await assertProject(user, lead.project_id);
        const { data } = await db.from("hand_messages").select("*").eq("lead_id", id).order("id");
        if (lead.unread) await db.from("hand_leads").update({ unread: false }).eq("id", id);
        return J({ lead, messages: data ?? [] });
      }
      // Podgląd tekstu, który agent wyśle — bez wysyłki. Do sprawdzenia tonu.
      case "lead.draft": {
        const id = String(body.id ?? "");
        const { data: lead } = await db.from("hand_leads").select("*").eq("id", id).maybeSingle();
        if (!lead) return J({ error: "nie znaleziono" }, 404);
        await assertProject(user, lead.project_id);
        const cfg = await loadCfg(lead.project_id);
        const draft = await draftMessage(lead.project_id, cfg, await knowledge(lead.project_id), lead);
        if (!draft?.text) return J({ error: "Model nie odpowiedział — sprawdź dostawcę AI w panelu admina" }, 502);
        return J({ text: draft.text, subject: draft.subject, channel: draft.channel });
      }
      case "message.send": {
        const id = String(body.lead_id ?? "");
        const { data: lead } = await db.from("hand_leads").select("*").eq("id", id).maybeSingle();
        if (!lead) return J({ error: "nie znaleziono" }, 404);
        await assertProject(user, lead.project_id);
        const cfg = await loadCfg(lead.project_id);
        let text = String(body.content ?? "").trim();
        let subject = String(body.subject ?? "").trim();
        if (!text) {
          const draft = await draftMessage(lead.project_id, cfg, await knowledge(lead.project_id), lead);
          text = draft?.text ?? "";
          subject = subject || draft?.subject || "";
        }
        if (!text) return J({ error: "Brak treści do wysłania" }, 400);
        try {
          const res = await deliver(lead.project_id, cfg, lead, text, subject);
          await db.from("hand_messages").insert({
            lead_id: id,
            project_id: lead.project_id,
            channel: res.channel,
            direction: "out",
            content: subject && res.channel === "email" ? `Temat: ${subject}\n\n${text}` : text,
            status: res.status,
            provider_msg_id: res.provider_msg_id || null,
          });
          await db.from("hand_leads").update({
            status: lead.status === "replied" ? "replied" : "contacted",
            last_out_at: new Date().toISOString(),
            attempts: (lead.attempts ?? 0) + 1,
            updated_at: new Date().toISOString(),
          }).eq("id", id);
          return J({ ok: true, text });
        } catch (e) {
          return J({ error: String((e as Error).message ?? e) }, 400);
        }
      }
      case "stats": {
        const pid = String(body.project_id ?? "");
        await assertProject(user, pid);
        const days = Math.min(Number(body.days) || 30, 180);
        const since = new Date(Date.now() - days * 86400_000).toISOString();
        const [leads, msgs, usage, runs] = await Promise.all([
          db.from("hand_leads").select("status, source, score, created_at, last_in_at").eq("project_id", pid)
            .gte("created_at", since),
          db.from("hand_messages").select("direction, channel, created_at").eq("project_id", pid).gte("created_at", since),
          db.from("fiq_ai_usage").select("cost_usd, action, created_at, model").eq("project_id", pid)
            .eq("product_key", PRODUCT).gte("created_at", since),
          db.from("hand_runs").select("source, found, added, status, started_at").eq("project_id", pid)
            .gte("started_at", since),
        ]);
        return J({
          leads: leads.data ?? [],
          messages: msgs.data ?? [],
          usage: usage.data ?? [],
          runs: runs.data ?? [],
          days,
        });
      }
      // Lista kont Unipile — wybór konta dla projektu ma wyłącznie admin.
      case "unipile.accounts": {
        if (!admin) return J({ error: "forbidden" }, 403);
        const data = await uniFetch("/accounts");
        const items = (data?.items ?? data?.accounts ?? []) as Array<Record<string, unknown>>;
        return J({
          accounts: items.map((a) => ({
            id: String(a.id ?? ""),
            name: String(a.name ?? a.username ?? ""),
            type: String(a.type ?? a.provider ?? ""),
            status: String((a.sources as Array<{ status?: string }> | undefined)?.[0]?.status ?? a.status ?? "ok"),
          })),
        });
      }
      // Wymuszone sprawdzenie integracji — przycisk „Sprawdź teraz" w panelu.
      case "integrations.check": {
        const pid = String(body.project_id ?? "");
        await assertProject(user, pid);
        return J({ integrations: await integrationsStatus(true) });
      }
      // Testowy czat: Ty grasz leada, agent pisze jak do prawdziwego. Nic nie
      // trafia do hand_leads/hand_messages — tylko koszt modelu do fiq_ai_usage.
      // Pierwsza wiadomość idzie tą samą funkcją co w autopilocie (draftMessage),
      // odpowiedzi tą samą co webhook LinkedIna (replyMessage) — test = produkcja.
      case "test.chat": {
        const pid = String(body.project_id ?? "");
        await assertProject(user, pid);
        const cfg = await loadCfg(pid);
        const channel = body.channel === "email" ? "email" : "linkedin";
        const l = (body.lead ?? {}) as Record<string, unknown>;
        const lead: Record<string, unknown> = {
          full_name: String(l.full_name ?? "").slice(0, 120),
          title: String(l.title ?? "").slice(0, 160),
          company: String(l.company ?? "").slice(0, 160),
          industry: String(l.industry ?? "").slice(0, 80),
          location: String(l.location ?? "").slice(0, 120),
          website: String(l.website ?? "").slice(0, 200),
          why: String(l.why ?? "").slice(0, 300),
          // kanał wynika z tego, czy lead „ma LinkedIn" — symulujemy to jednym znacznikiem
          li_urn: channel === "linkedin" ? "test" : "",
          email: channel === "email" ? "test@example.invalid" : "",
        };
        const history = (Array.isArray(body.messages) ? body.messages : [])
          .slice(-16)
          .filter((m: Record<string, unknown>) => (m.role === "user" || m.role === "assistant") && m.content)
          .map((m: Record<string, unknown>) => ({ role: String(m.role), content: String(m.content).slice(0, 2500) }));
        if (!history.length) {
          const draft = await draftMessage(pid, cfg, await knowledge(pid), lead);
          if (!draft?.text) return J({ error: "Model nie odpowiedział — sprawdź dostawcę AI w panelu admina" }, 502);
          return J({ text: draft.text, subject: draft.subject, channel });
        }
        const convo = history.map((m: { role: string; content: string }) => `${m.role === "assistant" ? "MY" : "ON"}: ${m.content}`).join("\n").slice(0, 4000);
        const reply = await replyMessage(pid, cfg, lead, convo);
        if (!reply) return J({ error: "Model nie odpowiedział — sprawdź dostawcę AI w panelu admina" }, 502);
        return J({ text: reply, channel });
      }
      // Ręczne uruchomienie kolejki — do testów i „wyślij teraz".
      case "tick.now": {
        if (!admin) return J({ error: "forbidden" }, 403);
        return await tick();
      }
      default:
        return J({ error: "nieznana akcja" }, 400);
    }
  } catch (e) {
    const msg = String((e as Error).message ?? e);
    console.error("hand-api", action, msg.slice(0, 300));
    return J({ error: msg }, /dostęp|logowanie/i.test(msg) ? 403 : 400);
  }
});
