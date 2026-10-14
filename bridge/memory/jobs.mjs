import { readdirSync, statSync, existsSync } from 'node:fs'
import { join, extname, basename, relative, sep } from 'node:path'
import { NAS_JOBS } from '../platform.mjs'
import { findPostcode } from '../research/constraints.mjs'

/**
 * Salman's job folders on the NAS — read-only, always.
 *
 *   \\192.168.0.105\salman_nas\My Work\02 - SY Design Studio\1100-1200's\1110 - 76 Longmeadow … GU16 8RJ
 *
 * A job is "<number> - <address>". Inside, the files that matter are rarely in
 * the tidy template folders; revisions live in the file names (REV A, REVC,
 * "very latest-REV D", RF NEWA PL …) and sometimes in Superseded folders. So
 * "current" is a judgement: a Superseded/Old folder is out; within a family of
 * files, the highest revision letter wins, then the newest date. Everything this
 * module says about currency carries the evidence (revision, date, path) so the
 * answer can show its working rather than assert.
 */

export const JOB_ROOTS = (process.env.JARVIS_JOB_ROOTS ?? `${join(NAS_JOBS, '1000-1100s Jobs')};${join(NAS_JOBS, "1100-1200's")}`)
  .split(';')
  .map((s) => s.trim())
  .filter(Boolean)

const JOB_DIR = /^(\d{3,4})\s*-\s*(.+)$/

/** "1110 - 76 Longmeadow Frimely Camberley GU16 8RJ" → { number, address, postcode } */
export function parseJobFolder(name) {
  const m = JOB_DIR.exec(name)
  if (!m) return null
  const address = m[2].replace(/\s+/g, ' ').trim()
  return { number: m[1], address, postcode: findPostcode(address), name }
}

let jobCache = { at: 0, jobs: [] }
/** Every job folder under the roots. Cached for five minutes (the NAS is slow). */
export function listJobs({ roots = JOB_ROOTS, fresh = false } = {}) {
  if (!fresh && Date.now() - jobCache.at < 5 * 60_000 && jobCache.jobs.length) return jobCache.jobs
  const jobs = []
  for (const root of roots) {
    let names = []
    try {
      names = readdirSync(root)
    } catch {
      continue
    }
    for (const name of names) {
      const j = parseJobFolder(name)
      if (j) jobs.push({ ...j, path: join(root, name) })
    }
  }
  jobCache = { at: Date.now(), jobs }
  return jobs
}

export const nasReachable = (roots = JOB_ROOTS) => roots.some((r) => existsSync(r))

const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()

/**
 * Jobs matching a job number ("1110"), a postcode, or an address ("76 Longmeadow").
 * Best first; several results means ask, not guess.
 */
export function findJobs(query, jobs = listJobs()) {
  const q = String(query ?? '').trim()
  if (!q) return []
  const num = /^\s*(\d{4})\s*$/.exec(q)?.[1]
  if (num) return jobs.filter((j) => j.number === num)
  const pc = findPostcode(q)
  if (pc) {
    const hits = jobs.filter((j) => j.postcode === pc)
    if (hits.length) return hits
  }
  const words = norm(q.replace(/\b[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}\b/i, ''))
    .split(' ')
    .filter((w) => w && !['road', 'rd', 'street', 'st', 'avenue', 'ave', 'london', 'the'].includes(w))
  if (!words.length) return []
  const houseNo = /^\d+[a-z]?$/.test(words[0]) ? words[0] : null
  return jobs
    .map((j) => {
      const a = ` ${norm(j.address)} `
      if (houseNo && !a.startsWith(` ${houseNo} `)) return null
      const got = words.filter((w) => a.includes(` ${w} `)).length
      return got >= Math.max(1, Math.ceil(words.length * 0.6)) ? { j, got } : null
    })
    .filter(Boolean)
    .sort((a, b) => b.got - a.got)
    .map((x) => x.j)
}

// ---------------------------------------------------------------- files

const SKIP = /^(thumbs\.db|desktop\.ini|\.ds_store)$|^~\$|\.(tmp|bak|dwl2?|lck)$/i
const REVIT_BACKUP = /\.\d{4}\.(rvt|rfa|rte)$/i

/** The revision a file name declares: "REV D", "REVC-…", "Rev_B", "REV2". */
export function revisionOf(name) {
  const m = /(?:^|[^a-z])rev(?:ision)?[\s._-]*([a-z](?![a-z])|\d{1,2}(?!\d))/i.exec(name)
  return m ? m[1].toUpperCase() : null
}

const revRank = (r) => (r == null ? -1 : /^\d+$/.test(r) ? Number(r) : r.charCodeAt(0) - 64)

/** A family key: the name with revision, copy and "latest" noise removed. */
export function familyOf(name) {
  return norm(
    basename(name, extname(name))
      .replace(/(?:^|[^a-z])rev(?:ision)?[\s._-]*([a-z](?![a-z])|\d{1,2}(?!\d))/gi, ' ')
      .replace(/\(\d+\)|\bcopy\b|\bvery latest\b|\blatest\b|\bfinal\b/gi, ' '),
  )
}

