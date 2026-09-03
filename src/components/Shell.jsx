// Layout panelu Lead Engine — układ identyczny jak w Brain (jeden design system),
// zmienia się tylko akcent, nazwa i zestaw sekcji.
import { Routes, Route, NavLink, Navigate, useNavigate } from 'react-router-dom'
import { lazy, Suspense, useEffect, useState } from 'react'
import { session, getTheme, setTheme, ensureProductAccess, api } from '../lib/api.js'
import { warmHand } from '../lib/useHand.js'
import { warm } from '../shared/useCached.js'
import {
  IcDash,
  IcSearch,
  IcTarget,
  IcChat,
  IcBook,
  IcGear,
  IcShield,
  IcLogout,
  IcSun,
  IcMoon,
  IcChevL,
  IcChevR,
  IcGlobe,
} from '../shared/Icons.jsx'
import { SkelPage } from '../shared/Skeleton.jsx'

const Dashboard = lazy(() => import('../pages/Dashboard.jsx'))
const Search = lazy(() => import('../pages/Search.jsx'))
const Leads = lazy(() => import('../pages/Leads.jsx'))
const Chats = lazy(() => import('../pages/Chats.jsx'))
const Knowledge = lazy(() => import('../pages/Knowledge.jsx'))
const Integrations = lazy(() => import('../pages/Integrations.jsx'))
const Settings = lazy(() => import('../pages/Settings.jsx'))
const AdminPanel = lazy(() => import('../pages/AdminPanel.jsx'))

export default function Shell() {
  const nav = useNavigate()
  const [open, setOpen] = useState(window.innerWidth > 900)
  const [theme, setThemeState] = useState(getTheme())
  const user = session.user
  const ws = session.ws
  const proj = session.proj
  // Nazwa produktu pochodzi z rejestru platformy — panel nie może pokazywać
  // samego „Hand", bo klient z kilkoma produktami widzi wszędzie to samo słowo.
  const product = session.product ?? { sense: 'Hand', name: 'Lead Engine' }

  // Dostęp do produktu daje workspace klienta — stara sesja w localStorage nie
  // może wpuścić do Lead Engine kogoś, komu produkt odebrano.
  useEffect(() => {
    let alive = true
    ensureProductAccess('hand')
      .then(({ ok }) => {
        if (alive && !ok) {
          session.setProj(null)
          nav('/', { replace: true })
        }
      })
      .catch(() => {})
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // prefetch: chunki stron + dane sekcji — nawigacja bez czekania
  useEffect(() => {
    const idle = window.requestIdleCallback || ((f) => setTimeout(f, 300))
    idle(() => {
      import('../pages/Dashboard.jsx')
      import('../pages/Search.jsx')
      import('../pages/Leads.jsx')
      import('../pages/Chats.jsx')
      warmHand('stats', { project_id: proj.id, days: 30 })
      warmHand('leads.list', { project_id: proj.id })
      warmHand('config.get', { project_id: proj.id })
      warm('kb.list', { project_id: proj.id })
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [proj.id])

  function toggleTheme() {
    const t = theme === 'dark' ? 'light' : 'dark'
    setTheme(t)
    setThemeState(t)
  }
  function logout() {
    api('logout').catch(() => {})
    session.clear()
    nav('/login')
  }

  const items = [
    { to: '/app/dashboard', label: 'Pulpit', icon: <IcDash /> },
    { to: '/app/search', label: 'Wyszukiwanie', icon: <IcSearch /> },
    { to: '/app/leads', label: 'Leady', icon: <IcTarget /> },
    { to: '/app/chats', label: 'Rozmowy', icon: <IcChat /> },
    { to: '/app/knowledge', label: 'Baza wiedzy', icon: <IcBook /> },
  ]

  return (
    <div className="shell">
      <aside className={`sb ${open ? '' : 'closed'}`}>
        <div className="sb-top">
          <div className="sb-logo">
            <img className="mark-img" src="/favicon-192.png" alt="InfinitiQ" />
            {open && (
              <span className="word">
                {product.sense}<em>.</em>
              </span>
            )}
          </div>
          {open && (
            <div className="sb-ctx">
              <button onClick={() => nav('/', { state: { stage: 'product' } })} title="Zmień produkt">
                <span className="mono" style={{ letterSpacing: '.08em' }}>PD</span> <b>{product.name}</b>
              </button>
              <button onClick={() => nav('/', { state: { stage: 'ws' } })} title="Zmień workspace">
                <span className="mono" style={{ letterSpacing: '.08em' }}>WS</span> <b>{ws?.name}</b>
              </button>
              <button onClick={() => nav('/', { state: { stage: 'proj' } })} title="Zmień projekt">
                <span className="mono" style={{ letterSpacing: '.08em' }}>PR</span> <b>{proj?.name}</b>
              </button>
            </div>
          )}
        </div>
        <nav className="sb-nav">
          {items.map((it) => (
            <NavLink key={it.to} to={it.to} className={({ isActive }) => `sb-item ${isActive ? 'on' : ''}`} title={it.label}>
              {it.icon}
              {open && <span className="lbl">{it.label}</span>}
            </NavLink>
          ))}
          <div className="sb-sep" />
          <NavLink to="/app/integrations" className={({ isActive }) => `sb-item ${isActive ? 'on' : ''}`} title="Integracje">
            <IcGlobe />
            {open && <span className="lbl">Integracje</span>}
          </NavLink>
          <NavLink to="/app/settings" className={({ isActive }) => `sb-item ${isActive ? 'on' : ''}`} title="Ustawienia">
            <IcGear />
            {open && <span className="lbl">Ustawienia</span>}
          </NavLink>
          {user?.role === 'admin' && (
            <NavLink to="/app/admin" className={({ isActive }) => `sb-item ${isActive ? 'on' : ''}`} title="Admin">
              <IcShield />
              {open && <span className="lbl">Admin</span>}
            </NavLink>
          )}
        </nav>
        <div className="sb-bottom">
          <button className="sb-item" onClick={toggleTheme} title="Motyw">
            {theme === 'dark' ? <IcSun /> : <IcMoon />}
            {open && <span className="lbl">{theme === 'dark' ? 'Jasny motyw' : 'Ciemny motyw'}</span>}
          </button>
          <button className="sb-item" onClick={logout} title="Wyloguj">
            <IcLogout />
            {open && <span className="lbl">Wyloguj</span>}
          </button>
          <button className="sb-item" onClick={() => setOpen(!open)} title={open ? 'Zwiń' : 'Rozwiń'}>
            {open ? <IcChevL /> : <IcChevR />}
            {open && <span className="lbl">Zwiń menu</span>}
          </button>
        </div>
      </aside>
      <main className="main">
        <Suspense fallback={<SkelPage stats={4} cards={2} />}>
          <Routes>
            <Route path="dashboard" element={<Dashboard />} />
            <Route path="search" element={<Search />} />
            <Route path="leads" element={<Leads />} />
            <Route path="chats" element={<Chats />} />
            <Route path="knowledge" element={<Knowledge />} />
            <Route path="integrations" element={<Integrations />} />
            <Route path="settings" element={<Settings />} />
            {user?.role === 'admin' && <Route path="admin" element={<AdminPanel />} />}
            <Route path="*" element={<Navigate to="dashboard" replace />} />
          </Routes>
        </Suspense>
      </main>
    </div>
  )
}
