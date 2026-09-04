// Publiczna strona zaproszenia: klient dostaje od nas link `/connect?t=…`
// i podłącza swój LinkedIn sam. Hasła nie wpisuje u nas — kreator Unipile
// otwiera się na ich domenie, a do nas wraca tylko potwierdzenie (webhook),
// które samo przypisuje konto do projektu.
//
// Strona jest poza bramką logowania (App.jsx), więc nie używa sesji: wszystko
// autoryzuje sam token z adresu.
import { useCallback, useEffect, useState } from 'react'
import { FN_BASE } from '../shared/platform.js'
import { IcLinkedIn, IcCheck, IcShield, IcGlobe } from '../shared/Icons.jsx'

async function call(action, t) {
  const r = await fetch(`${FN_BASE}/hand-api`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, t }),
  })
  return await r.json().catch(() => ({ ok: false }))
}

const BAD = {
  none: ['Ten link jest nieaktywny', 'Poproś swojego opiekuna z Fastline InfinitiQ o nowy — stary mógł zostać unieważniony.'],
  revoked: ['Link został unieważniony', 'Poproś swojego opiekuna z Fastline InfinitiQ o nowy link.'],
  expired: ['Link stracił ważność', 'Poproś swojego opiekuna z Fastline InfinitiQ o nowy — wystawienie zajmuje chwilę.'],
}

export default function Connect() {
  const params = new URLSearchParams(window.location.search)
  const t = params.get('t') || ''
  const back = params.get('ok') === '1' ? 'ok' : params.get('fail') === '1' ? 'fail' : ''

  const [info, setInfo] = useState(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  const load = useCallback(async () => {
    if (!t) { setInfo({ ok: false, state: 'none' }); return null }
    const d = await call('connect.info', t)
    setInfo(d)
    return d
  }, [t])

  useEffect(() => { load() }, [load])

  // Po powrocie z kreatora webhook Unipile bywa o sekundę spóźniony —
  // odpytujemy chwilę, żeby klient zobaczył „podłączone", a nie stary ekran.
  useEffect(() => {
    if (back !== 'ok' || info?.state === 'connected') return undefined
    let n = 0
    const id = setInterval(async () => {
      n += 1
      const d = await load()
      if (d?.state === 'connected' || n > 10) clearInterval(id)
    }, 3000)
    return () => clearInterval(id)
  }, [back, info?.state, load])

  async function start() {
    setBusy(true)
    setErr('')
    const d = await call('connect.start', t)
    if (d?.url) { window.location.href = d.url; return }
    setBusy(false)
    setErr(d?.error || 'Nie udało się otworzyć kreatora. Spróbuj ponownie za chwilę.')
    if (d?.state) setInfo((p) => ({ ...(p ?? {}), ...d }))
  }

  const corner = { position: 'absolute', width: 14, height: 14, borderColor: 'var(--acid-line)', borderStyle: 'solid' }
  const state = info?.state
  const bad = !info?.ok && BAD[state ?? 'none']

  return (
    <div className="center-page" style={{ gridTemplateColumns: 'minmax(0,1fr)' }}>
      <div className="auth-card" style={{ maxWidth: 520, textAlign: 'left' }}>
        <span style={{ ...corner, borderWidth: '2px 0 0 2px', top: -1, left: -1 }} />
        <span style={{ ...corner, borderWidth: '0 2px 2px 0', bottom: -1, right: -1 }} />

        <div className="mono">
          <span className="dot" style={{ marginRight: 8 }} />
          Fastline InfinitiQ // Lead Engine
        </div>

        {info === null && <p className="sub" style={{ marginTop: 18 }}>Sprawdzam link…</p>}

        {bad && (
          <>
            <h1 style={{ marginTop: 10 }}>{bad[0]}</h1>
            <p className="sub">{bad[1]}</p>
          </>
        )}

        {info?.ok && state === 'connected' && (
          <>
            <h1 style={{ marginTop: 10 }}>
              LinkedIn <span style={{ color: 'var(--acid)' }}>podłączony</span>
            </h1>
            <p className="sub">
              {info.account_name ? `Konto ${info.account_name} jest już` : 'Konto jest już'} połączone z projektem
              {info.project ? ` „${info.project}"` : ''}. Nie musisz nic więcej robić — możesz zamknąć tę stronę.
            </p>
            <div className="note" style={{ marginTop: 16 }}>
              <span className="row" style={{ gap: 8 }}>
                <IcCheck style={{ width: 14, height: 14, color: 'var(--acid)', flexShrink: 0 }} />
                Gotowe. Odezwiemy się, gdy agent zacznie pracę.
              </span>
            </div>
          </>
        )}

        {info?.ok && state !== 'connected' && (
          <>
            <h1 style={{ marginTop: 10 }}>
              Podłącz swój <span style={{ color: 'var(--acid)' }}>LinkedIn</span>
            </h1>
            <p className="sub">
              {info.kind === 'reconnect'
                ? 'LinkedIn poprosił o ponowne zalogowanie. Jedno kliknięcie i agent wraca do pracy.'
                : 'Dzięki temu agent Lead Engine może wyszukiwać właściwych ludzi, wysyłać zaproszenia i prowadzić rozmowy w Twoim imieniu.'}
              {info.project ? ` Projekt: ${info.project}.` : ''}
            </p>

            <div className="note" style={{ marginTop: 16, marginBottom: 18 }}>
              <div className="row" style={{ gap: 9, alignItems: 'flex-start', flexWrap: 'nowrap' }}>
                <IcShield style={{ width: 15, height: 15, color: 'var(--acid)', flexShrink: 0, marginTop: 2 }} />
                <span>
                  <b>Hasła nie podajesz nam.</b> Logujesz się na stronie naszego dostawcy (Unipile) — obsługuje
                  też kod 2FA i potwierdzenie w aplikacji LinkedIn. My dostajemy wyłącznie potwierdzenie,
                  że konto jest połączone.
                </span>
              </div>
            </div>

            {back === 'fail' && (
              <p className="err" style={{ marginBottom: 12 }}>
                Logowanie nie doszło do skutku. Spróbuj jeszcze raz — najczęściej wystarczy potwierdzić
                logowanie w aplikacji LinkedIn.
              </p>
            )}
            {back === 'ok' && state !== 'connected' && (
              <p className="sub" style={{ marginBottom: 12 }}>
                Kończymy podłączanie… Ten ekran odświeży się sam.
              </p>
            )}

            <button
              className="btn primary"
              style={{ width: '100%', justifyContent: 'center' }}
              onClick={start}
              disabled={busy}
            >
              <IcLinkedIn style={{ width: 16, height: 16 }} />
              {busy ? 'Otwieram kreator…' : info.kind === 'reconnect' ? 'Podłącz ponownie' : 'Połącz konto LinkedIn'}
            </button>
            {err && <p className="err" style={{ marginTop: 12 }}>{err}</p>}

            <p className="muted" style={{ marginTop: 16, fontSize: 12.5 }}>
              Połączenie możesz w każdej chwili cofnąć — napisz do swojego opiekuna albo wyloguj urządzenie
              w ustawieniach LinkedIna.
            </p>
          </>
        )}

        <div className="row" style={{ marginTop: 22, gap: 7, color: 'var(--dim2)' }}>
          <IcGlobe style={{ width: 13, height: 13, flexShrink: 0 }} />
          <span className="mono" style={{ fontSize: 10.5 }}>fastlineinfinitiq.pl</span>
        </div>
      </div>
    </div>
  )
}
