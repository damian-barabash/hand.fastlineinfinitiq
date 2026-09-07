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
};

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

// Ceny za 1M tokenów — do metryki „wydatki na model". Nieznany model liczymy
// po najbliższej stawce DeepSeeka, żeby wykres nigdy nie był pusty.
const PRICES: Record<string, [number, number]> = {
  "deepseek-chat": [0.27, 1.1],
  "deepseek-reasoner": [0.55, 2.19],
  "gpt-4o-mini": [0.15, 0.6],
  "gpt-4o": [2.5, 10],
};
const priceOf = (model: string) => {
  const k = Object.keys(PRICES).find((p) => model.toLowerCase().includes(p));
  return k ? PRICES[k] : [0.27, 1.1];
};

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
async function ask(projectId: string, action: string, system: string, user: string, maxTokens = 700) {
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
        temperature: ai.temperature ?? 0.5,
        max_tokens: maxTokens,
        messages: [{ role: "system", content: system }, { role: "user", content: user }],
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
  const [inP, outP] = priceOf(model);
  await db.from("fiq_ai_usage").insert({
    product_key: PRODUCT,
    project_id: projectId,
    action,
    model,
    prompt_tokens: pt,
    completion_tokens: ct,
    cost_usd: +((pt / 1e6) * inP + (ct / 1e6) * outP).toFixed(6),
  });
  return text || null;
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
async function knowledge(projectId: string, cap = 6000) {
  const { data: items } = await db
    .from("brain_kb_items").select("type, title, content, url").eq("project_id", projectId).order("sort").limit(40);
  const { data: prods } = await db
    .from("brain_products").select("name, description, price, price_currency").eq("project_id", projectId).order("sort").limit(20);
  const parts: string[] = [];
  for (const it of items ?? []) {
    const body = String(it.content ?? it.url ?? "").slice(0, 800);
    if (body) parts.push(`[${it.type}] ${it.title ?? ""}: ${body}`);
  }
  for (const p of prods ?? []) {
    parts.push(
      `[produkt] ${p.name}: ${String(p.description ?? "").slice(0, 400)}` +
        (p.price ? ` (od ${p.price} ${p.price_currency ?? "PLN"})` : ""),
    );
  }
  return parts.join("\n").slice(0, cap);
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
  if (cfg.icp.location) body.location = [cfg.icp.location];
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
    website: String(p.websiteUri ?? ""),
    headline: String((p.primaryTypeDisplayName as Record<string, unknown> | undefined)?.text ?? ""),
    meta: { rating: p.rating ?? null, reviews: p.userRatingCount ?? null, maps_url: p.googleMapsUri ?? "" },
  }));
}

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
  if (mail && !c.email) c.email = decodeURIComponent(mail).toLowerCase().slice(0, 120);
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
    .map((c, i) =>
      `${i}. ${[c.full_name, c.title, c.company, c.headline, c.location, c.website, c.email ? "mail: " + c.email : ""]
        .filter(Boolean).join(" | ")}`
    )
    .join("\n").slice(0, 8000);
  const system =
    "Jesteś analitykiem sprzedaży B2B. Oceniasz, czy dany podmiot pasuje jako klient firmy opisanej w bazie wiedzy. " +
    "Odpowiadasz WYŁĄCZNIE tablicą JSON, bez komentarza. Piszesz po polsku.";
  const user = `BAZA WIEDZY FIRMY (co sprzedajemy):
${kb || "(brak — oceniaj po profilu idealnego klienta)"}

PROFIL IDEALNEGO KLIENTA:
branża: ${cfg.icp.industry || "(dowolna)"}
stanowiska: ${cfg.icp.titles || "(dowolne)"}
lokalizacja: ${cfg.icp.location || "(dowolna)"}
wielkość firmy: ${cfg.icp.company_size || "(dowolna)"}
słowa kluczowe: ${cfg.icp.keywords || "-"}
wyklucz: ${cfg.icp.exclude || "-"}

KANDYDACI:
${list}

Uwaga: katalogi, porównywarki, rankingi i portale ogłoszeniowe NIE są klientami — daj im score 0.

Dla każdego kandydata zwróć obiekt:
{"i": <numer>, "score": <0-100 dopasowanie>, "industry": "<branża 1-3 słowa>", "why": "<jedno zdanie po polsku: dlaczego pasuje albo dlaczego nie>"}
Zwróć tablicę dla WSZYSTKICH kandydatów, w tej samej kolejności.`;
  const parsed = parseJson<Array<{ i: number; score: number; industry?: string; why?: string }>>(
    await ask(projectId, "qualify", system, user, 1400),
  );
  return parsed ?? [];
}

