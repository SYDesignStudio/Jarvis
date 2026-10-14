import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { idox } from './idox.mjs'
import { ocella } from './ocella.mjs'

/**
 * Which planning register each council runs, and how JARVIS can reach it.
 *
 *   idox / ocella — searched and read directly.
 *   browser       — a JavaScript portal a script cannot drive; JARVIS uses
 *                   Salman's own Chrome (the chrome_* tools) at the URL given.
 *
 * Extend without code in data/registers.json:
 *   { "Ealing": { "kind": "idox", "base": "https://pam.ealing.gov.uk/online-applications" } }
 */

export const KNOWN = {
  Brent: { kind: 'idox', base: 'https://pa.brent.gov.uk/online-applications' },
  'Basingstoke and Deane': { kind: 'idox', base: 'https://planning.basingstoke.gov.uk/online-applications' },
  Hillingdon: { kind: 'ocella', base: 'https://planning.hillingdon.gov.uk/OcellaWeb' },
  Hounslow: {
    kind: 'browser',
    base: 'https://planningandbuilding.hounslow.gov.uk/NECSWS/ES/Presentation/Planning/OnlinePlanning/OnlinePlanningSearch',
  },
  'Richmond upon Thames': { kind: 'browser', base: 'https://planning.richmond.gov.uk/richmond/search-applications/' },
}

function extra() {
  try {
    return JSON.parse(readFileSync(join(process.cwd(), 'data', 'registers.json'), 'utf8'))
  } catch {
    return {}
  }
}

/** Council name as postcodes.io spells it ("Richmond upon Thames") or loosely ("Richmond"). */
export function registerFor(council, { override } = {}) {
  if (override) {
    const base = override.replace(/\/+$/, '')
    return /OcellaWeb/i.test(base) ? { council, ...ocella(base) } : { council, ...idox(base) }
  }
  const all = { ...KNOWN, ...extra() }
  const key =
    Object.keys(all).find((k) => k.toLowerCase() === String(council ?? '').toLowerCase()) ??
    Object.keys(all).find((k) => k.toLowerCase().startsWith(String(council ?? '').toLowerCase().split(' ')[0]))
  if (!key) return null
  const c = all[key]
  if (c.kind === 'idox') return { council: key, ...idox(c.base) }
  if (c.kind === 'ocella') return { council: key, ...ocella(c.base) }
  return { council: key, kind: 'browser', base: c.base }
}
