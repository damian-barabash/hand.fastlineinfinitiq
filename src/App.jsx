import { Routes, Route, Navigate, useLocation } from 'react-router-dom'
import { Suspense, lazy, useState } from 'react'
import { session } from './shared/platform.js'
import Login from './pages/Login.jsx'
import Picker from './pages/Picker.jsx'
import Shell from './components/Shell.jsx'
import { Connect } from './shared/index.js'
const ChangePassword = lazy(() => import('./shared/ChangePassword.jsx'))

function Guard({ children, needProject }) {
  const loc = useLocation()
  const [, bump] = useState(0)
  if (!session.token) return <Navigate to="/login" replace state={{ from: loc.pathname }} />
  // konto z zakupu online: najpierw własne hasło (wspólne z Brain)
  if (session.user?.must_change_password) return <ChangePassword onDone={() => bump((n) => n + 1)} />
  if (needProject && (!session.ws || !session.proj)) return <Navigate to="/" replace />
  return children
}

export default function App() {
  return (
    <Suspense fallback={null}>
      <Routes>
        <Route path="/login" element={<Login />} />
        {/* zaproszenie dla klienta: publiczne, autoryzuje token z adresu */}
        <Route path="/connect" element={<Connect product="AI Łowca Leadów" tagline="Dzięki temu agent AI Łowca Leadów może wyszukiwać właściwych ludzi, wysyłać zaproszenia i prowadzić rozmowy w Twoim imieniu." />} />
        <Route
          path="/"
          element={
            <Guard>
              <Picker />
            </Guard>
          }
        />
        <Route
          path="/app/*"
          element={
            <Guard needProject>
              <Shell />
            </Guard>
          }
        />
        <Route path="/platnosci" element={<Navigate to={`/app/platnosci${typeof location !== 'undefined' ? location.search : ''}`} replace />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Suspense>
  )
}
