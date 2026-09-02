// Wybór produkt → workspace → projekt. Ekran jest wspólny dla całej platformy.
import { useNavigate } from 'react-router-dom'
import SharedPicker from '../shared/Picker.jsx'

export default function Picker() {
  const nav = useNavigate()
  return <SharedPicker productKey="hand" onDone={() => nav('/app', { replace: true })} />
}
