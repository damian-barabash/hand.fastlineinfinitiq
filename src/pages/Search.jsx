// Wyszukiwanie leadów: profil idealnego klienta + uruchomienie po źródłach.
// ICP zapisujemy w konfiguracji projektu — model używa go i przy kwalifikacji,
// i przy pisaniu pierwszej wiadomości, więc to jedno miejsce steruje całością.
import { useEffect, useState } from 'react'
import { session, hand } from '../lib/api.js'
import { IcSearch, IcLinkedIn, IcMap, IcGlobe, IcCheck, IcRefresh, IcSpark, IcPlay, IcPause, IcTrash, IcPlus, IcClock } from '../shared/Icons.jsx'
import { SkelPage } from '../shared/Skeleton.jsx'

const SOURCES = [
  {
    key: 'linkedin',
    label: 'LinkedIn',
    icon: IcLinkedIn,
    hint: 'Ludzie po stanowisku i branży — jedyne źródło, gdzie agent może od razu napisać.',
    setup: 'Panel admina → Integracje → Unipile',
    setupUrl: 'https://dashboard.unipile.com',
    example: 'właściciel warsztatu samochodowego Kraków',
  },
  {
    key: 'maps',
    label: 'Google Maps',
    icon: IcMap,
    hint: 'Firmy lokalne z telefonem, adresem i stroną. Do nich agent pisze mailem.',
    setup: 'Panel admina → Integracje → Google Places',
    setupUrl: 'https://console.cloud.google.com/apis/library/places.googleapis.com',
    example: 'warsztat samochodowy Kraków',
  },
  {
    key: 'web',
    label: 'Otwarty web',
    icon: IcGlobe,
    hint: 'Strony firmowe i katalogi z wyszukiwarki — najszerzej, ale najmniej danych kontaktowych.',
    setup: null,
    example: 'serwis klimatyzacji samochodowej Małopolska',
  },
]

