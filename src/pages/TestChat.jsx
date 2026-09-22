// Test rozmowy: Ty grasz leada, Łowca pisze jak do prawdziwego. Pierwsza
// wiadomość idzie tą samą funkcją co autopilot, odpowiedzi tą samą co webhook
// LinkedIna — to, co tu widzisz, to dokładnie to, co dostanie klient.
// Nic z tej rozmowy nie trafia do leadów ani statystyk (tylko koszt modelu).
// Poprawki („Popraw" pod wiadomością) zapisują się na stałe jako wskazówki
// trenera i działają od następnej wiadomości — także w prawdziwej wysyłce.
import { useEffect, useRef, useState } from 'react'
import { session, hand, api } from '../lib/api.js'
import Lessons from '../shared/Lessons.jsx'
import { IcSend, IcSpark, IcRefresh, IcThumbDown, IcCheck, IcLinkedIn, IcMail, IcTarget } from '../shared/Icons.jsx'

const EMPTY_LEAD = { full_name: '', title: '', company: '', industry: '', location: '', website: '', why: '' }
const EXAMPLE = {
  full_name: 'Anna Kowalska',
  title: 'HR Business Partner',
  company: 'Comarch',
  industry: 'IT',
  location: 'Kraków',
  website: 'https://www.comarch.pl',
  why: 'duża firma z zespołami, które regularnie organizują integracje i spotkania z klientami',
}

