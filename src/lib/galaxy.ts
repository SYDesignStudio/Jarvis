import { BRIDGE_HTTP_URL } from '../config'

/**
 * The memory galaxy's data: the graph the bridge lays out, what orbits a star,
 * and how a `focus` string from JARVIS ("1110 email:26/0772") is turned into a
 * star and a satellite to fly to.
 */

export type Arm = { name: string; colour: string; count: number }
export type Star = {
  id: string
  kind: 'job' | 'lead'
  number: string
  address: string
  postcode: string | null
  arm: string
  halo: boolean
  order: number
  path: string | null
  touched: string | null
  recent: boolean
  project: string | null
  x: number
  y: number
  z: number
  armIndex: number
  t: number
}
export type Galaxy = {
  generatedAt: string
  arms: Arm[]
  halo: { name: string; count: number }[]
  stars: Star[]
  totals: { jobs: number; leads: number; recent: number }
}
export type SatType = 'note' | 'file' | 'email'
export type Satellite = { id: string; type: SatType; label: string; sub: string; date: string; path?: string }

export const HALO_COLOUR = '#9fb3ba'
export const colourOf = (g: Galaxy, s: Star): string =>
  s.halo ? HALO_COLOUR : (g.arms.find((a) => a.name === s.arm)?.colour ?? HALO_COLOUR)

async function getJson<T>(path: string): Promise<T> {
  const r = await fetch(`${BRIDGE_HTTP_URL}${path}`)
  if (!r.ok) throw new Error(`${path} → ${r.status}`)
  return (await r.json()) as T
}

export const fetchGalaxy = (fresh = false) => getJson<Galaxy>(`/galaxy${fresh ? '?fresh=1' : ''}`)

type SatResponse = {
  notes: { id: string; date: string; section: string; source: string; text: string }[]
  files: { id: string; name: string; kind: string; stage: string; revision: string | null; date: string; path: string }[]
}
export async function fetchSatellites(starId: string): Promise<Satellite[]> {
  const r = await getJson<SatResponse>(`/galaxy/satellites?star=${encodeURIComponent(starId)}`)
  return [
    ...r.notes.map((n) => ({ id: n.id, type: 'note' as const, label: n.text, sub: n.source ? `${n.section} · ${n.source}` : n.section, date: n.date })),
    ...r.files.map((f) => ({ id: f.id, type: 'file' as const, label: f.name, sub: [f.stage, f.revision ? `rev ${f.revision}` : '', f.kind].filter(Boolean).join(' · '), date: f.date, path: f.path })),
  ]
}

type EmailResponse = { emails: { id: string; date: string; from: string; to: string; subject: string; account: string }[] }
export async function fetchEmails(starId: string): Promise<Satellite[]> {
  const r = await getJson<EmailResponse>(`/galaxy/emails?star=${encodeURIComponent(starId)}`)
  return r.emails.map((e) => ({ id: e.id, type: 'email' as const, label: e.subject, sub: `from ${e.from.replace(/<.*?>/g, '').trim() || e.from}`, date: e.date }))
}

/** Where a satellite of a given type sits: ring radius, tilt, and how fast the ring turns. */
export function orbitOf(type: SatType): { r: number; tilt: number; speed: number } {
  if (type === 'note') return { r: 1.7, tilt: 0.42, speed: 0.2 }
  if (type === 'file') return { r: 2.5, tilt: -0.3, speed: 0.14 }
  return { r: 3.3, tilt: 0.16, speed: 0.1 }
}

export type Focus = { starId: string; want?: { type: SatType; match: string } }

const POSTCODE = /\b([A-Z]{1,2}\d[A-Z\d]?)\s*(\d[A-Z]{2})\b/i

/** "1110", "76 Longmeadow", "1110 email:26/0772", a NAS path, "file:<path>" → a star (and what to light up). */
export function resolveFocus(focus: string | undefined, g: Galaxy): Focus | null {
  const raw = String(focus ?? '').trim()
  if (!raw) return null
  const frag = /\b(note|email|file):(.+)$/i.exec(raw)
  let want: Focus['want']
  let rest = raw
  if (frag) {
    want = { type: frag[1].toLowerCase() as SatType, match: frag[2].trim() }
    rest = raw.slice(0, frag.index).trim()
  }
  // A bare path is a file focus whose star is the job the path sits in.
  if (!frag && /[\\/]/.test(raw)) want = { type: 'file', match: raw }
  const lower = (s: string) => s.toLowerCase()
  let star: Star | undefined
  const byPath = want?.type === 'file' ? g.stars.find((s) => s.path && lower(want!.match).startsWith(lower(s.path))) : undefined
  if (byPath) star = byPath
  if (!star && rest) {
    const num = /\b(1\d{3})\b/.exec(rest)?.[1]
    if (num) star = g.stars.find((s) => s.number === num)
    const pc = POSTCODE.exec(rest)
    if (!star && pc) {
      const code = `${pc[1]} ${pc[2]}`.toUpperCase()
      star = g.stars.find((s) => s.postcode?.toUpperCase() === code)
    }
    if (!star) {
      const words = lower(rest).replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter((w) => w.length > 2)
      const hits = g.stars.filter((s) => words.length && words.every((w) => lower(s.address).includes(w)))
      if (hits.length === 1) star = hits[0]
      else if (hits.length > 1) star = hits.find((s) => s.recent) ?? hits[0]
    }
  }
  if (!star) return null
  return want ? { starId: star.id, want } : { starId: star.id }
}

/** The satellite a focus points at, once the star's satellites are known. */
export function pickWanted(want: Focus['want'], sats: Satellite[]): Satellite | null {
  if (!want) return null
  const m = want.match.toLowerCase()
  const ofType = sats.filter((s) => s.type === want.type)
  if (want.type === 'file') {
    const exact = ofType.find((s) => s.path && s.path.toLowerCase() === m)
    if (exact) return exact
    const tail = m.split(/[\\/]/).pop() ?? m
    return ofType.find((s) => s.label.toLowerCase() === tail) ?? ofType.find((s) => s.label.toLowerCase().includes(tail)) ?? null
  }
  const exact = ofType.find((s) => `${s.label} ${s.sub} ${s.date}`.toLowerCase().includes(m))
  if (exact) return exact
  // JARVIS describes a source as often as he quotes it ("REV D calcs from the
  // engineer"), so fall back to the satellite sharing the most real words with
  // the fragment — a date counts double, since "13 Sep" is rarely ambiguous.
  const stop = new Set(['the', 'from', 'and', 'for', 'with', 'email', 'note', 'file', 'rev', 'revision'])
  const words = m.replace(/[^a-z0-9/ ]+/g, ' ').split(/\s+/).filter((w) => w.length > 1 && !stop.has(w))
  const date = /\b(\d{1,2})\s*(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)/i.exec(m)
  let best: { s: Satellite; n: number } | null = null
  for (const s of ofType) {
    const hay = `${s.label} ${s.sub} ${s.date}`.toLowerCase()
    let n = words.filter((w) => hay.includes(w)).length
    if (date && new RegExp(`\\b0?${date[1]}\\s*${date[2].slice(0, 3)}`, 'i').test(s.date)) n += 2
    if (n > 0 && (!best || n > best.n)) best = { s, n }
  }
  return best?.s ?? null
}