export default function Search() {
  const proj = session.proj
  const isAdmin = session.user?.role === 'admin'
  const [cfg, setCfg] = useState(null)
  const [ready, setReady] = useState({})
  const [source, setSource] = useState('linkedin')
  const [query, setQuery] = useState('')
  const [limit, setLimit] = useState(20)
  const [busy, setBusy] = useState('')
  const [msg, setMsg] = useState(null)
  const [runs, setRuns] = useState([])

  const loadRuns = () => hand('runs.list', { project_id: proj.id }).then((d) => setRuns(d.runs ?? [])).catch(() => {})

  useEffect(() => {
    hand('config.get', { project_id: proj.id }).then((d) => {
      setCfg(d.config)
      setReady(d.integrations ?? {})
      const first = SOURCES.find((s) => d.integrations?.[s.key]?.ok)
      if (first) setSource(first.key)
    })
    loadRuns()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [proj.id])

  const setIcp = (k) => (e) => setCfg({ ...cfg, icp: { ...cfg.icp, [k]: e.target.value } })

  async function saveCfg() {
    setBusy('save')
    try {
      await hand('config.set', { project_id: proj.id, config: cfg })
      setMsg({ ok: true, text: 'Zapisano profil klienta.' })
    } catch (e) {
      setMsg({ ok: false, text: e.message })
    } finally {
      setBusy('')
    }
  }

  async function run() {
    if (!query.trim()) return
    setBusy('run')
    setMsg(null)
    try {
      const d = await hand('run.start', { project_id: proj.id, source, query: query.trim(), limit })
      setMsg({
        ok: true,
        text: `Znaleziono ${d.found}, dodano ${d.added} nowych` +
          (d.skipped ? `, pominięto ${d.skipped} już znanych.` : '.') +
          (d.sent ? ` Autopilot od razu napisał do ${d.sent}.` : ''),
      })
      loadRuns()
    } catch (e) {
      setMsg({ ok: false, text: e.message })
      loadRuns()
    } finally {
      setBusy('')
    }
  }

  if (!cfg) return <SkelPage cards={2} />
  const src = SOURCES.find((s) => s.key === source)

  return (
    <>
      <div className="pagehead">
        <div>
          <h1>Wyszukiwanie</h1>
          <p className="sub">
            Powiedz agentowi, kogo szukasz. Kwalifikację i punktację robi model na podstawie bazy wiedzy projektu.
          </p>
        </div>
      </div>

      <div className="grid g2">
        <div className="card">
          <div className="row" style={{ marginBottom: 12 }}>
            <IcSpark style={{ width: 18, height: 18, color: 'var(--acid)' }} />
            <b>Profil idealnego klienta</b>
          </div>
          <p className="muted" style={{ marginBottom: 14 }}>
            To nie filtr wyszukiwarki, tylko kryteria oceny. Model porównuje z nimi każdego kandydata i wystawia
            wynik 0–100 razem z jednozdaniowym uzasadnieniem.
          </p>
          <div className="fgrid">
            <label className="f">
              <span className="mono">Branża</span>
              <input value={cfg.icp.industry} onChange={setIcp('industry')} placeholder="warsztaty samochodowe" />
            </label>
            <label className="f">
              <span className="mono">Lokalizacja</span>
              <input value={cfg.icp.location} onChange={setIcp('location')} placeholder="Małopolska" />
            </label>
            <label className="f">
              <span className="mono">Stanowiska</span>
              <input value={cfg.icp.titles} onChange={setIcp('titles')} placeholder="właściciel, prezes, dyrektor" />
            </label>
            <label className="f">
              <span className="mono">Wielkość firmy</span>
              <input value={cfg.icp.company_size} onChange={setIcp('company_size')} placeholder="5–50 osób" />
            </label>
          </div>
          <label className="f">
            <span className="mono">Słowa kluczowe (co ma się zgadzać)</span>
            <input value={cfg.icp.keywords} onChange={setIcp('keywords')} placeholder="serwis, naprawa, flota" />
          </label>
          <label className="f">
            <span className="mono">Wyklucz (czego nie chcemy)</span>
            <input value={cfg.icp.exclude} onChange={setIcp('exclude')} placeholder="agencje marketingowe, uczelnie" />
          </label>
          <button className="btn primary" onClick={saveCfg} disabled={busy === 'save'}>
            <IcCheck /> {busy === 'save' ? 'Zapisywanie…' : 'Zapisz profil'}
          </button>
        </div>

        <div className="card">
          <div className="row" style={{ marginBottom: 12 }}>
            <IcSearch style={{ width: 18, height: 18, color: 'var(--acid)' }} />
            <b>Uruchom wyszukiwanie</b>
          </div>
          <div className="chips" style={{ marginBottom: 12 }}>
            {SOURCES.map((s) => (
              <button key={s.key} className={source === s.key ? 'on' : ''} onClick={() => setSource(s.key)}>
                <s.icon style={{ width: 13, height: 13 }} /> {s.label}
              </button>
            ))}
          </div>
          <p className="muted" style={{ marginBottom: 10 }}>{src.hint}</p>
          {ready[source] && !ready[source].ok && (
            <div className="note warn" style={{ marginBottom: 12 }}>
              Źródło <b>nie działa</b>: {ready[source].reason || 'nieskonfigurowane'}.{' '}
              <a className="link-dim" href={ready[source].url || src.setupUrl} target="_blank" rel="noreferrer">
                włącz tutaj ↗
              </a>
              <div style={{ marginTop: 4 }}>
                {src.setup}
                {!isAdmin && ' — konfiguruje to administrator Fastline InfinitiQ.'}
              </div>
            </div>
          )}
          <label className="f">
            <span className="mono">Czego szukamy (kilka zapytań rozdziel przecinkiem)</span>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && run()}
              placeholder={src.example}
            />
          </label>
          <p className="chart-tip" style={{ marginTop: -6, marginBottom: 10 }}>
            LinkedIn szuka wszystkich słów naraz, więc „właściciel, prezes, HR manager" jako jedna fraza daje 2–3 osoby.
            Każde zapytanie po przecinku idzie osobno, a wyniki się sumują.
          </p>
          <label className="f">
            <span className="mono">Ile wyników (max 40)</span>
            <input type="number" min="5" max="40" value={limit} onChange={(e) => setLimit(+e.target.value)} />
          </label>
          <button className="btn primary" onClick={run} disabled={busy === 'run' || (ready[source] && !ready[source].ok)}>
            <IcSearch /> {busy === 'run' ? 'Szukam i oceniam…' : 'Szukaj'}
          </button>
          {msg && (
            <div className={'note' + (msg.ok ? '' : ' warn')} style={{ marginTop: 12 }}>
              {msg.text}
            </div>
          )}
          <p className="chart-tip" style={{ marginTop: 12 }}>
            Jedno uruchomienie = jedno wywołanie modelu na całą partię. Leady powyżej progu {cfg.score_threshold}/100
            trafiają od razu do wysyłki, reszta do akceptacji.
          </p>
        </div>
      </div>

      <div className="spacer" />
      <Campaigns projId={proj.id} ready={ready} onRun={loadRuns} />

      <div className="spacer" />
      <div className="card">
        <div className="row" style={{ marginBottom: 10 }}>
          <b>Historia wyszukiwań</b>
          <button className="btn sm right" onClick={loadRuns}>
            <IcRefresh /> Odśwież
          </button>
        </div>
        {!runs.length && <p className="muted">Jeszcze nic nie szukaliśmy w tym projekcie.</p>}
        {!!runs.length && (
          <table className="tbl">
            <thead>
              <tr>
                <th>Kiedy</th>
                <th>Źródło</th>
                <th>Zapytanie</th>
                <th>Znaleziono</th>
                <th>Dodano</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.id}>
                  <td className="mono">{new Date(r.started_at).toLocaleString('pl-PL')}</td>
                  <td>{SOURCES.find((s) => s.key === r.source)?.label ?? r.source}</td>
                  <td>{r.query}</td>
                  <td>{r.found ?? '—'}</td>
                  <td>{r.added ?? '—'}</td>
                  <td>
                    {r.status === 'done' ? (
                      <span className="badge ok">gotowe</span>
                    ) : r.status === 'error' ? (
                      <span className="badge danger" title={r.error}>błąd</span>
                    ) : (
                      <span className="badge warn">w toku</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {runs.some((r) => r.status === 'error') && (
          <p className="muted" style={{ marginTop: 10 }}>
            Najedź na „błąd", żeby zobaczyć powód — najczęściej to brak tokenu integracji albo wyłączone API.
          </p>
        )}
      </div>
    </>
  )
}


// ── Kampanie: to samo wyszukiwanie, ale codziennie o stałej porze, aż do pauzy/stopu ────
const DAYS = [
  [1, 'Pn'],
  [2, 'Wt'],
  [3, 'Śr'],
  [4, 'Cz'],
  [5, 'Pt'],
  [6, 'So'],
  [7, 'Nd'],
]
const ST = {
  active: { label: 'aktywna', cls: 'acid' },
  paused: { label: 'pauza', cls: 'warn' },
  stopped: { label: 'zatrzymana', cls: '' },
}
const fmtAt = (iso) => (iso ? new Date(iso).toLocaleString('pl-PL', { dateStyle: 'short', timeStyle: 'short' }) : '—')

function Campaigns({ projId, ready, onRun }) {
  const [list, setList] = useState(null)
  const [adding, setAdding] = useState(false)
  const [f, setF] = useState({ name: '', source: 'linkedin', queries: '', per_run: 20, hour: 9, days: [1, 2, 3, 4, 5] })
  const [busy, setBusy] = useState('')
  const [err, setErr] = useState('')

  const load = () => hand('campaign.list', { project_id: projId }).then((d) => setList(d.campaigns ?? [])).catch((e) => setErr(e.message))
  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projId])

  async function create() {
    const queries = f.queries.split(/[\n;|,]/).map((q) => q.trim()).filter(Boolean)
    if (!queries.length) return setErr('Wpisz przynajmniej jedno zapytanie')
    setBusy('new')
    setErr('')
    try {
      await hand('campaign.create', { project_id: projId, ...f, queries })
      setAdding(false)
      setF({ name: '', source: 'linkedin', queries: '', per_run: 20, hour: 9, days: [1, 2, 3, 4, 5] })
      await load()
    } catch (e) {
      setErr(e.message)
    } finally {
      setBusy('')
    }
  }
  async function setStatus(c, status) {
    setBusy(c.id)
    try {
      await hand('campaign.set', { id: c.id, status })
      await load()
    } catch (e) {
      setErr(e.message)
    } finally {
      setBusy('')
    }
  }
  async function remove(c) {
    if (!confirm(`Usunąć kampanię „${c.name || c.queries.join(', ')}"? Znalezione leady zostają.`)) return
    setBusy(c.id)
    try {
      await hand('campaign.delete', { id: c.id })
      await load()
    } catch (e) {
      setErr(e.message)
    } finally {
      setBusy('')
    }
  }
  async function runNow(c) {
    setBusy(c.id + 'run')
    setErr('')
    try {
      const d = await hand('campaign.run', { id: c.id })
      setErr(d.error ? d.error : `Znaleziono ${d.found}, dodano ${d.added} nowych${d.sent ? `, autopilot od razu napisał do ${d.sent}` : ''}.`)
      await load()
      onRun?.()
    } catch (e) {
      setErr(e.message)
    } finally {
      setBusy('')
    }
  }

  const srcLabel = (k) => SOURCES.find((s) => s.key === k)?.label ?? k
  return (
    <div className="card">
      <div className="row" style={{ marginBottom: 10 }}>
        <IcClock style={{ width: 18, height: 18, color: 'var(--acid)' }} />
        <b>Kampanie — szukaj codziennie</b>
        <button className="btn sm right" onClick={() => setAdding(!adding)}>
          <IcPlus /> {adding ? 'Anuluj' : 'Nowa kampania'}
        </button>
      </div>
      <p className="muted" style={{ marginBottom: 12 }}>
        Kampania uruchamia to samo wyszukiwanie codziennie o wybranej godzinie (czas polski), aż ją zatrzymasz albo
        wstrzymasz. Znalezione osoby przechodzą kwalifikację jak przy ręcznym wyszukiwaniu; te już znane są pomijane,
        więc każdy dzień dokłada tylko nowe leady. Przy włączonym autopilocie agent pisze do nowych od razu po
        wyszukiwaniu (w godzinach pracy i w limicie dziennym); bez autopilota użyj „Wyślij do nowych" w zakładce Leady.
      </p>
      {err && <div className="note warn" style={{ marginBottom: 12 }}>{err}</div>}

      {adding && (
        <div className="lesson-row" style={{ borderTop: '1px solid var(--line)', paddingTop: 12 }}>
          <div className="fgrid">
            <label className="f">
              <span className="mono">Nazwa</span>
              <input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="HR w firmach IT — Kraków" />
            </label>
            <label className="f">
              <span className="mono">Źródło</span>
              <select value={f.source} onChange={(e) => setF({ ...f, source: e.target.value })}>
                {SOURCES.map((s) => (
                  <option key={s.key} value={s.key} disabled={ready[s.key] && !ready[s.key].ok}>
                    {s.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="f">
              <span className="mono">Wyników na dzień (max 40)</span>
              <input type="number" min="5" max="40" value={f.per_run} onChange={(e) => setF({ ...f, per_run: +e.target.value })} />
            </label>
            <label className="f">
              <span className="mono">O której (czas polski)</span>
              <input type="number" min="0" max="23" value={f.hour} onChange={(e) => setF({ ...f, hour: +e.target.value })} />
            </label>
          </div>
          <label className="f">
            <span className="mono">Zapytania — jedno w linii albo po przecinku</span>
            <textarea
              rows={3}
              value={f.queries}
              onChange={(e) => setF({ ...f, queries: e.target.value })}
              placeholder={'HR manager Kraków\nHR Business Partner Kraków\noffice manager Kraków'}
            />
          </label>
          <span className="mono" style={{ fontSize: 11, color: 'var(--dim2)' }}>DNI</span>
          <div className="chips" style={{ marginTop: 6, marginBottom: 12 }}>
            {DAYS.map(([n, l]) => (
              <button key={n} className={f.days.includes(n) ? 'on' : ''} onClick={() => setF({ ...f, days: f.days.includes(n) ? f.days.filter((d) => d !== n) : [...f.days, n].sort() })}>
                {l}
              </button>
            ))}
          </div>
          <button className="btn primary" onClick={create} disabled={busy === 'new'}>
            <IcPlay /> {busy === 'new' ? 'Zapisuję…' : 'Uruchom kampanię'}
          </button>
        </div>
      )}

      {list === null && <SkelPage cards={1} />}
      {list && !list.length && !adding && <p className="muted">Brak kampanii. Dodaj pierwszą — agent będzie szukał sam, codziennie.</p>}
      {list?.map((c) => {
        const st = ST[c.status] ?? ST.stopped
        return (
          <div key={c.id} className="lesson-row">
            <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              <b>{c.name || c.queries.join(', ')}</b>
              <span className={'badge ' + st.cls}>{st.label}</span>
              <span className="badge">{srcLabel(c.source)}</span>
              <span className="badge">codziennie {String(c.hour).padStart(2, '0')}:00 · {c.days.map((d) => DAYS.find((x) => x[0] === d)?.[1]).join(' ')}</span>
              <span className="badge">{c.per_run} / dzień</span>
            </div>
            <p className="muted" style={{ marginTop: 6, fontSize: 12.5 }}>
              {c.queries.map((q, i) => (
                <span key={i} className="badge" style={{ marginRight: 6, marginBottom: 4 }}>{q}</span>
              ))}
            </p>
            <p className="mono" style={{ fontSize: 10.5, color: 'var(--dim)', marginTop: 4 }}>
              uruchomień {c.runs_count} · znaleziono {c.found_total} · dodano {c.added_total} · ostatnio {fmtAt(c.last_run_at)} · następne{' '}
              {c.status === 'active' ? fmtAt(c.next_run_at) : '—'}
              {c.last_error && <span style={{ color: 'var(--danger)' }}> · błąd: {c.last_error}</span>}
            </p>
            <div className="row" style={{ gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
              {c.status === 'active' && (
                <button className="btn sm" onClick={() => setStatus(c, 'paused')} disabled={busy === c.id}>
                  <IcPause /> Pauza
                </button>
              )}
              {c.status !== 'active' && (
                <button className="btn sm primary" onClick={() => setStatus(c, 'active')} disabled={busy === c.id}>
                  <IcPlay /> {c.status === 'paused' ? 'Wznów' : 'Uruchom ponownie'}
                </button>
              )}
              {c.status !== 'stopped' && (
                <button className="btn sm" onClick={() => setStatus(c, 'stopped')} disabled={busy === c.id}>
                  Stop
                </button>
              )}
              <button className="btn sm" onClick={() => runNow(c)} disabled={busy === c.id + 'run'}>
                <IcSearch /> {busy === c.id + 'run' ? 'Szukam…' : 'Szukaj teraz'}
              </button>
              <button className="btn sm danger" onClick={() => remove(c)} disabled={busy === c.id}>
                <IcTrash /> Usuń
              </button>
            </div>
          </div>
        )
      })}
    </div>
  )
}
