// Wyszukiwanie leadów: profil idealnego klienta + uruchomienie po źródłach.
// ICP zapisujemy w konfiguracji projektu — model używa go i przy kwalifikacji,
// i przy pisaniu pierwszej wiadomości, więc to jedno miejsce steruje całością.
import { useEffect, useState } from 'react'
import { session, hand } from '../lib/api.js'
import { IcSearch, IcLinkedIn, IcMap, IcGlobe, IcCheck, IcRefresh, IcSpark } from '../shared/Icons.jsx'

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
      const first = SOURCES.find((s) => d.integrations?.[s.key])
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
          (d.skipped ? `, pominięto ${d.skipped} już znanych.` : '.'),
      })
      loadRuns()
    } catch (e) {
      setMsg({ ok: false, text: e.message })
      loadRuns()
    } finally {
      setBusy('')
    }
  }

  if (!cfg) return <p className="muted">Ładowanie…</p>
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
          {ready[source] === false && (
            <div className="note warn" style={{ marginBottom: 12 }}>
              Źródło <b>nieskonfigurowane</b>. {src.setup}
              {src.setupUrl && (
                <>
                  {' — '}
                  <a className="link-dim" href={src.setupUrl} target="_blank" rel="noreferrer">
                    gdzie to skonfigurować ↗
                  </a>
                </>
              )}
              {!isAdmin && <div style={{ marginTop: 4 }}>Konfiguruje to administrator Fastline InfinitiQ.</div>}
            </div>
          )}
          <label className="f">
            <span className="mono">Czego szukamy</span>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && run()}
              placeholder={src.example}
            />
          </label>
          <label className="f">
            <span className="mono">Ile wyników (max 40)</span>
            <input type="number" min="5" max="40" value={limit} onChange={(e) => setLimit(+e.target.value)} />
          </label>
          <button className="btn primary" onClick={run} disabled={busy === 'run' || ready[source] === false}>
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
