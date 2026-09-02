// SWR na hand-api — ten sam mechanizm co w Brain, tylko z innym transportem.
import { useCached as useShared, warm as warmShared } from '../shared/useCached.js'
import { hand } from './api.js'

export const useHand = (action, payload) => useShared('hand:' + action, payload, (a, p) => hand(a.slice(5), p))
export const warmHand = (action, payload) => warmShared('hand:' + action, payload, (a, p) => hand(a.slice(5), p))
export { useCached } from '../shared/useCached.js'
