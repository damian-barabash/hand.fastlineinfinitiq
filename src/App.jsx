import { Routes, Route, Navigate, useLocation } from 'react-router-dom'
import { Suspense } from 'react'
import { session } from './shared/platform.js'
import Login from './pages/Login.jsx'
import Picker from './pages/Picker.jsx'
import Shell from './components/Shell.jsx'
import { Connect } from './shared/index.js'

function Guard({ children, needProject }) {
  const loc = useLocation()
  if (!session.token) return <Navigate to="/login" replace state={{ from: loc.pathname }} />
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
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Suspense>
  )
}
