import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { listJobs, jobFiles, nasReachable, fmtDate } from './jobs.mjs'
import { listProjects, PROJECTS_DIR } from '../research/projects.mjs'
import { parseNotes } from './index.mjs'
import { findPostcode } from '../research/constraints.mjs'

/**
 * The memory galaxy: the practice's job history as a star map.
 *
 * Every job is a star. The spiral ARMS are councils — the way an architect's
 * world is actually organised — and a star's distance along its arm is its
 * place in time (job numbers run in order, older near the core, the newest at
 * the bright tips). Satellites round a star are what JARVIS knows about that
 * job: notes (inner ring), current drawings and reports (middle), emails
 * (outer). When JARVIS cites a source, the page flies to it.
 *
 * Layout is computed here, deterministically, so the picture is the same on
 * every visit and testable without a browser. Councils come from a bulk
 * postcodes.io lookup, cached in data/councils.json; the graph itself is
 * cached for six hours because "last touched" needs a stat of every job folder
 * on the NAS.
 */

const DATA = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'data')
const COUNCILS = join(DATA, 'councils.json')
const CACHE = join(DATA, 'galaxy.json')
const CACHE_MS = 6 * 60 * 60_000
/** Bumped whenever the graph's shape changes, so an old cache is rebuilt rather than served. */
const SCHEMA = 2
const RECENT_DAYS = 730

// ---------------------------------------------------------------- councils

function readJson(file, fallback) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

/** postcode → council (admin_district), bulk via postcodes.io, cached forever. */
export async function councilsFor(postcodes, { fetchImpl = fetch, cacheFile = COUNCILS } = {}) {
  const cache = readJson(cacheFile, {})
  const want = [...new Set(postcodes.filter(Boolean).map((p) => p.toUpperCase()))].filter((p) => !(p in cache))
  for (let i = 0; i < want.length; i += 100) {
    const batch = want.slice(i, i + 100)
    try {
      const res = await fetchImpl('https://api.postcodes.io/postcodes', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ postcodes: batch }),
        signal: AbortSignal.timeout(20_000),
      })
      const data = await res.json()
      for (const r of data.result ?? []) cache[r.query.toUpperCase()] = r.result?.admin_district ?? null
    } catch {
      // Offline: leave them unknown this time; they will be tried again next build.
    }
  }
  mkdirSync(dirname(cacheFile), { recursive: true })
  writeFileSync(cacheFile, JSON.stringify(cache, null, 1))
  return cache
}

/** "London Borough of Hounslow" → "Hounslow"; "Surrey Heath" stays. */
export const shortCouncil = (name) =>
  String(name ?? '')
    .replace(/^(London Borough of|Royal Borough of|City of|Borough of)\s+/i, '')
    .replace(/\s+(Borough|District|City) Council$/i, '')
    .trim() || 'Unplaced'

// ---------------------------------------------------------------- layout

/** A stable 0..1 from a string, so scatter never changes between visits. */
export function hash01(s, salt = 0) {
  let h = 2166136261 ^ salt
  for (const c of String(s)) {
    h ^= c.charCodeAt(0)
    h = Math.imul(h, 16777619) >>> 0
  }
  return (h % 100000) / 100000
}

export const ARM_COLOURS = ['#00e5ff', '#ffb547', '#c77dff', '#5affc8', '#ff6b6b', '#f4f3f0', '#7aa7ff', '#ffd166']
const CORE_R = 6
const OUTER_R = 40
const TWIST = 0.085 // radians per unit of radius — how tightly the arms wind

/**
 * Pure: place stars on spiral arms. stars: [{ id, arm, order }] where order
 * sorts a star within its arm (job number); arms: names in display order.
 */
export function layout(stars, arms) {
  const byArm = new Map(arms.map((a) => [a, []]))
  for (const s of stars) (byArm.get(s.arm) ?? byArm.set(s.arm, []).get(s.arm)).push(s)
  const A = Math.max(1, byArm.size)
  const out = []
  ;[...byArm.entries()].forEach(([arm, list], k) => {
    list.sort((a, b) => a.order - b.order)
    const base = (k * 2 * Math.PI) / A
    list.forEach((s, i) => {
      const t = (i + 1) / (list.length + 1)
      const r = CORE_R + t * (OUTER_R - CORE_R)
      const angle = base + TWIST * r
      const across = (hash01(s.id, 1) - 0.5) * 3.2 // scatter across the arm
      const lift = (hash01(s.id, 2) - 0.5) * 1.6 // thin disc
      const x = r * Math.cos(angle) - across * Math.sin(angle)
      const z = r * Math.sin(angle) + across * Math.cos(angle)
      out.push({ ...s, t, x: round(x), y: round(lift), z: round(z), armIndex: k, halo: false })
    })
  })
  return out
}
const round = (n) => Math.round(n * 1000) / 1000

