import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { findPostcode } from './constraints.mjs'
import { PATHS } from '../paths.mjs'
import { findJobs, nasReachable } from '../memory/jobs.mjs'

/** The one NAS job this address points to, if exactly one does. */
function nasJob(address) {
  try {
    if (!nasReachable()) return null
    const hits = findJobs(address)
    return hits.length === 1 ? hits[0] : null
  } catch {
    return null
  }
}

/**
 * A folder per project, and one file in it that remembers.
 *
 *   D:\APP DEVLOPMENT\PROJECTS\57 The Grove TW7 4JD\
 *     PROJECT.md      what was found, what was decided, what was discussed
 *     documents\      officer reports and notices pulled from the register
 *     reports\        feasibility reports issued
 *
 * PROJECT.md is plain markdown so Salman can read and edit it, and every
 * research tool files what it found here as it goes.
 */

export const PROJECTS_DIR = PATHS.projects

export const SECTIONS = [
  'Summary',
  'Site and constraints',
  'Planning history',
  'Officer report findings',
  'Policy',
  'Precedents nearby',
  'Options and route',
  'Discussion and decisions',
  'Documents',
]

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const stamp = (d = new Date()) => `${String(d.getDate()).padStart(2, '0')} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`

/** "57 The Grove, Isleworth TW7 4JD" → "57 The Grove TW7 4JD". Windows-safe. */
export function projectName(address) {
  const pc = findPostcode(address)
  const first = String(address ?? '').split(',')[0].replace(/\b[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}\b/i, '').trim()
  return `${first}${pc ? ` ${pc}` : ''}`.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '').replace(/\s+/g, ' ').trim() || 'Unnamed project'
}

/** An existing project for this address, matched on house number and postcode. */
export function findProject(address, dir = PROJECTS_DIR) {
  if (!existsSync(dir)) return null
  const want = projectName(address).toLowerCase()
  const pc = (findPostcode(address) ?? '').toLowerCase()
  const num = /^\s*(\d+[a-z]?)\b/i.exec(address)?.[1]?.toLowerCase()
  const names = readdirSync(dir)
  for (const name of names) {
    const n = name.toLowerCase()
    if (n === want) return name
    if (pc && n.endsWith(pc) && (!num || n.startsWith(`${num} `))) return name
  }
  // No postcode given ("35 Cambridge Road, Hounslow" — how people say it on a
  // call): match number + street, but only if exactly one project fits, so
  // two Cambridge Roads in different towns are never confused.
  if (!pc && num) {
    const street = String(address).split(',')[0].replace(/\s+/g, ' ').trim().toLowerCase()
    const hits = names.filter((name) => {
      const n = name.toLowerCase()
      return n === street || n.startsWith(`${street} `)
    })
    if (hits.length === 1) return hits[0]
  }
  return null
}

export function template(address, name) {
  return [
    `# ${name}`,
    '',
    `Address: ${address}`,
    `Opened: ${stamp()}`,
    '',
    ...SECTIONS.flatMap((s) => [`## ${s}`, '']),
  ].join('\n')
}

/**
 * Pure: add a dated line under a section, creating the section if it is missing.
 * With a source the line reads "- 28 Sep 2026 · email from Navil Rahman (Surrey Heath): …",
 * so every fact in the file says where it came from.
 */
