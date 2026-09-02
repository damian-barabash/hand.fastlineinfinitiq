// Leady: lista z oceną, powodem i akcjami. Tu podejmujesz decyzje o tych, których
// agent sam nie zaczepi (wynik poniżej progu) i podglądasz treść przed wysyłką.
import { useEffect, useMemo, useState } from 'react'
import { session, hand } from '../lib/api.js'
import {
  IcTarget,
  IcLinkedIn,
  IcMap,
  IcGlobe,
  IcCheck,
  IcX,
  IcSend,
  IcRefresh,
  IcMail,
  IcPhone,
  IcEye,
} from '../shared/Icons.jsx'

const SRC_ICON = { linkedin: IcLinkedIn, maps: IcMap, web: IcGlobe }
const STATUS = {
  review: { label: 'Do akceptacji', cls: 'warn' },
  ready: { label: 'Gotowy do wysyłki', cls: 'acid' },
  contacted: { label: 'Skontaktowany', cls: '' },
  replied: { label: 'Odpowiedział', cls: 'ok' },
  rejected: { label: 'Odrzucony', cls: '' },
  failed: { label: 'Błąd wysyłki', cls: 'danger' },
  archived: { label: 'Archiwum', cls: '' },
}
const FILTERS = [
  { key: '', label: 'Wszystkie' },
  { key: 'review', label: 'Do akceptacji' },
  { key: 'ready', label: 'Gotowe' },
  { key: 'contacted', label: 'Skontaktowane' },
  { key: 'replied', label: 'Odpowiedziały' },
  { key: 'failed', label: 'Błędy' },
]

