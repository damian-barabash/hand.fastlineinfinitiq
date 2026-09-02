// Integracje projektu. Token Unipile i klucz Google są wspólne dla platformy
// (panel admina), a tutaj wybiera się TYLKO to, co zależy od projektu:
// z którego podłączonego konta LinkedIn agent szuka i pisze. Wybór ma admin.
import { useEffect, useState } from 'react'
import { session, hand } from '../lib/api.js'
import { IcLinkedIn, IcMap, IcGlobe, IcCheck, IcRefresh, IcMail, IcKey } from '../shared/Icons.jsx'
import IntegrationsAdmin from '../shared/IntegrationsAdmin.jsx'
import { SkelPage } from '../shared/Skeleton.jsx'

const ADMIN_INTEGRATIONS = 'Panel admina → Integracje'

export default function Integrations() {
  const proj = session.proj
  const isAdmin = session.user?.role === 'admin'
  const [cfg, setCfg] = useState(null)
  const [ready, setReady] = useState({})
  const [accounts, setAccounts] = useState(null)
  const [busy, setBusy] = useState('')
  const [msg, setMsg] = useState(null)

  useEffect(() => {
    hand('config.get', { project_id: proj.id }).then((d) => {
      setCfg(d.config)
      setReady(d.integrations ?? {})
    })
  }, [proj.id])

  // „gotowe" nie może znaczyć tylko „klucz jest wklejony" — pytamy dostawcę
  async function recheck() {
    setBusy('check')
    setMsg(null)
    try {
      const d = await hand('integrations.check', { project_id: proj.id })
      setReady(d.integrations ?? {})
      setMsg({ ok: true, text: 'Sprawdzone przed chwilą.' })
    } catch (e) {
      setMsg({ ok: false, text: e.message })
    } finally {
      setBusy('')
    }
  }

  async function loadAccounts() {
    setBusy('acc')
    setMsg(null)
    try {
      const d = await hand('unipile.accounts')
      setAccounts(d.accounts ?? [])
      if (!d.accounts?.length) setMsg({ ok: false, text: 'Token działa, ale nie ma podłączonych kont LinkedIn.' })
    } catch (e) {
      setMsg({ ok: false, text: e.message })
      setAccounts([])
    } finally {
      setBusy('')
    }
  }

  async function pick(id) {
    setBusy('save')
    try {
      const d = await hand('config.set', { project_id: proj.id, config: { ...cfg, unipile_account_id: id } })
      setCfg(d.config)
      setMsg({ ok: true, text: 'Konto przypisane do projektu.' })
    } catch (e) {
      setMsg({ ok: false, text: e.message })
    } finally {
      setBusy('')
    }
  }

  async function saveEmail(next) {
    setBusy('save')
    try {
      const d = await hand('config.set', { project_id: proj.id, config: next })
      setCfg(d.config)
      setMsg({ ok: true, text: 'Zapisano.' })
    } catch (e) {
      setMsg({ ok: false, text: e.message })
    } finally {
      setBusy('')
    }
  }

  if (!cfg) return <SkelPage cards={2} />

  const rows = [
    {
      key: 'linkedin',
      icon: IcLinkedIn,
      label: 'LinkedIn (Unipile)',
      desc: 'Szukanie ludzi, zaproszenia i wiadomości. Jeden token na całą platformę, konta podpinane w Unipile.',
      url: 'https://dashboard.unipile.com',
    },
    {
      key: 'maps',
      icon: IcMap,
      label: 'Google Places',
      desc: 'Firmy z mapy: nazwa, adres, telefon, strona. Wymaga włączonego Places API (New) w projekcie Google.',
      url: 'https://console.cloud.google.com/apis/library/places.googleapis.com',
    },
    { key: 'web', icon: IcGlobe, label: 'Otwarty web', desc: 'Wyszukiwarka i strony firmowe. Nic nie wymaga konfiguracji.', url: null },
  ]

  return (
    <>
      <div className="pagehead">
        <div>
          <h1>Integracje</h1>
          <p className="sub">Czym agent może się posługiwać w tym projekcie.</p>
        </div>
      </div>

      <div className="card">
        <div className="row">
          <b>Źródła leadów</b>
          <button className="btn sm right" onClick={recheck} disabled={busy === 'check'}>
            <IcRefresh /> {busy === 'check' ? 'Sprawdzam…' : 'Sprawdź teraz'}
          </button>
        </div>
        <div style={{ marginTop: 12 }}>
          {rows.map((r) => {
            const st = ready[r.key] ?? {}
            return (
              <div className="row int-row" key={r.key}>
                <r.icon style={{ width: 18, height: 18, color: st.ok ? 'var(--acid)' : 'var(--dim2)' }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <b>{r.label}</b>
                  <div className="muted" style={{ fontSize: 12.5 }}>{r.desc}</div>
                  {!st.ok && st.reason && (
                    <div style={{ fontSize: 12.5, marginTop: 4, color: 'var(--warn)' }}>
                      {st.reason}{' '}
                      <a className="link-dim" href={st.url || r.url} target="_blank" rel="noreferrer">
                        włącz tutaj ↗
                      </a>
                    </div>
                  )}
                </div>
                <span className={'badge ' + (st.ok ? 'ok' : 'warn')}>{st.ok ? 'gotowe' : 'nie działa'}</span>
              </div>
            )
          })}
        </div>
        {(!ready.linkedin?.ok || !ready.maps?.ok) && (
          <div className="note warn" style={{ marginTop: 12 }}>
            Tokeny ustawia się raz dla całej platformy: <b>{ADMIN_INTEGRATIONS}</b>.
            {!isAdmin && ' Skontaktuj się z administratorem Fastline InfinitiQ.'}
          </div>
        )}
      </div>

      <div className="spacer" />
      <div className="card">
        <div className="row" style={{ marginBottom: 10 }}>
          <IcLinkedIn style={{ width: 18, height: 18, color: 'var(--acid)' }} />
          <b>Konto LinkedIn tego projektu</b>
          {isAdmin && (
            <button className="btn sm right" onClick={loadAccounts} disabled={busy === 'acc' || !ready.linkedin?.ok}>
              <IcRefresh /> {busy === 'acc' ? 'Pobieram…' : 'Pobierz konta'}
            </button>
          )}
        </div>
        <p className="muted" style={{ marginBottom: 12 }}>
          Z tego konta agent wyszukuje ludzi, wysyła zaproszenia i pisze wiadomości. Każdy projekt może mieć inne.
        </p>
        {!isAdmin ? (
          <div className="note">
            {cfg.unipile_account_id
              ? 'Konto LinkedIn jest przypisane przez administratora.'
              : 'Konto LinkedIn nie zostało jeszcze przypisane — skontaktuj się z administratorem.'}
          </div>
        ) : (
          <>
            {accounts === null && (
              <p className="muted">
                {cfg.unipile_account_id
                  ? `Aktualnie: ${cfg.unipile_account_id}. Kliknij „Pobierz konta", żeby zmienić.`
                  : 'Kliknij „Pobierz konta", żeby zobaczyć listę z Unipile.'}
              </p>
            )}
            {accounts?.map((a) => (
              <div className="row int-row" key={a.id}>
                <IcLinkedIn style={{ width: 15, height: 15, color: 'var(--acid)' }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <b>{a.name || a.id}</b>
                  <div className="mono" style={{ fontSize: 10.5, color: 'var(--dim2)' }}>
                    {a.type} · {a.status} · {a.id}
                  </div>
                </div>
                {cfg.unipile_account_id === a.id ? (
                  <span className="badge acid">
                    <IcCheck style={{ width: 11, height: 11 }} /> używane
                  </span>
                ) : (
                  <button className="btn sm" onClick={() => pick(a.id)} disabled={busy === 'save'}>
                    Użyj
                  </button>
                )}
              </div>
            ))}
            {accounts?.length === 0 && (
              <p className="muted">
                Brak kont —{' '}
                <a className="link-dim" href="https://dashboard.unipile.com" target="_blank" rel="noreferrer">
                  podłącz LinkedIn w Unipile ↗
                </a>
              </p>
            )}
          </>
        )}
      </div>

      <div className="spacer" />
      <div className="card">
        <div className="row" style={{ marginBottom: 10 }}>
          <IcMail style={{ width: 18, height: 18, color: 'var(--acid)' }} />
          <b>E-mail do leadów bez LinkedIna</b>
        </div>
        <p className="muted" style={{ marginBottom: 12 }}>
          Firmy z Google Maps i z weba nie mają profilu LinkedIn — do nich agent pisze mailem. Klucz Resend
          i adres nadawcy bierzemy z ustawień sprzedawcy w Brain (ten sam projekt), żeby nie duplikować konfiguracji.
        </p>
        <label className="f" style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          <input
            type="checkbox"
            checked={cfg.email.enabled}
            onChange={(e) => saveEmail({ ...cfg, email: { ...cfg.email, enabled: e.target.checked } })}
            style={{ width: 18, height: 18 }}
          />
          <span>Wysyłaj maile do leadów bez LinkedIna</span>
        </label>
        <div className="fgrid">
          <label className="f">
            <span className="mono">Nadawca (puste = z Brain)</span>
            <input
              value={cfg.email.from}
              onChange={(e) => setCfg({ ...cfg, email: { ...cfg.email, from: e.target.value } })}
              placeholder="Damian <damian@fastlineinfinitiq.pl>"
            />
          </label>
          <label className="f">
            <span className="mono">Temat (puste = generowany)</span>
            <input
              value={cfg.email.subject}
              onChange={(e) => setCfg({ ...cfg, email: { ...cfg.email, subject: e.target.value } })}
              placeholder="Krótkie pytanie"
            />
          </label>
        </div>
        <button className="btn primary" onClick={() => saveEmail(cfg)} disabled={busy === 'save'}>
          <IcCheck /> Zapisz
        </button>
      </div>

      {msg && (
        <p className={msg.ok ? 'muted' : 'err'} style={{ marginTop: 12 }}>
          {msg.text}
        </p>
      )}

      {/* Klucze są wspólne dla całej platformy, więc edytuje je admin — ten sam
          komponent stoi w panelu admina w każdej domenie. Tutaj jest pod ręką,
          bo to jedyne miejsce, w którym widać, że źródło nie działa. */}
      {isAdmin && (
        <>
          <div className="spacer" />
          <div className="pagehead" style={{ marginBottom: 12 }}>
            <div>
              <div className="mono">
                <IcKey style={{ width: 13, height: 13, marginRight: 6, verticalAlign: '-2px' }} />
                strefa administratora
              </div>
              <h1 style={{ fontSize: 22 }}>Klucze platformy</h1>
              <p className="sub">Model AI, Unipile i Google. Zapis od razu sprawdza, czy klucz naprawdę działa.</p>
            </div>
          </div>
          <IntegrationsAdmin />
        </>
      )}
    </>
  )
}
