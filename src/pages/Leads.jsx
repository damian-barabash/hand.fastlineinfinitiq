// Leady: lista z oceną, powodem i akcjami. Tu podejmujesz decyzje o tych, których
// agent sam nie zaczepi (wynik poniżej progu) i podglądasz treść przed wysyłką.
import { useEffect, useMemo, useRef, useState } from 'react'
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
  IcSpark,
} from '../shared/Icons.jsx'
import { SkelCard } from '../shared/Skeleton.jsx'
import ProgressModal from '../shared/ProgressModal.jsx'

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
  const [subject, setSubject] = useState('')
  const [channel, setChannel] = useState('')
  const [busy, setBusy] = useState('')
  const [err, setErr] = useState('')
  const [sendInfo, setSendInfo] = useState(null)
  const readyCount = (leads ?? []).filter((l) => l.status === 'ready').length
  // leady bez oceny (model nie odpowiedział albo odpowiedź była ucięta) — da się ocenić ponownie jednym klikiem
  const unscored = (leads ?? []).filter((l) => ['review', 'ready'].includes(l.status) && (!l.why || l.meta?.unscored || /Kwalifikacja nie powiodła się/.test(l.why))).length
  const [reqInfo, setReqInfo] = useState(null)
  async function requalify() {
    setBusy('requalify')
    setErr('')
    try {
      const d = await hand('leads.requalify', { project_id: proj.id })
      setReqInfo(d)
      await load()
    } catch (e) {
      setErr(e.message)
    } finally {
      setBusy('')
    }
  }

  // okno postępu: po jednym leadzie na żądanie, żeby widać było, kto właśnie dostaje wiadomość
  const [prog, setProg] = useState(null) // {total, done, lines, running}
  const cancelRef = useRef(false)

  async function sendNew() {
    if (!readyCount) return
    const total = Math.min(readyCount, 10)
    if (!confirm(`Wysłać pierwszą wiadomość do ${total} gotowych leadów? Każda idzie tym kanałem, którym da się dotrzeć (LinkedIn albo e-mail).`)) return
    cancelRef.current = false
    setErr('')
    setSendInfo(null)
    setProg({ total, done: 0, lines: [{ text: 'Zaczynam…' }], running: true })
    let sent = 0, failed = 0, last = null
    for (let i = 0; i < total; i++) {
      if (cancelRef.current) break
      try {
        const d = await hand('leads.sendNew', { project_id: proj.id, max: 1 })
        last = d
        const r = d.results?.[0]
        sent += d.sent
        failed += d.failed
        setProg((p) => ({
          ...p,
          done: i + 1,
          lines: [...p.lines, r ? { text: `${r.name} · ${r.channel === 'linkedin' ? 'LinkedIn' : 'e-mail'}${r.ok ? '' : ` · ${r.error}`}`, ok: r.ok } : { text: 'Brak gotowych leadów albo limit dzienny wyczerpany', ok: false }],
        }))
        if (!r || !d.left) break
      } catch (e) {
        setProg((p) => ({ ...p, lines: [...p.lines, { text: e.message, ok: false }] }))
        break
      }
    }
    setProg((p) => ({ ...p, running: false, lines: [...p.lines, { text: `Wysłano ${sent}${failed ? `, błędów ${failed}` : ''}.` }] }))
    setSendInfo(last ? { ...last, sent, failed } : null)
    await load()
  }


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
      setSubject(d.subject || '')
      setChannel(d.channel || '')
    } catch (e) {
      setErr(e.message)
    }
  }

  async function send(lead, text) {
    setBusy(lead.id + 'send')
    setErr('')
    try {
      await hand('message.send', { lead_id: lead.id, content: text, subject: channel === 'email' ? subject : '' })
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
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          {unscored > 0 && (
            <button className="btn" onClick={requalify} disabled={busy === 'requalify'} title="Model ocenia jeszcze raz leady bez oceny (partiami po 8)">
              <IcSpark /> {busy === 'requalify' ? 'Oceniam…' : `Oceń ponownie (${unscored} bez oceny)`}
            </button>
          )}
          <button className="btn primary" onClick={sendNew} disabled={busy === 'sendNew' || !readyCount} title="Pierwsza wiadomość do wszystkich gotowych, do których agent jeszcze nie pisał">
            <IcSend /> {busy === 'sendNew' ? 'Wysyłam…' : `Wyślij do nowych${readyCount ? ` (${readyCount})` : ''}`}
          </button>
          <button className="btn sm" onClick={load}>
            <IcRefresh /> Odśwież
          </button>
        </div>
      </div>
      {reqInfo && (
        <div className="note" style={{ marginBottom: 14 }}>
          Oceniono ponownie {reqInfo.scored} z {reqInfo.total ?? reqInfo.scored}.
        </div>
      )}
      {sendInfo && (
        <div className="note" style={{ marginBottom: 14 }}>
          Wysłano {sendInfo.sent}{sendInfo.failed ? `, nie udało się ${sendInfo.failed} (powód przy leadzie)` : ''}.
          {sendInfo.left ? ` Zostało ${sendInfo.left} gotowych — kliknij jeszcze raz.` : ' Wszyscy gotowi mają już pierwszą wiadomość.'}
          {' '}Limit dzienny: jeszcze {sendInfo.limit_left}.
        </div>
      )}

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
      {leads === null && (
        <div className="grid g2">
          <SkelCard lines={3} />
          <SkelCard lines={3} />
          <SkelCard lines={3} />
          <SkelCard lines={3} />
        </div>
      )}
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
                  <span className="mono" style={{ fontSize: 11, color: 'var(--dim)' }}>/100</span>
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

      <ProgressModal
        open={!!prog}
        title="Wysyłka do nowych"
        subtitle="Każdy lead: model pisze wiadomość, potem idzie LinkedIn albo e-mail."
        done={prog?.done ?? 0}
        total={prog?.total ?? 0}
        lines={prog?.lines ?? []}
        running={!!prog?.running}
        onCancel={() => { cancelRef.current = true }}
        onClose={() => setProg(null)}
      />
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
                {channel === 'email' && (
                  <label className="f">
                    <span className="mono">Temat maila</span>
                    <input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Krótkie pytanie" />
                  </label>
                )}
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
                  {channel === 'linkedin'
                    ? 'Pójdzie jako notatka do zaproszenia na LinkedIn (limit 280 znaków), z konta podłączonego do projektu.'
                    : 'Pójdzie e-mailem ze wspólnej skrzynki projektu (Integracje), odpowiedzi trafią na adres reply-to.'}{' '}
                  Ton i sposób przedstawiania się poprawisz w zakładce „Test rozmowy".
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
