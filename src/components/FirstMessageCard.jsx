// Gotowa pierwsza wiadomość: właściciel pisze ją sam, agent wysyła DOSŁOWNIE i podstawia
// tylko tagi ({imie}, {firma}…). Osobny tekst na LinkedIn (notatka do zaproszenia ma limit
// znaków) i na e-mail (ma temat). Podgląd liczy serwer tą samą funkcją, którą potem wysyła —
// z prawdziwym nadawcą kanału — więc to, co widać tutaj, jest tym, co dostanie lead.
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { hand } from '../lib/api.js'
import { IcCheck } from '../shared/Icons.jsx'

const TAGS_LEAD = [
  ['imie', 'imię'],
  ['nazwisko', 'nazwisko'],
  ['imie_nazwisko', 'imię i nazwisko'],
  ['firma', 'firma'],
  ['stanowisko', 'stanowisko'],
  ['miasto', 'miasto'],
  ['branza', 'branża'],
  ['strona', 'strona www'],
]
const TAGS_ME = [
  ['moje_imie', 'kto pisze'],
  ['moja_firma', 'Twoja firma'],
  ['podpis', 'podpis'],
]

// Dwa przykłady, bo połowa leadów (Mapy, web) to firma bez osoby — szablon musi wyglądać dobrze także bez imienia.
const SAMPLES = {
  person: {
    label: 'Osoba z LinkedIna',
    lead: { full_name: 'Anna Kowalska', title: 'HR Manager', company: 'Comarch', industry: 'IT', location: 'Kraków, Woj. Małopolskie, Polska', website: 'comarch.pl' },
  },
  company: {
    label: 'Firma bez imienia',
    lead: { full_name: '', title: '', company: 'Studio Reklamy Orion', industry: '', location: 'ul. Długa 5, 31-147 Kraków, Polska', website: 'studioorion.pl' },
  },
}

const EMPTY = { enabled: false, linkedin: '', email: '', subject: '' }

