// Logowanie wspólne dla platformy (fiq-shared) — Hand podaje tylko swoją nazwę.
import SharedLogin from '../shared/Login.jsx'

export default function Login() {
  return (
    <SharedLogin
      product="AI Łowca Leadów"
      tagline="Autonomiczne pozyskiwanie leadów. Zaloguj się, aby kontynuować."
    />
  )
}