export default function Leads() {
  const proj = session.proj
  const [status, setStatus] = useState('')
  const [q, setQ] = useState('')
  const [leads, setLeads] = useState(null)
  const [open, setOpen] = useState(null)
  const [draft, setDraft] = useState(null)
  const [busy, setBusy] = useState('')
  const [err, setErr] = useState('')

  const load = () =>
    hand('leads.list', { project_id: proj.id, status: status || undefined })
      .then((d) => setLeads(d.leads ?? []))
      .catch((e) => setErr(e.message))

  useEffect(() => {
    setLeads(null)
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [proj.id, status])

  const shown = useMemo(() => {
    const s = q.trim().toLowerCase()
    if (!s) return leads ?? []
    return (leads ?? []).filter((l) =>
      [l.full_name, l.company, l.title, l.headline, l.location, l.industry, l.why]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
        .includes(s),
    )
  }, [leads, q])

  async function act(lead, a) {
    setBusy(lead.id + a)
    try {
      await hand('lead.act', { id: lead.id, act: a })
      await load()
    } catch (e) {
      setErr(e.message)
    } finally {
      setBusy('')
    }
  }

  async function preview(lead) {
    setOpen(lead)
    setDraft(null)
    setErr('')
    try {
      const d = await hand('lead.draft', { id: lead.id })
      setDraft(d.text)
    } catch (e) {
      setErr(e.message)
    }
  }

  async function send(lead, text) {
    setBusy(lead.id + 'send')
    setErr('')
    try {
      await hand('message.send', { lead_id: lead.id, content: text })
      setOpen(null)
      await load()
    } catch (e) {
      setErr(e.message)
    } finally {
      setBusy('')
    }
  }

  return (
    <>
      <div className="pagehead">
        <div>
          <h1>Leady</h1>
          <p className="sub">
            Wynik 0–100 wystawia model, porównując kandydata z profilem klienta i bazą wiedzy. Obok masz powód tej oceny.
          </p>
        </div>
        <button className="btn sm" onClick={load}>
          <IcRefresh /> Odśwież
        </button>
      </div>

      <div className="row" style={{ gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
        <div className="chips">
          {FILTERS.map((f) => (
            <button key={f.key} className={status === f.key ? 'on' : ''} onClick={() => setStatus(f.key)}>
              {f.label}
            </button>
          ))}
        </div>
        <input
          style={{ flex: 1, minWidth: 200 }}
          placeholder="Szukaj w leadach…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>

      {err && <div className="note warn" style={{ marginBottom: 14 }}>{err}</div>}
      {leads === null && <p className="muted">Ładowanie…</p>}
      {leads && !shown.length && (
        <div className="empty">
          <p>Brak leadów w tym widoku.</p>
          <p className="muted">Uruchom wyszukiwanie w zakładce „Wyszukiwanie".</p>
        </div>
      )}

      <div className="grid g2">
        {shown.map((l) => {
          const Ic = SRC_ICON[l.source] ?? IcTarget
          const st = STATUS[l.status] ?? { label: l.status, cls: '' }
          return (
            <div className="card" key={l.id}>
              <div className="row" style={{ alignItems: 'flex-start', gap: 12 }}>
                <Ic style={{ width: 18, height: 18, color: 'var(--acid)', flexShrink: 0, marginTop: 2 }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <b>{l.full_name || l.company || '—'}</b>
                  <div className="muted" style={{ fontSize: 12.5 }}>
                    {[l.title || l.headline, l.full_name ? l.company : null, l.location].filter(Boolean).join(' · ')}
                  </div>
                </div>
                <div style={{ textAlign: 'right', flexShrink: 0 }}>
                  <div className="display" style={{ fontSize: 24, color: 'var(--acid)' }}>{Math.round(l.score)}</div>
                  <span className="mono" style={{ fontSize: 10, color: 'var(--dim2)' }}>/100</span>
                </div>
              </div>
              {l.why && (
                <p className="muted" style={{ marginTop: 10, fontSize: 13, lineHeight: 1.5 }}>
                  {l.why}
                </p>
              )}
              <div className="row" style={{ gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
                <span className={'badge ' + st.cls}>{st.label}</span>
                {l.industry && <span className="badge">{l.industry}</span>}
                {l.email && (
                  <span className="badge">
                    <IcMail style={{ width: 11, height: 11 }} /> {l.email}
                  </span>
                )}
                {l.phone && (
                  <span className="badge">
                    <IcPhone style={{ width: 11, height: 11 }} /> {l.phone}
                  </span>
                )}
              </div>
              <div className="row" style={{ gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
                {l.status === 'review' && (
                  <button className="btn sm primary" onClick={() => act(l, 'approve')} disabled={busy === l.id + 'approve'}>
                    <IcCheck /> Do wysyłki
                  </button>
                )}
                {['review', 'ready'].includes(l.status) && (
                  <button className="btn sm" onClick={() => act(l, 'reject')}>
                    <IcX /> Odrzuć
                  </button>
                )}
                <button className="btn sm" onClick={() => preview(l)}>
                  <IcEye /> Podgląd wiadomości
                </button>
                {l.li_url && (
                  <a className="btn sm" href={l.li_url} target="_blank" rel="noreferrer">
                    <IcLinkedIn /> Profil
                  </a>
                )}
                {l.website && (
                  <a className="btn sm" href={l.website} target="_blank" rel="noreferrer">
                    <IcGlobe /> Strona
                  </a>
                )}
              </div>
            </div>
          )
        })}
      </div>

      {open && (
        <div className="modal-bg" onClick={() => setOpen(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="row" style={{ marginBottom: 12 }}>
              <b>Pierwsza wiadomość — {open.full_name || open.company}</b>
              <button className="btn sm right" onClick={() => setOpen(null)}>
                <IcX />
              </button>
            </div>
            {draft === null && !err && <p className="muted">Model układa wiadomość…</p>}
            {draft !== null && (
              <>
                <label className="f">
                  <span className="mono">Treść (możesz poprawić przed wysłaniem)</span>
                  <textarea rows={7} value={draft} onChange={(e) => setDraft(e.target.value)} />
                </label>
                <div className="row" style={{ gap: 8 }}>
                  <button
                    className="btn primary"
                    onClick={() => send(open, draft)}
                    disabled={busy === open.id + 'send'}
                  >
                    <IcSend /> {busy === open.id + 'send' ? 'Wysyłam…' : 'Wyślij teraz'}
                  </button>
                  <button className="btn" onClick={() => preview(open)}>
                    <IcRefresh /> Napisz od nowa
                  </button>
                </div>
                <p className="chart-tip" style={{ marginTop: 10 }}>
                  Wysyłka idzie tym kanałem, którym da się dotrzeć: LinkedIn, jeśli lead ma profil, w innym razie e-mail.
                </p>
              </>
            )}
            {err && <div className="note warn" style={{ marginTop: 10 }}>{err}</div>}
          </div>
        </div>
      )}
    </>
  )
}