// ── pierwsza wiadomość ──────────────────────────────────────────────────────
async function draftMessage(projectId: string, cfg: Cfg, kb: string, lead: Record<string, unknown>) {
  if (cfg.tone.template) {
    // sztywny szablon: tylko podstawienie zmiennych, zero improwizacji
    return String(cfg.tone.template)
      .replace(/\{imie\}/gi, String(lead.full_name ?? "").split(" ")[0] || "")
      .replace(/\{nazwisko\}/gi, String(lead.full_name ?? "").split(" ").slice(1).join(" "))
      .replace(/\{firma\}/gi, String(lead.company ?? ""))
      .replace(/\{miasto\}/gi, String(lead.location ?? ""))
      .replace(/\{branza\}/gi, String(lead.industry ?? ""));
  }
  const form = cfg.tone.form === "pan" ? "formę grzecznościową (Pan/Pani)" : "formę bezpośrednią (na Ty)";
  const system =
    `Piszesz pierwszą wiadomość sprzedażową na LinkedIn/e-mail. Po polsku, ${form}. ` +
    `Maksymalnie ${cfg.tone.max_chars} znaków. Bez korpo-lania, bez „mam nadzieję, że mail zastaje Pana dobrze". ` +
    "Zaczynasz od konkretu z profilu odbiorcy, dajesz JEDNĄ korzyść dopasowaną do jego branży, kończysz krótkim pytaniem. " +
    "NIGDY nie wymyślasz imienia ani nazwiska: jeśli w danych odbiorcy nie ma imienia, zwracasz się do firmy " +
    "(np. zaczynasz od Dzień dobry, albo od razu od konkretu) i nie używasz żadnego imienia. " +
    "Nie obiecujesz liczb, których nie ma w bazie wiedzy. " +
    "Zwracasz wyłącznie treść wiadomości, bez tematu i bez cudzysłowów.";
  const user = `CO SPRZEDAJEMY (baza wiedzy):
${kb || "(brak)"}

ODBIORCA:
imię i nazwisko: ${lead.full_name || "NIEZNANE — nie wymyślaj imienia"}
stanowisko: ${lead.title ?? lead.headline ?? "-"}
firma: ${lead.company ?? "-"}
branża: ${lead.industry ?? "-"}
lokalizacja: ${lead.location ?? "-"}
strona: ${lead.website ?? "-"}
dlaczego pasuje: ${lead.why ?? "-"}
${cfg.tone.signature ? `\nPodpisz się: ${cfg.tone.signature}` : ""}`;
  const text = await ask(projectId, "draft", system, user, 400);
  return text ? text.slice(0, cfg.tone.max_chars + 120) : null;
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
    return { channel: "linkedin", provider_msg_id: "", status: "invited" as const };
  } catch (e) {
    const msg = String(e);
    if (!/already|exist|duplicate|connected/i.test(msg)) throw e;
  }
  const res = await uniFetch("/chats", {
    method: "POST",
    body: JSON.stringify({ account_id: accountId, attendees_ids: [urn], text }),
  });
  return { channel: "linkedin", provider_msg_id: String(res?.id ?? ""), status: "sent" as const };
}