export function withNote(markdown, section, text, date = stamp(), { source = '' } = {}) {
  // The model often starts a note with the date itself; drop it so the line
  // doesn't read "28 Sep 2026: 28 Sep 2026: …". A leading date that is NOT
  // today's stamp is kept — it may be the date of the event being recorded.
  const body = String(text).replace(/\s+/g, ' ').trim()
  const lead = new RegExp(`^${date.replace(/\s+/g, '\\s+')}\\s*[:,.–—-]\\s*`, 'i')
  const src = String(source).replace(/[:\r\n]+/g, ' ').replace(/\s+/g, ' ').trim()
  const line = `- ${date}${src ? ` · ${src}` : ''}: ${body.replace(lead, '')}`
  const eol = markdown.includes('\r\n') ? '\r\n' : '\n'
  const lines = markdown.split(/\r?\n/)
  const at = lines.findIndex((l) => l.trim().toLowerCase() === `## ${section}`.toLowerCase())
  if (at === -1) return `${markdown.replace(/\s+$/, '')}${eol}${eol}## ${section}${eol}${eol}${line}${eol}`
  let end = at + 1
  while (end < lines.length && !/^#{1,6}\s/.test(lines[end])) end++
  let insert = end
  while (insert > at + 1 && lines[insert - 1].trim() === '') insert--
  if (insert === at + 1) lines.splice(at + 1, 0, '', line)
  else lines.splice(insert, 0, line)
  return lines.join(eol)
}

/**
 * Pure: mark the first live note containing `fragment` as superseded — kept,
 * never deleted, so the history still shows what was once agreed.
 * "- 01 Sep 2026: Fee £1,500" → "- 01 Sep 2026: [SUPERSEDED 28 Sep 2026 — by revised fee] Fee £1,500"
 */
export function supersede(markdown, fragment, date = stamp(), by = '') {
  const want = String(fragment).toLowerCase().trim()
  if (!want) return { markdown, found: null }
  const eol = markdown.includes('\r\n') ? '\r\n' : '\n'
  const lines = markdown.split(/\r?\n/)
  const i = lines.findIndex((l) => /^-\s+\d{1,2}\s+\w{3,4}\s+\d{4}/.test(l) && !/\[SUPERSEDED/i.test(l) && l.toLowerCase().includes(want))
  if (i === -1) return { markdown, found: null }
  const tag = `[SUPERSEDED ${date}${by ? ` — ${String(by).replace(/[\]\r\n]/g, ' ').trim()}` : ''}] `
  lines[i] = lines[i].replace(/^(-\s+\d{1,2}\s+\w{3,4}\s+\d{4}(?:\s*·[^:]*)?:\s*)/, `$1${tag}`)
  return { markdown: lines.join(eol), found: lines[i] }
}

export function openProject(address, { create = true, dir = PROJECTS_DIR, job: givenJob } = {}) {
  let name = findProject(address, dir)
  let job = null
  if (!name) {
    // A new project for a job that already has a NAS folder takes the job's
    // full address ("76 Longmeadow Frimely Camberley GU16 8RJ", not "76
    // Longmeadow") and records the link, so the two are always found together.
    job = givenJob === undefined ? nasJob(address) : givenJob
    const full = job ? job.address : address
    name = findProject(full, dir) ?? projectName(full)
    if (job) address = full
  }
  const folder = join(dir, name)
  const file = join(folder, 'PROJECT.md')
  if (!existsSync(file)) {
    if (!create) return null
    mkdirSync(join(folder, 'documents'), { recursive: true })
    mkdirSync(join(folder, 'reports'), { recursive: true })
    let md = template(address, name)
    if (job) md = md.replace(/^(Opened: .*)$/m, `$1\nJob: ${job.number} · NAS: ${job.path}`)
    writeFileSync(file, md, 'utf8')
  }
  return { name, folder, file, markdown: readFileSync(file, 'utf8') }
}

/**
 * opts: { dir, create, source, supersedes, date } — `supersedes` is a phrase
 * from an older note that this one replaces; that note is marked, not removed.
 */
export function addNote(address, section, text, opts = {}) {
  const p = openProject(address, opts)
  const date = opts.date ?? stamp()
  let md = p.markdown
  let replaced = null
  if (opts.supersedes) {
    const r = supersede(md, opts.supersedes, date, opts.source ? `by ${opts.source}` : 'by a later note')
    md = r.markdown
    replaced = r.found
  }
  const next = withNote(md, section, text, date, { source: opts.source })
  writeFileSync(`${p.file}.tmp`, next, 'utf8')
  renameSync(`${p.file}.tmp`, p.file)
  return { ...p, markdown: next, replaced }
}

export function listProjects(dir = PROJECTS_DIR) {
  if (!existsSync(dir)) return []
  return readdirSync(dir).filter((n) => existsSync(join(dir, n, 'PROJECT.md')))
}
