// Klient panelu Lead Engine.
//   • platforma (sesja, logowanie, workspace'y, projekty, baza wiedzy, admin)
//     idzie do brain-admin przez wspólny moduł fiq-shared,
//   • wszystko, co Handowe (szukanie, leady, rozmowy, statystyki), idzie do hand-api.
// Cache jest jeden i wspólny — mutacja w którymkolwiek kliencie czyści całość.
export {
  FN_BASE,
  session,
  api,
  cacheRead,
  cacheWrite,
  invalidateCache,
  loadProducts,
  ensureProductAccess,
  gotoProduct,
  consumeSso,
  getTheme,
  setTheme,
} from '../shared/platform.js'
import { FN_BASE, session, invalidateCache } from '../shared/platform.js'

const READ_ACTIONS = new Set([
  'config.get',
  'runs.list',
  'leads.list',
  'lead.messages',
  'stats',
])

export async function hand(action, payload = {}) {
  const r = await fetch(`${FN_BASE}/hand-api`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, token: session.token, ...payload }),
  })
  const data = await r.json().catch(() => ({}))
  if (r.status === 401) {
    session.clear()
    window.location.href = '/login'
    throw new Error('auth')
  }
  if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`)
  if (!READ_ACTIONS.has(action)) invalidateCache()
  return data
}