// Mail idzie przez Resend skonfigurowany w projekcie (ten sam klucz co sprzedawca Brain).
async function sendEmail(projectId: string, cfg: Cfg, lead: Record<string, unknown>, text: string) {
  const { data: sales } = await db.from("brain_sales").select("config").eq("project_id", projectId).maybeSingle();
  const key = String(((sales?.config ?? {}) as Record<string, Record<string, string>>)?.email?.resend_key ?? "");
  const from = String(cfg.email.from || ((sales?.config ?? {}) as Record<string, Record<string, string>>)?.email?.from || "");
  if (!key || !from) throw new Error("kanał e-mail nieskonfigurowany (klucz Resend i adres nadawcy w Brain → Sprzedawca)");
  const to = String(lead.email ?? "");
  if (!to) throw new Error("lead nie ma adresu e-mail");
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from,
      to,
      subject: cfg.email.subject || `Krótkie pytanie — ${lead.company ?? ""}`.trim(),
      text,
    }),
    signal: AbortSignal.timeout(20_000),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Resend ${r.status}: ${JSON.stringify(data).slice(0, 160)}`);
  return { channel: "email", provider_msg_id: String(data?.id ?? ""), status: "sent" as const };
}

async function deliver(projectId: string, cfg: Cfg, lead: Record<string, unknown>, text: string) {
  if (lead.li_urn) return await sendLinkedIn(cfg, lead, text);
  if (lead.email && cfg.email.enabled) return await sendEmail(projectId, cfg, lead, text);
  throw new Error("lead nie ma kanału kontaktu (brak LinkedIna i maila)");
}

// ── uruchomienie wyszukiwania ───────────────────────────────────────────────
async function runSearch(projectId: string, source: string, query: string, limit: number) {
  const cfg = mergeCfg((await db.from("hand_config").select("config").eq("project_id", projectId).maybeSingle()).data?.config);
  const { data: run } = await db
    .from("hand_runs").insert({ project_id: projectId, source, query, status: "running" }).select("id").single();
  const runId = run!.id as string;
  const fail = async (msg: string) => {
    await db.from("hand_runs").update({ status: "error", error: msg.slice(0, 400), finished_at: new Date().toISOString() })
      .eq("id", runId);
    return J({ error: msg }, 400);
  };
  try {
    let cands: Cand[] = [];
    if (source === "linkedin") cands = await searchLinkedIn(cfg, query, limit);
    else if (source === "maps") cands = await searchMaps(query, limit);
    else if (source === "web") cands = await searchWeb(query, limit);
    else return await fail("nieznane źródło");

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
    const scores = await qualify(projectId, cfg, kb, fresh);
    const byIdx = new Map(scores.map((s) => [Number(s.i), s]));

    const rows = fresh.map((c, i) => {
      const s = byIdx.get(i);
      const score = Math.max(0, Math.min(100, Number(s?.score ?? 50)));
      return {
        project_id: projectId,
        source: c.source,
        // próg decyduje: powyżej — do wysyłki, poniżej — do ręcznej akceptacji
        status: score >= cfg.score_threshold ? "ready" : "review",
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
        why: s?.why ?? "",
        meta: c.meta ?? {},
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
    return J({ ok: true, found: cands.length, added, skipped: cands.length - fresh.length });
  } catch (e) {
    return await fail(String((e as Error).message ?? e));
  }
}

// ── tick: wysyłka w limitach (cron co minutę) ───────────────────────────────
async function tick() {
  const { data: cfgs } = await db.from("hand_config").select("project_id, config").limit(200);
  const report: Record<string, unknown>[] = [];
  const deadline = Date.now() + 100_000; // zostawiamy zapas do 150 s izolatu
  for (const row of cfgs ?? []) {
    if (Date.now() > deadline) break;
    const cfg = mergeCfg(row.config);
    const pid = row.project_id as string;
    if (!cfg.autopilot || !inWorkHours(cfg)) continue;
    const outToday = await sentToday(pid);
    const left = Math.min(cfg.limits.messages_per_day - outToday, 4); // max 4 na tick — rozkłada wysyłkę w czasie
    if (left <= 0) continue;
    const { data: leads } = await db
      .from("hand_leads").select("*").eq("project_id", pid).eq("status", "ready")
      .gte("score", cfg.score_threshold).order("score", { ascending: false }).limit(left);
    if (!leads?.length) continue;
    const kb = await knowledge(pid);
    let sent = 0;
    for (const lead of leads) {
      if (Date.now() > deadline) break;
      try {
        const text = await draftMessage(pid, cfg, kb, lead);
        if (!text) throw new Error("model nie zwrócił treści");
        const res = await deliver(pid, cfg, lead, text);
        await db.from("hand_messages").insert({
          lead_id: lead.id,
          project_id: pid,
          channel: res.channel,
          direction: "out",
          content: text,
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
    if (sent) report.push({ project_id: pid, sent });
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

  const cfg = mergeCfg(
    (await db.from("hand_config").select("config").eq("project_id", lead.project_id).maybeSingle()).data?.config,
  );
  const { data: history } = await db
    .from("hand_messages").select("direction, content").eq("lead_id", lead.id).order("id").limit(20);
  const kb = await knowledge(lead.project_id, 4000);
  const convo = (history ?? []).map((m) => `${m.direction === "out" ? "MY" : "ON"}: ${m.content}`).join("\n").slice(0, 4000);
  const reply = await ask(
    lead.project_id,
    "reply",
    `Prowadzisz rozmowę sprzedażową po polsku, ${cfg.tone.form === "pan" ? "Pan/Pani" : "na Ty"}. ` +
      "Odpowiadasz krótko (2-4 zdania), konkretnie, bez lania wody. Celem jest umówienie krótkiej rozmowy. " +
      "Jeśli rozmówca odmawia — dziękujesz i kończysz. Zwracasz wyłącznie treść odpowiedzi.",
    `CO SPRZEDAJEMY:\n${kb}\n\nROZMOWA:\n${convo}`,
    360,
  );
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


// ── zaproszenie do podłączenia LinkedIn (Hosted Auth Unipile) ───────────────
// Klient nie podaje nam hasła: admin generuje link, klient go otwiera, a dane
// logowania wpisuje już na stronie Unipile (2FA i potwierdzenie w aplikacji
// obsługuje ich kreator). Po udanym podłączeniu Unipile woła nasz `notify_url`
// z `{status, account_id, name}` — `name` to nasz token, po nim wiążemy konto
// z projektem. Sam link Unipile żyje krótko (najdalej do ich dobowego restartu),
// dlatego klientowi dajemy WŁASNY, stały adres `/connect?t=…`, a link Unipile
// wypuszczamy dopiero w chwili kliknięcia.
const PANEL_URL = (Deno.env.get("HAND_PANEL_URL") ?? "https://hand.fastlineinfinitiq.pl").replace(/\/+$/, "");
const LINK_TTL_DAYS = 30;

type ConnectLink = {
  token: string; project_id: string; kind: string; reconnect_account: string | null;
  expires_at: string | null; revoked_at: string | null; connected_at: string | null;
  account_id: string | null; account_name: string | null; opens: number; created_at: string;
};

const newToken = () =>
  [...crypto.getRandomValues(new Uint8Array(24))].map((b) => b.toString(16).padStart(2, "0")).join("");

const connectUrl = (token: string) => `${PANEL_URL}/connect?t=${token}`;

function linkState(l: ConnectLink | null): string {
  if (!l) return "none";
  if (l.connected_at) return "connected";
  if (l.revoked_at) return "revoked";
  if (l.expires_at && new Date(l.expires_at) < new Date()) return "expired";
  return "waiting";
}

async function currentLink(projectId: string): Promise<ConnectLink | null> {
  const { data } = await db.from("hand_connect_links").select("*")
    .eq("project_id", projectId).order("created_at", { ascending: false }).limit(1).maybeSingle();
  return (data ?? null) as ConnectLink | null;
}

/** Nazwa konta w Unipile — pokazujemy ją zamiast samego id, żeby było widać CZYJ to LinkedIn. */
async function accountName(id: string): Promise<string> {
  if (!id) return "";
  try {
    const a = await uniFetch(`/accounts/${encodeURIComponent(id)}`, {}, 12_000);
    return String(a?.name ?? a?.username ?? "");
  } catch {
    return "";
  }
}

/** Świeży link kreatora Unipile — ważny 2 h i jednorazowy. */
async function hostedAuthUrl(link: ConnectLink): Promise<string> {
  const { dsn } = await unipile();
  const key = Deno.env.get("HAND_CRON_KEY") ?? "";
  const notify = `${Deno.env.get("SUPABASE_URL")}/functions/v1/hand-api?hook=unipile&key=${encodeURIComponent(key)}`;
  const payload: Record<string, unknown> = {
    type: link.kind === "reconnect" ? "reconnect" : "create",
    api_url: `https://${dsn}`,
    expiresOn: new Date(Date.now() + 2 * 3600_000).toISOString(),
    name: link.token,
    notify_url: notify,
    success_redirect_url: `${connectUrl(link.token)}&ok=1`,
    failure_redirect_url: `${connectUrl(link.token)}&fail=1`,
    single_use: true,
  };
  if (link.kind === "reconnect") payload.reconnect_account = link.reconnect_account;
  else payload.providers = ["LINKEDIN"];
  const data = await uniFetch("/hosted/accounts/link", { method: "POST", body: JSON.stringify(payload) }, 20_000);
  const url = String(data?.url ?? "");
  if (!url) throw new Error("Unipile nie zwrócił adresu kreatora");
  return url;
}

