// Rozmowy: pełna historia z każdym leadem — to, co agent wysłał, i to, co odpisali.
// Odpowiedzi agent pisze sam nawet przy wyłączonym autopilocie; autopilot rządzi
// tylko zaczepianiem nowych leadów.
import { useEffect, useMemo, useState } from 'react'
import { session, hand } from '../lib/api.js'
import { IcChat, IcSend, IcRefresh, IcLinkedIn, IcMail } from '../shared/Icons.jsx'
import { SkelList, SkelText } from '../shared/Skeleton.jsx'

const CH_ICON = { linkedin: IcLinkedIn, email: IcMail }

export default function Chats() {
  const proj = session.proj
  const [leads, setLeads] = useState(null)
  const [sel, setSel] = useState(null)
  const [thread, setThread] = useState(null)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [q, setQ] = useState('')

  const load = () =>
    hand('leads.list', { project_id: proj.id })
      .then((d) => setLeads((d.leads ?? []).filter((l) => ['contacted', 'replied', 'failed'].includes(l.status))))
      .catch((e) => setErr(e.message))

  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [proj.id])

  async function open(lead) {
    setSel(lead)
    setThread(null)
    setErr('')
    try {
      const d = await hand('lead.messages', { id: lead.id })
      setThread(d.messages ?? [])
      if (lead.unread) load()
    } catch (e) {
      setErr(e.message)
    }
  }

  async function send() {
    if (!text.trim() || !sel) return
    setBusy(true)
    setErr('')
    try {
      await hand('message.send', { lead_id: sel.id, content: text.trim() })
      setText('')
      await open(sel)
      load()
    } catch (e) {
      setErr(e.message)
    } finally {
      setBusy(false)
    }
  }

  const shown = useMemo(() => {
    const s = q.trim().toLowerCase()
    const list = leads ?? []
    if (!s) return list
    return list.filter((l) => [l.full_name, l.company].filter(Boolean).join(' ').toLowerCase().includes(s))
  }, [leads, q])

  return (
    <>
      <div className="pagehead">
        <div>
          <h1>Rozmowy</h1>
          <p className="sub">Pełna historia kontaktu z każdym leadem — LinkedIn i e-mail w jednym miejscu.</p>
        </div>
        <button className="btn sm" onClick={load}>
          <IcRefresh /> Odśwież
        </button>
      </div>

      {err && <div className="note warn" style={{ marginBottom: 14 }}>{err}</div>}

      <div className="chat-split">
        <div className="card chat-list">
          <input placeholder="Szukaj…" value={q} onChange={(e) => setQ(e.target.value)} style={{ marginBottom: 10 }} />
          {leads === null && <SkelList rows={4} />}
          {leads && !shown.length && <p className="muted">Nie ma jeszcze żadnej rozmowy.</p>}
          {shown.map((l) => (
            <button
              key={l.id}
              className={'chat-item' + (sel?.id === l.id ? ' on' : '')}
              onClick={() => open(l)}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <b>{l.full_name || l.company || '—'}</b>
                <div className="muted" style={{ fontSize: 11.5 }}>
                  {[l.company !== l.full_name ? l.company : null, l.industry].filter(Boolean).join(' · ')}
                </div>
              </div>
              {l.unread && <span className="dot" title="Nieprzeczytane" />}
              {l.status === 'failed' && <span className="badge danger">błąd</span>}
            </button>
          ))}
        </div>

        <div className="card chat-thread">
          {!sel && (
            <div className="empty">
              <IcChat style={{ width: 26, height: 26, opacity: 0.4 }} />
              <p>Wybierz rozmowę z listy.</p>
            </div>
          )}
          {sel && (
            <>
              <div className="row" style={{ marginBottom: 12 }}>
                <b>{sel.full_name || sel.company}</b>
                {sel.li_url && (
                  <a className="btn sm right" href={sel.li_url} target="_blank" rel="noreferrer">
                    <IcLinkedIn /> Profil
                  </a>
                )}
              </div>
              <div className="chat-msgs">
                {thread === null && <SkelText lines={5} />}
                {thread?.map((m) => {
                  const Ic = CH_ICON[m.channel] ?? IcChat
                  return (
                    <div key={m.id} className={'msg ' + (m.direction === 'out' ? 'user' : 'ai')}>
                      <div>{m.content}</div>
                      <div className="mono" style={{ fontSize: 10, opacity: 0.6, marginTop: 6 }}>
                        <Ic style={{ width: 10, height: 10, verticalAlign: '-1px', marginRight: 5 }} />
                        {new Date(m.created_at).toLocaleString('pl-PL')}
                        {m.status === 'invited' && ' · zaproszenie'}
                      </div>
                    </div>
                  )
                })}
                {thread?.length === 0 && <p className="muted">Brak wiadomości w tej rozmowie.</p>}
              </div>
              <div className="chat-input">
                <textarea
                  rows={2}
                  placeholder="Napisz sam albo zostaw puste — agent ułoży wiadomość z bazy wiedzy."
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send()
                  }}
                />
                <button className="btn primary" onClick={send} disabled={busy}>
                  <IcSend /> {busy ? 'Wysyłam…' : 'Wyślij'}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </>
  )
}