export default function FirstMessageCard({ cfg, setCfg, save, busy, msg, projId }) {
  const fm = { ...EMPTY, ...(cfg.first_message ?? {}) }
  const [tab, setTab] = useState('linkedin')
  const [sample, setSample] = useState('person')
  const [pv, setPv] = useState(null)
  const bodyRef = useRef(null)
  const subjRef = useRef(null)
  const target = useRef('body')
  const seq = useRef(0)
  const caret = useRef(null)

  const set = (k, v) => setCfg({ ...cfg, first_message: { ...fm, [k]: v } })
  const tpl = fm[tab]

  useEffect(() => {
    if (!fm.enabled) return
    const my = ++seq.current
    const t = setTimeout(() => {
      hand('template.preview', {
        project_id: projId,
        channel: tab,
        template: tpl,
        subject: tab === 'email' ? fm.subject : '',
        lead: SAMPLES[sample].lead,
      })
        .then((d) => my === seq.current && setPv(d))
        .catch(() => my === seq.current && setPv(null))
    }, 450)
    return () => clearTimeout(t)
  }, [fm.enabled, tab, tpl, fm.subject, sample, projId])

  function insert(tag) {
    const inSubject = target.current === 'subject' && tab === 'email'
    const el = inSubject ? subjRef.current : bodyRef.current
    const key = inSubject ? 'subject' : tab
    const val = fm[key] || ''
    const a = el?.selectionStart ?? val.length
    const b = el?.selectionEnd ?? val.length
    const piece = `{${tag}}`
    set(key, val.slice(0, a) + piece + val.slice(b))
    caret.current = { el, pos: a + piece.length }
  }
  // kursor wraca za wstawiony tag zaraz po renderze (kontrolowane pole inaczej rzuca go na koniec);
  // synchronicznie, bo przy rAF szybkie pisanie zdążało wejść w złe miejsce
  useLayoutEffect(() => {
    const c = caret.current
    if (!c?.el) return
    caret.current = null
    c.el.focus()
    c.el.setSelectionRange(c.pos, c.pos)
  })

  const over = pv && pv.limit > 0 && pv.length > pv.limit
  const unknown = pv?.unknown ?? []

  return (
    <div className="card" style={{ gridColumn: '1 / -1' }} data-fm>
      <div className="row" style={{ marginBottom: 10 }}>
        <b>Pierwsza wiadomość — kto ją pisze</b>
        <span className={'badge right ' + (fm.enabled ? 'acid' : '')}>{fm.enabled ? 'Twój szablon' : 'pisze model'}</span>
      </div>
      <p className="muted" style={{ marginBottom: 12 }}>
        Możesz napisać pierwszą zimną wiadomość sam. Agent wyśle ją <b>słowo w słowo</b> i podstawi tylko tagi, na przykład
        imię i firmę odbiorcy. Na odpowiedzi leadów dalej odpisuje sam, jak w rozmowie.
      </p>
      <div className="chips" style={{ marginBottom: 14 }}>
        <button className={!fm.enabled ? 'on' : ''} onClick={() => set('enabled', false)}>
          Pisze model
        </button>
        <button className={fm.enabled ? 'on' : ''} onClick={() => set('enabled', true)}>
          Mój szablon
        </button>
      </div>

      {fm.enabled && (
        <>
          <div className="tabs" style={{ marginBottom: 14 }}>
            <button className={tab === 'linkedin' ? 'on' : ''} onClick={() => setTab('linkedin')}>
              LinkedIn{fm.linkedin.trim() ? '' : ' (pusty)'}
            </button>
            <button className={tab === 'email' ? 'on' : ''} onClick={() => setTab('email')}>
              E-mail{fm.email.trim() ? '' : ' (pusty)'}
            </button>
          </div>

          <div className="fm-grid">
            <div>
              {tab === 'email' && (
                <label className="f">
                  <span className="mono">Temat maila (tagi też działają)</span>
                  <input
                    ref={subjRef}
                    value={fm.subject}
                    onFocus={() => (target.current = 'subject')}
                    onChange={(e) => set('subject', e.target.value)}
                    placeholder="Pytanie do {firma|Państwa firmy}"
                  />
                </label>
              )}
              <label className="f">
                <span className="mono">
                  {tab === 'linkedin' ? 'Notatka do zaproszenia na LinkedIn' : 'Treść maila'}
                </span>
                <textarea
                  ref={bodyRef}
                  rows={tab === 'linkedin' ? 7 : 11}
                  value={tpl}
                  onFocus={() => (target.current = 'body')}
                  onChange={(e) => set(tab, e.target.value)}
                  placeholder={
                    tab === 'linkedin'
                      ? 'Cześć {imie|},\nprowadzę {moja_firma}. Organizujemy wydarzenia firmowe na torze.\nWidzisz u siebie miejsce na coś takiego?'
                      : 'Dzień dobry {imie|},\n\npiszę w sprawie {firma|Państwa firmy}…\n\n{podpis}'
                  }
                />
              </label>
              <span className="mono fm-cap">Wstaw tag — dane odbiorcy</span>
              <div className="chips fm-tags">
                {TAGS_LEAD.map(([t, l]) => (
                  <button key={t} title={l} onMouseDown={(e) => e.preventDefault()} onClick={() => insert(t)}>
                    {`{${t}}`}
                  </button>
                ))}
              </div>
              <span className="mono fm-cap">Wstaw tag — Twoje dane</span>
              <div className="chips fm-tags">
                {TAGS_ME.map(([t, l]) => (
                  <button key={t} title={l} onMouseDown={(e) => e.preventDefault()} onClick={() => insert(t)}>
                    {`{${t}}`}
                  </button>
                ))}
              </div>
              <p className="chart-tip" style={{ marginTop: 10 }}>
                Gdy o leadzie czegoś nie wiemy (firma z Map nie ma imienia), tag znika. Możesz dać tekst zastępczy po
                kresce: <b>{'{imie|}'}</b> zostawi samo „Cześć,”, a <b>{'{firma|Państwa firma}'}</b> wstawi „Państwa firma”.
                Tagi wchodzą w mianowniku, więc układaj zdanie tak, żeby nie trzeba było ich odmieniać.
                {tab === 'linkedin'
                  ? ' Pusty szablon LinkedIn oznacza, że na LinkedInie pisze model.'
                  : ' Pusty szablon e-mail oznacza, że maile pisze model. Stopka ze wspólnej skrzynki projektu dokleja się pod treścią jak zawsze.'}
              </p>
            </div>

            <div>
              <div className="row" style={{ marginBottom: 8, gap: 8 }}>
                <span className="mono fm-cap" style={{ margin: 0 }}>Podgląd</span>
                <div className="chips fm-samples right">
                  {Object.entries(SAMPLES).map(([k, s]) => (
                    <button key={k} className={sample === k ? 'on' : ''} onClick={() => setSample(k)}>
                      {s.label}
                    </button>
                  ))}
                </div>
              </div>
              <div className="fm-preview" data-fm-preview>
                {!tpl.trim() ? (
                  <span className="muted">Szablon pusty. Na tym kanale wiadomość ułoży model.</span>
                ) : !pv ? (
                  <span className="muted">Liczę podgląd…</span>
                ) : (
                  <>
                    {tab === 'email' && pv.subject && <div className="fm-subject">Temat: {pv.subject}</div>}
                    {pv.text}
                  </>
                )}
              </div>
              {tpl.trim() && pv && (
                <p className={'chart-tip ' + (over || unknown.length ? 'err' : '')} style={{ marginTop: 8 }} data-fm-count>
                  {unknown.length > 0 && <>Nieznany tag: {unknown.join(', ')}. Nie da się zapisać, dopóki go nie poprawisz. </>}
                  {pv.limit > 0
                    ? over
                      ? `${pv.length} znaków po podstawieniu, a notatka LinkedIn mieści ${pv.limit}. Wyślemy tylko to, co widać wyżej (ucięte na pełnym zdaniu). Skróć szablon.`
                      : `${pv.length} z ${pv.limit} znaków notatki LinkedIn.`
                    : `${pv.length} znaków.`}
                  {pv.sender?.name ? ` Pisze: ${pv.sender.name}.` : ''}
                </p>
              )}
            </div>
          </div>
        </>
      )}

      <div className="row" style={{ gap: 8, marginTop: 14 }}>
        <button className="btn primary" onClick={() => save()} disabled={busy}>
          <IcCheck /> {busy ? 'Zapisywanie…' : 'Zapisz'}
        </button>
        {msg && <span className={msg.ok ? 'muted' : 'err'}>{msg.text}</span>}
      </div>
    </div>
  )
}