/** Webhook Unipile: konto podłączone → wpisujemy je projektowi. Bez ręcznego wyboru. */
async function handleUnipileHook(payload: Record<string, unknown>) {
  const status = String(payload.status ?? "").toUpperCase();
  const token = String(payload.name ?? "");
  const accountId = String(payload.account_id ?? "");
  console.log("unipile hook", status, token.slice(0, 8), accountId);
  if (!token || !accountId) return J({ ok: true, ignored: "brak name/account_id" });
  const { data } = await db.from("hand_connect_links").select("*").eq("token", token).maybeSingle();
  const link = (data ?? null) as ConnectLink | null;
  if (!link) return J({ ok: true, ignored: "nieznany token" });
  if (!/SUCCESS|RECONNECT|CREATED/.test(status)) {
    return J({ ok: true, ignored: `status ${status}` });
  }
  const name = await accountName(accountId);
  const { data: row } = await db.from("hand_config").select("config").eq("project_id", link.project_id).maybeSingle();
  const cfg = mergeCfg(row?.config);
  cfg.unipile_account_id = accountId;
  await db.from("hand_config").upsert({ project_id: link.project_id, config: cfg, updated_at: new Date().toISOString() });
  await db.from("hand_connect_links").update({
    connected_at: new Date().toISOString(), account_id: accountId, account_name: name,
    updated_at: new Date().toISOString(),
  }).eq("token", token);
  // konto się pojawiło — stary werdykt „token działa, ale nie ma kont" jest nieaktualny
  await db.from("brain_settings").delete().eq("key", "unipile_status");
  console.log("konto podłączone do projektu", link.project_id, accountId, name);
  return J({ ok: true, connected: true });
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
  if (isCron && action === "webhook") return await handleInbound((body.payload ?? body) as Record<string, unknown>);

  // Unipile nie umie wysłać własnego nagłówka, więc klucz jedzie w query.
  // Sprawdzamy go PRZED bramką logowania — inaczej webhook dostaje „Wymagane logowanie".
  const q = new URL(req.url).searchParams;
  if (q.get("hook") === "unipile") {
    const ok = !!q.get("key") && q.get("key") === (Deno.env.get("HAND_CRON_KEY") ?? "___");
    if (!ok) return J({ error: "forbidden" }, 403);
    return await handleUnipileHook(body);
  }

  // Strona /connect?t=… jest publiczna: klient nie ma konta w panelu.
  if (action === "connect.info" || action === "connect.start") {
    const token = String(body.t ?? "");
    const { data } = await db.from("hand_connect_links").select("*").eq("token", token).maybeSingle();
    const link = (data ?? null) as ConnectLink | null;
    const state = linkState(link);
    if (!link || state === "revoked" || state === "expired") {
      return J({ ok: false, state: link ? state : "none" }, 200);
    }
    const { data: proj } = await db.from("brain_projects").select("name, workspace_id").eq("id", link.project_id).maybeSingle();
    const { data: ws } = proj
      ? await db.from("brain_workspaces").select("name").eq("id", proj.workspace_id).maybeSingle()
      : { data: null };
    const info = {
      ok: true, state, kind: link.kind,
      project: String(proj?.name ?? ""), workspace: String(ws?.name ?? ""),
      account_name: link.account_name ?? "",
    };
    if (action === "connect.info") return J(info);
    if (state === "connected") return J({ ...info, already: true });
    // link jest z definicji do wysłania dalej — jedna zapora na wypadek bota,
    // który by w kółko generował kreatory u Unipile
    if ((link.opens ?? 0) > 50) return J({ ok: false, state: "revoked" });
    try {
      const url = await hostedAuthUrl(link);
      await db.from("hand_connect_links").update({
        opens: (link.opens ?? 0) + 1, last_open_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }).eq("token", token);
      return J({ ...info, url });
    } catch (e) {
      const msg = String((e as Error).message ?? e);
      console.error("hosted auth:", msg.slice(0, 200));
      return J({ ok: false, state, error: msg.slice(0, 200) }, 200);
    }
  }

  const user = await authUser(String(body.token ?? ""));
  if (!user) return J({ error: "Wymagane logowanie" }, 401);
  const admin = user.role === "admin";

  try {
    switch (action) {
      case "config.get": {
        const pid = String(body.project_id ?? "");
        await assertProject(user, pid);
        const { data } = await db.from("hand_config").select("config").eq("project_id", pid).maybeSingle();
        const cfg = mergeCfg(data?.config);
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
        const cfg = mergeCfg(
          (await db.from("hand_config").select("config").eq("project_id", lead.project_id).maybeSingle()).data?.config,
        );
        const text = await draftMessage(lead.project_id, cfg, await knowledge(lead.project_id), lead);
        if (!text) return J({ error: "Model nie odpowiedział — sprawdź dostawcę AI w panelu admina" }, 502);
        return J({ text });
      }
      case "message.send": {
        const id = String(body.lead_id ?? "");
        const { data: lead } = await db.from("hand_leads").select("*").eq("id", id).maybeSingle();
        if (!lead) return J({ error: "nie znaleziono" }, 404);
        await assertProject(user, lead.project_id);
        const cfg = mergeCfg(
          (await db.from("hand_config").select("config").eq("project_id", lead.project_id).maybeSingle()).data?.config,
        );
        const text = String(body.content ?? "").trim() ||
          (await draftMessage(lead.project_id, cfg, await knowledge(lead.project_id), lead)) || "";
        if (!text) return J({ error: "Brak treści do wysłania" }, 400);
        try {
          const res = await deliver(lead.project_id, cfg, lead, text);
          await db.from("hand_messages").insert({
            lead_id: id,
            project_id: lead.project_id,
            channel: res.channel,
            direction: "out",
            content: text,
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
      // Link zapraszający klienta do podłączenia LinkedIn (kreator Unipile).
      case "connect.get": {
        const pid = String(body.project_id ?? "");
        await assertProject(user, pid);
        if (!admin) return J({ error: "forbidden" }, 403);
        const link = await currentLink(pid);
        const { data: row } = await db.from("hand_config").select("config").eq("project_id", pid).maybeSingle();
        const accId = String(mergeCfg(row?.config).unipile_account_id ?? "");
        return J({
          state: linkState(link),
          url: link ? connectUrl(link.token) : "",
          expires_at: link?.expires_at ?? null,
          opens: link?.opens ?? 0,
          connected_at: link?.connected_at ?? null,
          account_id: accId,
          account_name: link?.account_name ?? (accId ? await accountName(accId) : ""),
        });
      }
      case "connect.create": {
        const pid = String(body.project_id ?? "");
        await assertProject(user, pid);
        if (!admin) return J({ error: "forbidden" }, 403);
        const kind = String(body.kind ?? "create") === "reconnect" ? "reconnect" : "create";
        let reconnect: string | null = null;
        if (kind === "reconnect") {
          const { data: row } = await db.from("hand_config").select("config").eq("project_id", pid).maybeSingle();
          reconnect = String(mergeCfg(row?.config).unipile_account_id ?? "") || null;
          if (!reconnect) return J({ error: "Projekt nie ma jeszcze podłączonego konta" }, 400);
        }
        // stary link przestaje działać w chwili wydania nowego
        await db.from("hand_connect_links")
          .update({ revoked_at: new Date().toISOString(), updated_at: new Date().toISOString() })
          .eq("project_id", pid).is("revoked_at", null).is("connected_at", null);
        const token = newToken();
        const { error } = await db.from("hand_connect_links").insert({
          token, project_id: pid, kind, reconnect_account: reconnect, created_by: user.id,
          expires_at: new Date(Date.now() + LINK_TTL_DAYS * 86400_000).toISOString(),
        });
        if (error) return J({ error: `Nie udało się zapisać linku: ${error.message}` }, 500);
        return J({ ok: true, url: connectUrl(token), state: "waiting", kind });
      }
      case "connect.revoke": {
        const pid = String(body.project_id ?? "");
        await assertProject(user, pid);
        if (!admin) return J({ error: "forbidden" }, 403);
        await db.from("hand_connect_links")
          .update({ revoked_at: new Date().toISOString(), updated_at: new Date().toISOString() })
          .eq("project_id", pid).is("revoked_at", null);
        return J({ ok: true, state: "none" });
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
