// Ustawienia projektu: autopilot, próg jakości, limity bezpieczeństwa i ton wiadomości.
// Limity to nie kaprys — LinkedIn ogranicza konta za masową wysyłkę, więc agent
// nigdy nie wychodzi poza to, co tu ustawisz.
import { useEffect, useState } from 'react'
import { session, hand } from '../lib/api.js'
import { IcCheck, IcPlay, IcPause, IcSpark } from '../shared/Icons.jsx'

const DAYS = [
  [1, 'Pn'],
  [2, 'Wt'],
  [3, 'Śr'],
  [4, 'Cz'],
  [5, 'Pt'],
  [6, 'So'],
  [7, 'Nd'],
]

export default function Settings() {
  const proj = session.proj
  const [cfg, setCfg] = useState(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState(null)

  useEffect(() => {
    hand('config.get', { project_id: proj.id }).then((d) => setCfg(d.config))
  }, [proj.id])

  async function save(next) {
    const value = next ?? cfg
    setBusy(true)
    try {
      const d = await hand('config.set', { project_id: proj.id, config: value })
      setCfg(d.config)
      setMsg({ ok: true, text: 'Zapisano.' })
    } catch (e) {
      setMsg({ ok: false, text: e.message })
    } finally {
      setBusy(false)
      setTimeout(() => setMsg(null), 4000)
    }
  }

  if (!cfg) return <p className="muted">Ładowanie…</p>
  const lim = cfg.limits
  const tone = cfg.tone
  const setLim = (k, v) => setCfg({ ...cfg, limits: { ...lim, [k]: v } })
  const setTone = (k, v) => setCfg({ ...cfg, tone: { ...tone, [k]: v } })

  return (
    <>
      <div className="pagehead">
        <div>
          <h1>Ustawienia</h1>
          <p className="sub">Jak mocno agent ma działać sam i w jakich granicach.</p>
        </div>
      </div>

      <div className="grid g2">
        <div className="card">
          <div className="row" style={{ marginBottom: 10 }}>
            {cfg.autopilot ? <IcPlay style={{ color: 'var(--acid)' }} /> : <IcPause style={{ color: 'var(--dim)' }} />}
            <b>Autopilot</b>
            <span className={'badge right ' + (cfg.autopilot ? 'acid' : '')}>
              {cfg.autopilot ? 'włączony' : 'wyłączony'}
            </span>
          </div>
          <p className="muted" style={{ marginBottom: 12 }}>
            Włączony — agent sam zaczepia leady powyżej progu jakości, w limitach i w godzinach pracy.
            Wyłączony — nikogo nie zaczepia sam, ale <b>nadal odpowiada na przychodzące wiadomości</b>,
            żeby rozpoczęta rozmowa nie umarła.
          </p>
          <button className="btn primary" onClick={() => save({ ...cfg, autopilot: !cfg.autopilot })} disabled={busy}>
            {cfg.autopilot ? <IcPause /> : <IcPlay />} {cfg.autopilot ? 'Wyłącz autopilota' : 'Włącz autopilota'}
          </button>

          <div className="spacer" />
          <label className="f">
            <span className="mono">Próg jakości leada ({cfg.score_threshold}/100)</span>
            <input
              type="range"
              min="0"
              max="100"
              value={cfg.score_threshold}
              onChange={(e) => setCfg({ ...cfg, score_threshold: +e.target.value })}
            />
          </label>
          <p className="chart-tip">
            Powyżej progu agent pisze sam. Poniżej — lead ląduje w „Do akceptacji" i czeka na Twoją decyzję.
            Niżej ustawiony próg = więcej wysyłki i większe ryzyko trafienia obok.
          </p>
        </div>

        <div className="card">
          <div className="row" style={{ marginBottom: 10 }}>
            <IcSpark style={{ color: 'var(--acid)' }} />
            <b>Limity bezpieczeństwa</b>
          </div>
          <p className="muted" style={{ marginBottom: 12 }}>
            LinkedIn nakłada restrykcje na konta wysyłające hurtowo. Te liczby są twardym hamulcem — agent ich
            nie przekroczy, nawet jeśli ma tysiąc gotowych leadów.
          </p>
          <div className="fgrid">
            <label className="f">
              <span className="mono">Zaproszenia dziennie</span>
              <input
                type="number"
                min="1"
                max="150"
                value={lim.invites_per_day}
                onChange={(e) => setLim('invites_per_day', +e.target.value)}
              />
            </label>
            <label className="f">
              <span className="mono">Wiadomości dziennie</span>
              <input
                type="number"
                min="1"
                max="300"
                value={lim.messages_per_day}
                onChange={(e) => setLim('messages_per_day', +e.target.value)}
              />
            </label>
            <label className="f">
              <span className="mono">Od godziny</span>
              <input
                type="number"
                min="0"
                max="23"
                value={lim.hours[0]}
                onChange={(e) => setLim('hours', [+e.target.value, lim.hours[1]])}
              />
            </label>
            <label className="f">
              <span className="mono">Do godziny</span>
              <input
                type="number"
                min="1"
                max="24"
                value={lim.hours[1]}
                onChange={(e) => setLim('hours', [lim.hours[0], +e.target.value])}
              />
            </label>
          </div>
          <span className="mono" style={{ fontSize: 11, color: 'var(--dim2)' }}>DNI ROBOCZE</span>
          <div className="chips" style={{ marginTop: 6 }}>
            {DAYS.map(([n, l]) => (
              <button
                key={n}
                className={lim.days.includes(n) ? 'on' : ''}
                onClick={() =>
                  setLim('days', lim.days.includes(n) ? lim.days.filter((d) => d !== n) : [...lim.days, n].sort())
                }
              >
                {l}
              </button>
            ))}
          </div>
          <p className="chart-tip" style={{ marginTop: 10 }}>
            Czas polski. Wysyłka rozkłada się po kilka wiadomości na minutę pracy kolejki, a nie jedną serią.
          </p>
        </div>

        <div className="card" style={{ gridColumn: '1 / -1' }}>
          <div className="row" style={{ marginBottom: 10 }}>
            <b>Ton pierwszej wiadomości</b>
          </div>
          <p className="muted" style={{ marginBottom: 12 }}>
            Treść agent układa z <b>bazy wiedzy projektu</b> — tej samej, z której korzysta Brain. Wybiera jedną
            korzyść pasującą do branży leada i kończy krótkim pytaniem.
          </p>
          <div className="fgrid">
            <label className="f">
              <span className="mono">Forma</span>
              <select value={tone.form} onChange={(e) => setTone('form', e.target.value)}>
                <option value="ty">Na Ty (bezpośrednio)</option>
                <option value="pan">Pan / Pani (oficjalnie)</option>
              </select>
            </label>
            <label className="f">
              <span className="mono">Maksymalna długość (znaki)</span>
              <input
                type="number"
                min="120"
                max="900"
                value={tone.max_chars}
                onChange={(e) => setTone('max_chars', +e.target.value)}
              />
            </label>
            <label className="f">
              <span className="mono">Podpis (opcjonalnie)</span>
              <input value={tone.signature} onChange={(e) => setTone('signature', e.target.value)} placeholder="Damian, Fastline InfinitiQ" />
            </label>
          </div>
          <label className="f">
            <span className="mono">Sztywny szablon — zostaw puste, żeby pisał model</span>
            <textarea
              rows={3}
              value={tone.template}
              onChange={(e) => setTone('template', e.target.value)}
              placeholder="Cześć {imie}, widzę że {firma} działa w {miasto}…"
            />
          </label>
          <p className="chart-tip">
            Zmienne: {'{imie}'}, {'{nazwisko}'}, {'{firma}'}, {'{miasto}'}, {'{branza}'}. Wypełniony szablon
            wyłącza improwizację modelu — wysyłamy dokładnie ten tekst.
          </p>
          <div className="row" style={{ gap: 8, marginTop: 12 }}>
            <button className="btn primary" onClick={() => save()} disabled={busy}>
              <IcCheck /> {busy ? 'Zapisywanie…' : 'Zapisz ustawienia'}
            </button>
            {msg && <span className={msg.ok ? 'muted' : 'err'}>{msg.text}</span>}
          </div>
        </div>
      </div>
    </>
  )
}