/** A council with fewer jobs than an arm needs: a loose halo round the outside. */
export const ARM_MIN = 4
export function haloLayout(stars) {
  return stars.map((s) => {
    const r = OUTER_R * (0.55 + 0.55 * hash01(s.id, 3))
    const angle = hash01(s.id, 4) * Math.PI * 2
    return { ...s, t: hash01(s.id, 3), x: round(r * Math.cos(angle)), y: round((hash01(s.id, 5) - 0.5) * 7), z: round(r * Math.sin(angle)), armIndex: -1, halo: true }
  })
}

// ---------------------------------------------------------------- the graph

function lastTouched(path) {
  let newest = 0
  try {
    for (const n of readdirSync(path)) {
      try {
        newest = Math.max(newest, statSync(join(path, n)).mtimeMs)
      } catch {}
    }
  } catch {}
  return newest
}

export async function buildGalaxy({ fresh = false } = {}) {
  if (!fresh) {
    const cached = readJson(CACHE, null)
    if (cached && cached.version === SCHEMA && Date.now() - new Date(cached.generatedAt).getTime() < CACHE_MS) return cached
  }
  const jobs = nasReachable() ? listJobs({ fresh: true }) : []
  const projects = listProjects()
  const councils = await councilsFor([...jobs.map((j) => j.postcode), ...projects.map((p) => findPostcode(p))])
  const councilOf = (pc) => shortCouncil(pc ? councils[pc.toUpperCase()] : null)

  const projectByPostcode = new Map()
  for (const p of projects) {
    const pc = findPostcode(p)
    if (pc) projectByPostcode.set(pc.toUpperCase(), p)
  }
  const cutoff = Date.now() - RECENT_DAYS * 86400_000
  const stars = jobs.map((j) => {
    const touched = lastTouched(j.path)
    return {
      id: `job:${j.number}`,
      kind: 'job',
      number: j.number,
      address: j.address,
      postcode: j.postcode,
      arm: councilOf(j.postcode),
      order: Number(j.number) || 0,
      path: j.path,
      touched: touched ? new Date(touched).toISOString() : null,
      recent: touched > cutoff,
      project: (j.postcode && projectByPostcode.get(j.postcode.toUpperCase())) || null,
    }
  })
  // Leads and projects that have no NAS folder yet: dimmer, ringed stars at the tip of their arm.
  const jobPostcodes = new Set(jobs.map((j) => j.postcode?.toUpperCase()).filter(Boolean))
  for (const p of projects) {
    const pc = findPostcode(p)
    if (pc && jobPostcodes.has(pc.toUpperCase())) continue
    if (/^_/.test(p)) continue
    stars.push({ id: `project:${p}`, kind: 'lead', number: '', address: p, postcode: pc, arm: councilOf(pc), order: 99999, path: null, touched: null, recent: true, project: p })
  }
  // Arms: biggest council first; the home borough leads if present.
  const counts = new Map()
  for (const s of stars) counts.set(s.arm, (counts.get(s.arm) ?? 0) + 1)
  const arms = [...counts.entries()]
    .filter(([name, n]) => n >= ARM_MIN && name !== 'Unplaced')
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([name]) => name)
  const isArm = (s) => arms.includes(s.arm)
  const placed = [...layout(stars.filter(isArm), arms), ...haloLayout(stars.filter((s) => !isArm(s)))]
  const graph = {
    version: SCHEMA,
    generatedAt: new Date().toISOString(),
    arms: arms.map((name, i) => ({ name, colour: ARM_COLOURS[i % ARM_COLOURS.length], count: counts.get(name) })),
    halo: [...counts.entries()].filter(([name]) => !arms.includes(name)).map(([name, n]) => ({ name, count: n })),
    stars: placed,
    totals: { jobs: jobs.length, leads: stars.length - jobs.length, recent: stars.filter((s) => s.recent).length },
  }
  mkdirSync(DATA, { recursive: true })
  writeFileSync(CACHE, JSON.stringify(graph))
  return graph
}

// ---------------------------------------------------------------- satellites

/** What orbits one star: notes, current drawings/reports. Emails come separately (slower). */
export function satellitesOf(starId, graph) {
  const star = graph.stars.find((s) => s.id === starId || s.number === starId)
  if (!star) return null
  const out = { star: star.id, notes: [], files: [] }
  if (star.project) {
    const file = join(PROJECTS_DIR, star.project, 'PROJECT.md')
    if (existsSync(file)) {
      out.notes = parseNotes(readFileSync(file, 'utf8'))
        .filter((n) => !n.superseded)
        .slice(-24)
        .map((n, i) => ({ id: `note:${star.id}:${i}`, date: n.date ? fmtDate(n.date) : '', section: n.section, source: n.source, text: n.text.slice(0, 220) }))
    }
  }
  if (star.path) {
    out.files = jobFiles(star.path)
      .filter((f) => f.status === 'current' && ['drawing', 'calculations', 'report'].includes(f.kind))
      .sort((a, b) => b.modified - a.modified)
      .slice(0, 18)
      .map((f) => ({ id: `file:${f.path}`, name: f.name, kind: f.kind, stage: f.stage, revision: f.revision, date: fmtDate(f.modified), path: f.path }))
  }
  return out
}