export default function TestChat() {
  const proj = session.proj
  const storeKey = `hand_test:${proj.id}`
  const saved = (() => {
    try {
      return JSON.parse(sessionStorage.getItem(storeKey) || 'null')
    } catch {
      return null
    }
  })()
  const [channel, setChannel] = useState(saved?.channel || 'email')
  const [lead, setLead] = useState(saved?.lead || { ...EMPTY_LEAD })
  const [msgs, setMsgs] = useState(saved?.msgs || [])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [real, setReal] = useState(null) // prawdziwe leady projektu do „weź z listy"
  const boxRef = useRef(null)

  useEffect(() => {
    try {
      sessionStorage.setItem(storeKey, JSON.stringify({ channel, lead, msgs }))
    } catch {
      /* quota */
    }
  }, [channel, lead, msgs, storeKey])

  useEffect(() => {
    boxRef.current?.scrollTo({ top: boxRef.current.scrollHeight, behavior: 'smooth' })
  }, [msgs, busy])

  const setL = (k) => (e) => setLead({ ...lead, [k]: e.target.value })
  const started = msgs.length > 0

  function reset() {
    setMsgs([])
    setErr('')
    setInput('')
  }

  async function loadReal() {
    if (real) return
    try {
      const d = await hand('leads.list', { project_id: proj.id, limit: 100 })
      setReal(d.leads ?? [])
    } catch (e) {
      setErr(e.message)
    }
  }

  function pickReal(id) {
    const l = (real ?? []).find((x) => x.id === id)
    if (!l) return
    setLead({
      full_name: l.full_name || '',
      title: l.title || l.headline || '',
      company: l.company || '',
      industry: l.industry || '',
      location: l.location || '',
      website: l.website || '',
      why: l.why || '',
    })
    // kanał wynika z leada: profil LinkedIn → notatka do zaproszenia, inaczej e-mail
    setChannel(l.li_urn ? 'linkedin' : 'email')
    reset()
  }

  // historia dla API: ai → assistant, user → user
  const history = (list) => list.filter((m) => m.content).map((m) => ({ role: m.role === 'ai' ? 'assistant' : 'user', content: m.content }))

  async function run(next) {
    setBusy(true)
    setErr('')
    try {
      const d = await hand('test.chat', { project_id: proj.id, channel, lead, messages: history(next) })
      setMsgs([...next, { role: 'ai', content: d.text, subject: d.subject || '' }])
    } catch (e) {
      setErr(e.message)
      setMsgs(next)
    } finally {
      setBusy(false)
    }
  }

  function start() {
    if (busy) return
    run([])
  }
  function send() {
    const text = input.trim()
    if (!text || busy || !started) return
    setInput('')
    run([...msgs, { role: 'user', content: text }])
  }

  const ChIcon = channel === 'linkedin' ? IcLinkedIn : IcMail

  return (
    <>
      <div className="pagehead">
        <div>
          <h1>Test rozmowy</h1>
          <p className="sub">
            Ty grasz leada, Łowca pisze jak do prawdziwego. Nic z tej rozmowy nie trafia do leadów ani statystyk.
          </p>
        </div>
      </div>

      <Lessons
        projId={proj.id}
        scope="hand"
        title="Poprawki dla Łowcy"
        hint="Uwagi, które dawałeś Łowcy w teście rozmowy. Włączone dopisują się do jego instrukcji przy każdej pierwszej wiadomości i każdej odpowiedzi — na LinkedInie i w mailu."
        delay="Zmiana działa od następnej wiadomości — Łowca czyta wskazówki przy każdym pisaniu."
      />

      <div className="grid g2" style={{ gridTemplateColumns: 'minmax(260px, 340px) minmax(0, 1fr)', alignItems: 'start' }}>
        <div className="card">
          <div className="row" style={{ marginBottom: 10 }}>
            <IcTarget style={{ width: 18, height: 18, color: 'var(--acid)' }} />
            <b>Kogo udajesz</b>
          </div>
          <p className="muted" style={{ marginBottom: 12, fontSize: 12.5 }}>
            Te dane agent widzi tak samo, jak przy prawdziwym leadzie z wyszukiwania. Puste imię = agent zwraca się do firmy.
          </p>
          <div className="chips" style={{ marginBottom: 12 }}>
            <button className={channel === 'linkedin' ? 'on' : ''} onClick={() => { setChannel('linkedin'); reset() }} title="Notatka do zaproszenia na LinkedIn (limit 280 znaków), pisze właściciel podłączonego konta">
              <IcLinkedIn style={{ width: 13, height: 13 }} /> LinkedIn
            </button>
            <button className={channel === 'email' ? 'on' : ''} onClick={() => { setChannel('email'); reset() }} title="E-mail z tematem, pisze osoba z ustawień „Jak agent się przedstawia”">
              <IcMail style={{ width: 13, height: 13 }} /> E-mail
            </button>
          </div>
          <label className="f">
            <span className="mono">Imię i nazwisko (puste = nieznane)</span>
            <input value={lead.full_name} onChange={setL('full_name')} placeholder="Anna Kowalska" />
          </label>
          <label className="f">
            <span className="mono">Stanowisko</span>
            <input value={lead.title} onChange={setL('title')} placeholder="HR Business Partner" />
          </label>
          <label className="f">
            <span className="mono">Firma</span>
            <input value={lead.company} onChange={setL('company')} placeholder="Comarch" />
          </label>
          <div className="fgrid">
            <label className="f">
              <span className="mono">Branża</span>
              <input value={lead.industry} onChange={setL('industry')} placeholder="IT" />
            </label>
            <label className="f">
              <span className="mono">Miasto</span>
              <input value={lead.location} onChange={setL('location')} placeholder="Kraków" />
            </label>
          </div>
          <label className="f">
            <span className="mono">Strona</span>
            <input value={lead.website} onChange={setL('website')} placeholder="https://…" />
          </label>
          <label className="f">
            <span className="mono">Dlaczego pasuje (jak z kwalifikacji)</span>
            <textarea rows={2} value={lead.why} onChange={setL('why')} placeholder="duża firma z zespołami, które organizują integracje" />
          </label>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            <button className="btn sm" onClick={() => { setLead({ ...EXAMPLE }); reset() }}>
              Wypełnij przykładem
            </button>
            <select
              className="btn sm"
              style={{ maxWidth: 200 }}
              onFocus={loadReal}
              onChange={(e) => pickReal(e.target.value)}
              value=""
              aria-label="Weź prawdziwego leada z listy"
            >
              <option value="">Weź z listy leadów…</option>
              {(real ?? []).map((l) => (
                <option key={l.id} value={l.id}>
                  {(l.full_name || l.company || '—').slice(0, 40)} · {Math.round(l.score)}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="card" style={{ height: '66vh', minHeight: 460, display: 'flex', flexDirection: 'column', padding: 0 }}>
          <div className="row" style={{ padding: '12px 16px', borderBottom: '1px solid var(--line)', flexWrap: 'wrap' }}>
            <span className="dot" />
            <span className="mono" style={{ color: 'var(--text)' }}>
              <ChIcon style={{ width: 12, height: 12, verticalAlign: '-1px', marginRight: 6 }} />
              Symulacja — {channel === 'linkedin' ? 'LinkedIn' : 'e-mail'}
            </span>
            <button className="btn sm right" onClick={reset}>
              <IcRefresh /> Nowa rozmowa
            </button>
          </div>
          <div className="chat-msgs" ref={boxRef}>
            {!started && !busy && (
              <div style={{ display: 'grid', placeItems: 'center', gap: 12, padding: '32px 16px', textAlign: 'center' }}>
                <p className="muted" style={{ maxWidth: 380 }}>
                  Łowca pisze pierwszy — tak jak do znalezionego leada. Wygeneruj pierwszą wiadomość, a potem odpisuj jako{' '}
                  {lead.full_name || lead.company || 'lead'}.
                </p>
                <button className="btn primary" onClick={start} disabled={busy}>
                  <IcSpark /> Wygeneruj pierwszą wiadomość
                </button>
              </div>
            )}
            {msgs.map((m, i) => (
              <div key={i} style={{ display: 'flex', flexDirection: 'column', alignItems: m.role === 'user' ? 'flex-end' : 'flex-start' }}>
                <div className={`msg ${m.role === 'user' ? 'user' : 'ai'}`}>
                  {m.subject && (
                    <div className="mono" style={{ fontSize: 11, color: 'var(--acid)', marginBottom: 6, textTransform: 'none', letterSpacing: 0 }}>
                      Temat: {m.subject}
                    </div>
                  )}
                  {m.content}
                </div>
                {m.role === 'ai' && (
                  <span className="mono" style={{ fontSize: 11, color: 'var(--dim)', marginTop: 3 }}>
                    {m.content.length} znaków
                    {channel === 'linkedin' && i === 0 && m.content.length > 280 && ' — za długo na notatkę LinkedIn'}
                  </span>
                )}
                {m.role === 'ai' && <Correct projId={proj.id} original={m.content} />}
              </div>
            ))}
            {busy && (
              <span className="typing">
                <i />
                <i />
                <i />
              </span>
            )}
            {err && <div className="note warn">{err}</div>}
          </div>
          <div className="chat-input">
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && send()}
              placeholder={started ? 'Odpisz jako lead…' : 'Najpierw wygeneruj pierwszą wiadomość'}
              disabled={!started || busy}
            />
            <button className="send" onClick={send} disabled={busy || !started} aria-label="Wyślij">
              <IcSend />
            </button>
          </div>
        </div>
      </div>
    </>
  )
}

// Poprawka do wiadomości Łowcy. Rozmowa jest symulowana, więc zapisujemy samą
// uwagę trenera (z oryginałem dla kontekstu) — od razu włączoną.
function Correct({ projId, original }) {
  const [open, setOpen] = useState(false)
  const [note, setNote] = useState('')
  const [state, setState] = useState('')

  async function save() {
    if (!note.trim()) return
    setState('busy')
    try {
      await api('lessons.create', { project_id: projId, scope: 'hand', note: note.trim(), original })
      setState('done')
      setNote('')
      setTimeout(() => {
        setOpen(false)
        setState('')
      }, 1500)
    } catch (e) {
      setState(e.message)
    }
  }

  if (!open) {
    return (
      <button className="btn sm" style={{ marginTop: 4 }} onClick={() => setOpen(true)} title="Napisz, co poprawić">
        <IcThumbDown /> Popraw
      </button>
    )
  }
  return (
    <div className="lesson-inline">
      <textarea
        rows={2}
        autoFocus
        placeholder="Co jest nie tak? np. za długo, nie pytaj o budżet, zacznij od konkretu o firmie"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) save()
        }}
      />
      <div className="row" style={{ gap: 8 }}>
        <button className="btn sm primary" onClick={save} disabled={state === 'busy'}>
          <IcCheck /> {state === 'busy' ? 'Zapisuję…' : 'Zapamiętaj na stałe'}
        </button>
        <button className="btn sm" onClick={() => setOpen(false)}>Anuluj</button>
        {state === 'done' && <span className="muted">Zapamiętane — działa od następnej wiadomości.</span>}
        {state && !['busy', 'done'].includes(state) && <span className="err">{state}</span>}
      </div>
    </div>
  )
}
