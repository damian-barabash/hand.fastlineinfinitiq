import React from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App.jsx'
import { consumeSso } from './shared/platform.js'
import './shared/design.css'
import './styles/hand.css'

// Akcent produktu Hand — design system czyta go z --product-accent, więc cały
// wspólny CSS (przyciski, wykresy, obramowania) robi się pomarańczowy bez forka.
document.documentElement.style.setProperty('--product-accent', '#FF7A18')
document.documentElement.style.setProperty('--product-accent-dark', '#c25200')
document.documentElement.style.setProperty('--product-accent-light', '#ff8f3d')

// Wejście z innego produktu przynosi sesję we fragmencie (#sso=…) — przejmujemy
// ją zanim cokolwiek się wyrenderuje, żeby Guard nie odesłał na /login.
consumeSso().finally(() => {
  createRoot(document.getElementById('root')).render(
    <React.StrictMode>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </React.StrictMode>,
  )
})
