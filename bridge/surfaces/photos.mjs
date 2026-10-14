import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join, extname } from 'node:path'
import { listJobs, findJobs, nasReachable } from '../memory/jobs.mjs'
import { listProjects, PROJECTS_DIR } from '../research/projects.mjs'
import { findPostcode } from '../research/constraints.mjs'

/**
 * Site photos from Telegram, filed where Salman files them.
 *
 * Newer jobs (the template) keep them in
 *   <job>\03 Architect Hub\02 Photos - Videos\01 Existing | 02 During Construction | 03 Completed\01 Photo\01 Raw
 * (videos in ...\02 Video\01 Raw); older jobs in a top-level "05 - PHOTOS"
 * folder; a new lead with no NAS folder yet in its JARVIS project folder.
 *
 * This is the ONE place JARVIS writes to the NAS, and it only ever ADDS files
 * into a photos folder — never overwrites, renames or deletes. The model's
 * own tools stay blocked from the NAS by guard.mjs; this runs in the bridge.
 */

export const STAGES = {
  existing: { folder: '01 Existing', label: 'Existing' },
  construction: { folder: '02 During Construction', label: 'During Construction' },
  completed: { folder: '03 Completed', label: 'Completed' },
}

const STAGE_WORDS = [
  ['completed', /\b(complet\w*|finished|after|handover|hand-over|final|done)\b/i],
  ['existing', /\b(existing|survey\w*|before|measured|site visit|as existing|prior)\b/i],
  // Only words that can't describe a survey — "site", "roof" or "brick" could be either, so they ask.
  ['construction', /\b(construction|progress|during|inspection|steel\w*|foundations?|pour\w*|trench\w*|dpc|oversite|slab|lintel\w*|scaffold\w*|build(ing)? work|underpin\w*)\b/i],
]

/** 'existing' | 'construction' | 'completed' | null, from what Salman wrote. */
export function stageFrom(text) {
  const s = String(text ?? '')
  for (const [stage, re] of STAGE_WORDS) if (re.test(s)) return stage
  return null
}