export function kindOf(rel) {
  const p = rel.toLowerCase()
  const ext = extname(p)
  // A drawing saved out of a WhatsApp chat is still a drawing (and is judged
  // for currency like any other); only the chat text itself is "whatsapp".
  if (/whatsapp/.test(p) && /_chat\.txt$|whatsapp chat.*\.txt$/.test(p)) return 'whatsapp chat'
  if (['.msg', '.eml'].includes(ext)) return 'email'
  if (['.jpg', '.jpeg', '.png', '.heic', '.webp'].includes(ext)) return 'photo'
  if (['.opus', '.m4a', '.mp3', '.wav', '.aac'].includes(ext)) return 'audio'
  if (['.rvt', '.rfa', '.pln', '.skp'].includes(ext)) return 'model'
  if (['.dwg', '.dxf'].includes(ext)) return 'drawing'
  if (/invoice/.test(p)) return 'invoice'
  if (/fee proposal|financials|proposal/.test(p)) return 'proposal'
  if (/calc/.test(p)) return 'calculations'
  if (/report|survey|statement|assessment|\bpra\b|bat |ecolog|arboric|flood|heritage/.test(p)) return 'report'
  if (ext === '.pdf') return 'drawing'
  if (['.doc', '.docx', '.txt', '.md', '.rtf'].includes(ext)) return 'document'
  if (['.xls', '.xlsx', '.csv'].includes(ext)) return 'spreadsheet'
  return 'other'
}

export function stageOf(rel) {
  const p = rel.toLowerCase()
  if (/building reg|building control|[\\/ ]br[\\/ ]|^br |\bbr \d/.test(p)) return 'Building Regulations'
  if (/planning|pre[\s-]?app|\bpp-|\bldc\b|lawful|prior approval/.test(p)) return 'Planning'
  if (/construction|tender|contractor/.test(p)) return 'Construction'
  if (/existing|survey|measured/.test(p)) return 'Existing / survey'
  return ''
}

const indexCache = new Map()
/** indexJob, remembered for ten minutes per job — a NAS walk takes seconds. */
export function jobFiles(jobPath, { fresh = false } = {}) {
  const hit = indexCache.get(jobPath)
  if (!fresh && hit && Date.now() - hit.at < 10 * 60_000) return hit.files
  const files = indexJob(jobPath)
  indexCache.set(jobPath, { at: Date.now(), files })
  return files
}

/** Walk one job folder. Returns file records with kind, stage, revision and family. */
export function indexJob(jobPath, { maxFiles = 5000 } = {}) {
  const out = []
  const walk = (dir) => {
    let names = []
    try {
      names = readdirSync(dir)
    } catch {
      return
    }
    for (const name of names) {
      if (out.length >= maxFiles) return
      const full = join(dir, name)
      let st
      try {
        st = statSync(full)
      } catch {
        continue
      }
      if (st.isDirectory()) {
        walk(full)
        continue
      }
      if (SKIP.test(name) || REVIT_BACKUP.test(name) || st.size === 0) continue
      const rel = relative(jobPath, full)
      out.push({
        path: full,
        rel,
        name,
        size: st.size,
        modified: st.mtime,
        kind: kindOf(rel),
        stage: stageOf(rel),
        revision: revisionOf(name),
        family: familyOf(name),
        inSuperseded: rel.split(sep).some((s) => /^(superseded|old|archive|previous)$/i.test(s.trim())),
      })
    }
  }
  walk(jobPath)
  return markCurrency(out)
}

/**
 * current | superseded, with the reason. Only drawings, calculations, reports,
 * proposals and documents are judged; photos and chat media are just dated.
 */
export function markCurrency(files) {
  const judged = new Set(['drawing', 'calculations', 'report', 'proposal', 'document', 'model'])
  const families = new Map()
  for (const f of files) {
    if (!judged.has(f.kind)) continue
    const k = `${f.kind}|${f.stage}|${f.family}|${extname(f.name).toLowerCase()}`
    if (!families.has(k)) families.set(k, [])
    families.get(k).push(f)
  }
  for (const f of files) {
    if (!judged.has(f.kind)) {
      f.status = 'dated'
      continue
    }
    if (f.inSuperseded) {
      f.status = 'superseded'
      f.why = 'in a Superseded folder'
    }
  }
  // Sheets of a set ("… 1 of 3") are often renamed between revisions
  // ("REVA-Proposed Steelwork Details 1 of 3" → "very latest-REV D 1 OF 3"):
  // same kind, stage and sheet number with a higher revision supersedes.
  const sheets = new Map()
  for (const f of files) {
    const sheet = /(\d+)\s*of\s*(\d+)/i.exec(f.name)
    if (!judged.has(f.kind) || !sheet || f.revision == null) continue
    const k = `${f.kind}|${f.stage}|${sheet[1]}of${sheet[2]}|${extname(f.name).toLowerCase()}`
    if (!sheets.has(k)) sheets.set(k, [])
    sheets.get(k).push(f)
  }
  for (const group of sheets.values()) {
    const top = Math.max(...group.map((f) => revRank(f.revision)))
    const best = group.find((f) => revRank(f.revision) === top)
    for (const f of group) {
      if (revRank(f.revision) < top && !f.status) {
        f.status = 'superseded'
        f.why = `sheet superseded by REV ${best.revision} (${best.name})`
      }
    }
  }

  for (const group of families.values()) {
    const live = group.filter((f) => !f.inSuperseded && f.status !== 'superseded')
    live.sort((a, b) => revRank(b.revision) - revRank(a.revision) || b.modified - a.modified)
    live.forEach((f, i) => {
      if (i === 0) {
        f.status = 'current'
        f.why = f.revision ? `highest revision (${f.revision})` : 'newest of its name'
      } else if (!f.status) {
        f.status = 'superseded'
        const top = live[0]
        f.why = top.revision && revRank(top.revision) > revRank(f.revision) ? `REV ${top.revision} exists` : `a newer copy exists (${fmtDate(top.modified)})`
      }
    })
  }
  return files
}

export const fmtDate = (d) =>
  d instanceof Date && !Number.isNaN(d.getTime()) ? d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : ''