const STOP = new Set(['road', 'rd', 'street', 'st', 'avenue', 'ave', 'close', 'lane', 'drive', 'gardens', 'way', 'london', 'the', 'photos', 'photo', 'pics', 'pictures', 'site', 'for', 'and', 'from', 'today', 'these', 'progress', 'existing', 'completed', 'construction', 'during', 'job', 'project', 'house'])
// Postcode halves ("tw4", "7bt") are not street words — "TW4" is half of Hounslow.
const POSTCODE_PART = /^([a-z]{1,2}\d[a-z\d]?|\d[a-z]{2})$/
const words = (s) =>
  String(s ?? '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter((w) => w.length >= 3 && !STOP.has(w) && !POSTCODE_PART.test(w))

/**
 * Which job the caption means: a job number (1110), a postcode, an address
 * ("27 Dawlish Drive") or a distinctive street word ("longmeadow"). Returns
 * { job } for a NAS job, { project } for a JARVIS-only project, { several } when
 * it is ambiguous, or {} when nothing matches. Never guesses between two.
 */
export function jobFrom(text, { jobs = null, projects = null } = {}) {
  const s = String(text ?? '')
  const all = jobs ?? (nasReachable() ? listJobs() : [])
  const num = /\b(1\d{3})\b/.exec(s)?.[1]
  if (num) {
    const hit = all.filter((j) => j.number === num)
    if (hit.length === 1) return { job: hit[0] }
    if (hit.length > 1) return { several: hit }
  }
  const pc = findPostcode(s)
  const projs = projects ?? listProjects()
  if (pc) {
    const hit = all.filter((j) => j.postcode === pc)
    if (hit.length === 1) return { job: hit[0] }
    // A postcode with no NAS job: a JARVIS project (a new lead) with that postcode.
    const p = projs.filter((name) => name.toUpperCase().includes(pc))
    if (!hit.length && p.length === 1) return { project: p[0] }
  }
  const byAddress = findJobs(s, all)
  if (byAddress.length === 1) return { job: byAddress[0] }
  // Distinctive street words: "longmeadow" is one job; "road" is every job.
  const w = words(s)
  if (w.length) {
    const scored = all
      .map((j) => ({ j, n: words(j.address).filter((x) => w.includes(x) && !/^\d+$/.test(x)).length }))
      .filter((x) => x.n > 0)
      .sort((a, b) => b.n - a.n)
    if (scored.length === 1 || (scored.length > 1 && scored[0].n > scored[1].n)) return { job: scored[0].j }
    if (scored.length > 1) return { several: scored.filter((x) => x.n === scored[0].n).map((x) => x.j).slice(0, 5) }
  }
  // A JARVIS project with no NAS folder yet (a new lead).
  const pm = projs.filter((p) => {
    const pw = words(p)
    return (pc && p.toUpperCase().includes(pc)) || w.some((x) => pw.includes(x) && !/^\d+$/.test(x))
  })
  if (pm.length === 1) return { project: pm[0] }
  if (pm.length > 1) return { several: pm.map((p) => ({ number: '', address: p })) }
  return {}
}

/** The folder a batch goes in. kind: 'photo' | 'video'. Pure except for existsSync/readdirSync. */
export function photoFolder(target, stage, kind = 'photo', when = new Date()) {
  const st = STAGES[stage] ?? STAGES.construction
  if (target.project) {
    return join(PROJECTS_DIR, target.project, 'Photos', st.label)
  }
  const job = target.job
  const hub = join(job.path, '03 Architect Hub', '02 Photos - Videos')
  if (existsSync(hub)) {
    return join(hub, st.folder, kind === 'video' ? '02 Video' : '01 Photo', '01 Raw')
  }
  // Older jobs: a top-level "05 - PHOTOS" (any number) — dated batch folder inside it.
  let older = null
  try {
    older = readdirSync(job.path).find((n) => /^\d+\s*-\s*photos?$/i.test(n.trim()))
  } catch {}
  if (older) return join(job.path, older, `${when.toISOString().slice(0, 10)} ${st.label}`)
  // No photos folder at all: make the template's.
  return join(hub, st.folder, kind === 'video' ? '02 Video' : '01 Photo', '01 Raw')
}

const stamp = (d) => {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}${p(d.getMinutes())}`
}

/**
 * Write a batch. items: [{ buffer, name?, ext, kind, date }]. Never overwrites:
 * a clash gets " (2)". Returns [{ path, kind }].
 */
export function fileBatch(target, stage, items, { dryRun = false } = {}) {
  const saved = []
  let seq = 0
  for (const it of items) {
    const dir = photoFolder(target, stage, it.kind, it.date)
    if (!dryRun) mkdirSync(dir, { recursive: true })
    seq++
    const base = it.name
      ? `${stamp(it.date)} ${it.name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/\.[^.]+$/, '')}`
      : `${stamp(it.date)} site ${it.kind} ${String(seq).padStart(2, '0')}`
    const ext = it.ext.startsWith('.') ? it.ext : `.${it.ext}`
    let path = join(dir, `${base}${ext}`)
    for (let i = 2; !dryRun && existsSync(path); i++) path = join(dir, `${base} (${i})${ext}`)
    if (!dryRun) writeFileSync(path, it.buffer, { flag: 'wx' })
    saved.push({ path, kind: it.kind })
  }
  return saved
}

export const targetLabel = (t) => (t.job ? `${t.job.number} ${t.job.address}` : t.project ?? '?')

/** What a Telegram message carries, if it is a photo or video. */
export function mediaIn(msg) {
  if (Array.isArray(msg?.photo) && msg.photo.length) {
    const big = msg.photo[msg.photo.length - 1]
    return { file_id: big.file_id, size: big.file_size, kind: 'photo', ext: '.jpg', name: null }
  }
  if (msg?.video) return { file_id: msg.video.file_id, size: msg.video.file_size, kind: 'video', ext: extname(msg.video.file_name ?? '') || '.mp4', name: msg.video.file_name ?? null }
  const d = msg?.document
  if (d && (/^image\//.test(d.mime_type ?? '') || /\.(jpe?g|png|heic|heif|webp|tiff?)$/i.test(d.file_name ?? ''))) {
    return { file_id: d.file_id, size: d.file_size, kind: 'photo', ext: extname(d.file_name ?? '') || '.jpg', name: d.file_name ?? null }
  }
  if (d && (/^video\//.test(d.mime_type ?? '') || /\.(mov|mp4|m4v)$/i.test(d.file_name ?? ''))) {
    return { file_id: d.file_id, size: d.file_size, kind: 'video', ext: extname(d.file_name ?? '') || '.mp4', name: d.file_name ?? null }
  }
  return null
}
