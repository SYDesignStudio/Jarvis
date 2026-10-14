import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { listJobs, findJobs, jobFiles, fmtDate, nasReachable, JOB_ROOTS } from './jobs.mjs'
import { findProject, PROJECTS_DIR } from '../research/projects.mjs'
import { findPostcode } from '../research/constraints.mjs'
import { searchMail } from '../mailtools.mjs'
import { accountsFromEnv } from '../surfaces/mail.mjs'
import { searchAll } from '../history.mjs'
import { JOBS_FILE } from '../paths.mjs'

/**
 * Project memory: one searchable history per property, every item with its
 * SOURCE and DATE, newest first, and drawings/documents marked current or
 * superseded with the evidence. Four places are searched:
 *
 *   notes   D:\APP DEVLOPMENT\PROJECTS\<project>\PROJECT.md   (JARVIS's own file)
 *   files   the NAS job folder (read-only)                     (drawings, calcs, reports, chats)
 *   email   every configured inbox, sent mail included         (headers)
 *   chats   Salman's past Claude Code conversations            (snippets)
 *
 * The point is that an old proposal can never quietly become the current
 * brief: everything comes back dated, sourced, and marked if superseded.
 */

const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, sept: 8, oct: 9, nov: 10, dec: 11 }

/** "- 28 Sep 2026 · source: text" / "- 28 Sep 2026: text" lines of a PROJECT.md, with section. */
export function parseNotes(markdown) {
  const out = []
  let section = ''
  for (const line of String(markdown).split(/\r?\n/)) {
    const h = /^##\s+(.+)$/.exec(line)
    if (h) {
      section = h[1].trim()
      continue
    }
    const m = /^-\s+(\d{1,2})\s+([A-Za-z]{3,4})\s+(\d{4})(?:\s*·\s*([^:]+?))?\s*:\s*(.+)$/.exec(line)
    if (!m) continue
    const month = MONTHS[m[2].toLowerCase()]
    const date = month == null ? null : new Date(Number(m[3]), month, Number(m[1]))
    const superseded = /^\[SUPERSEDED[^\]]*\]/i.test(m[5])
    out.push({ date, section, source: m[4]?.trim() || '', text: m[5].trim(), superseded })
  }
  return out
}

/**
 * Lines in JOBS.md that belong to this job — by job number, house number +
 * street, or postcode — from the Captured and Diary sections and the tables.
 */
export function jobActionsIn(markdown, keys) {
  const want = keys.filter(Boolean).map((k) => k.toLowerCase())
  if (!want.length) return []
  const out = []
  let section = ''
  for (const raw of String(markdown).split(/\r?\n/)) {
    const h = /^##\s+(.+)$/.exec(raw)
    if (h) {
      section = h[1].trim()
      continue
    }
    const l = raw.trim()
    if (!/^[-|*]/.test(l)) continue
    const lower = l.toLowerCase()
    if (!want.some((k) => new RegExp(`(^|[^a-z0-9])${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`).test(lower))) continue
    const m = /(\d{1,2})\s+([A-Za-z]{3,4})\s+(\d{4})/.exec(l)
    const month = m ? MONTHS[m[2].toLowerCase()] : null
    const done = /^[-*]\s*(✓|\[x\]|done\b)|\bDONE \d{1,2} [A-Za-z]{3}/i.test(l)
    out.push({ section, done, text: l.replace(/^[-*]\s*/, ''), date: month == null ? null : new Date(Number(m[3]), month, Number(m[1])) })
  }
  return out
}

function jobActions(job, projectName, query) {
  try {
    const md = readFileSync(JOBS_FILE, 'utf8')
    const addr = job?.address ?? projectName ?? query
    const street = String(addr).split(',')[0].replace(/\b[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}\b/i, '').trim().split(/\s+/).slice(0, 2).join(' ')
    return jobActionsIn(md, [job?.number && `job ${job.number}`, job?.number, street, job?.postcode ?? findPostcode(String(addr))])
  } catch {
    return []
  }
}

/** The job folder and the JARVIS project for a query ("1110", "76 Longmeadow", a postcode). */
export function resolveProject(query) {
  const jobs = nasReachable() ? findJobs(query) : []
  const job = jobs.length === 1 ? jobs[0] : null
  const projectName = findProject(query) ?? (job ? findProject(job.address) : null)
  return { job, candidates: jobs.length > 1 ? jobs : [], projectName }
}

const line = (d, what, detail) => `${d ? fmtDate(d) : 'undated'.padEnd(11)} · ${what} · ${detail}`

function drawingPackText(job, { stage = '', includeSuperseded = false, limit = 60 } = {}) {
  const files = jobFiles(job.path).filter((f) => ['drawing', 'calculations', 'report', 'model'].includes(f.kind))
  const wanted = files.filter((f) => (!stage || f.stage.toLowerCase().includes(stage.toLowerCase())) && (includeSuperseded || f.status === 'current'))
  const byStage = new Map()
  for (const f of wanted.sort((a, b) => b.modified - a.modified)) {
    const k = f.stage || 'Unsorted'
    if (!byStage.has(k)) byStage.set(k, [])
    byStage.get(k).push(f)
  }
  const superseded = files.filter((f) => f.status === 'superseded').length
  const parts = [`Job ${job.number} — ${job.address}\nFolder: ${job.path}`]
  let shown = 0
  for (const [k, list] of byStage) {
    parts.push(`\n${k}:`)
    for (const f of list) {
      if (shown++ >= limit) break
      parts.push(
        `  ${fmtDate(f.modified)} · ${f.status.toUpperCase()}${f.revision ? ` · REV ${f.revision}` : ''} · ${f.kind} · ${f.name}` +
          (f.why && f.status !== 'current' ? ` (${f.why})` : '') +
          `\n      ${f.rel}`,
      )
    }
  }
  if (!includeSuperseded && superseded) parts.push(`\n(${superseded} superseded file(s) hidden — ask with include_superseded to see them.)`)
  parts.push('\n"Current" is judged from revision letters, Superseded folders and dates — say so, and check with Salman before relying on it for an issue.')
  parts.push('To SHOW a drawing: blade tool, kind "document", url = the Folder above + "\\" + the file\'s path line, size "full".')
  return parts.join('\n')
}

export function memoryServer(env = process.env) {
  const accounts = () => accountsFromEnv(env).filter((a) => a.host)
  return createSdkMcpServer({
    name: 'jarvis_memory',
    version: '1.0.0',
    instructions:
      'Project memory. find_job locates the NAS job folder; drawing_pack lists the current drawings; project_search is the dated, ' +
      'sourced history of a property across notes, NAS files, email and past chats. Always cite source and date when you answer from it, ' +
      'and never present a superseded item as current. The NAS is read-only.',
    alwaysLoad: true,
    tools: [
      tool(
        'find_job',
        "Find Salman's job folder on the NAS by job number (\"1110\"), postcode or address. Returns the job number, address and folder. " +
          'Several matches means ask which one.',
        { query: z.string().min(2) },
        async (a) => {
          if (!nasReachable()) return { isError: true, content: [{ type: 'text', text: `The NAS is not reachable (${JOB_ROOTS.join('; ')}). Say so — is the NAS on?` }] }
          const hits = findJobs(a.query)
          if (!hits.length) return { content: [{ type: 'text', text: `No job folder matches "${a.query}" (${listJobs().length} jobs searched). It may be a new job with no NAS folder yet.` }] }
          return { content: [{ type: 'text', text: hits.slice(0, 8).map((j) => `${j.number} — ${j.address}\n  ${j.path}`).join('\n') }] }
        },
      ),
      tool(
        'drawing_pack',
        'The CURRENT drawing pack for a job, grouped by stage (Planning, Building Regulations, …), newest first, each with date, revision and path. ' +
          'Use before answering anything about drawings, before a council reply, or when asked "what is the latest …". stage filters (e.g. "planning").',
        {
          project: z.string().min(2),
          stage: z.string().optional().catch(undefined),
          include_superseded: z.boolean().optional().catch(undefined),
        },
        async (a) => {
          const { job, candidates } = resolveProject(a.project)
          if (!job) {
            const msg = candidates.length
              ? `Several jobs match: ${candidates.map((j) => `${j.number} ${j.address}`).join('; ')}. Ask which.`
              : `No NAS job folder found for "${a.project}".`
            return { content: [{ type: 'text', text: msg }] }
          }
          return { content: [{ type: 'text', text: drawingPackText(job, { stage: a.stage, includeSuperseded: a.include_superseded }) }] }
        },
      ),
      tool(
        'project_search',
        'The dated, sourced history of one property: JARVIS project notes, NAS files (drawings, calcs, reports, emails saved there, WhatsApp chats), ' +
          'emails in every inbox (sent included), and past conversations — Salman with you at the desk and on Telegram, and with Claude Code — newest first, each line "date · source · detail", superseded items marked. ' +
          'Pass the property (address, postcode or job number) and optionally what you are looking for ("steel calcs", "planning conditions", "fee"). ' +
          'Answer from it with the source and date of each fact; the newest instruction from Salman wins; never treat a superseded item as current.',
        {
          project: z.string().min(2),
          query: z.string().optional().catch(undefined),
          sources: z.array(z.enum(['notes', 'files', 'email', 'chats'])).optional().catch(undefined),
        },
        async (a) => {
          const want = new Set(a.sources?.length ? a.sources : ['notes', 'files', 'email', 'chats'])
          const { job, candidates, projectName } = resolveProject(a.project)
          const terms = String(a.query ?? '').toLowerCase().split(/\s+/).filter((t) => t.length > 1)
          const matches = (s) => !terms.length || terms.every((t) => String(s).toLowerCase().includes(t))
          const items = []
          const notes = []

          // 1. JARVIS's own project notes
          if (want.has('notes') && projectName) {
            const file = join(PROJECTS_DIR, projectName, 'PROJECT.md')
            if (existsSync(file)) {
              for (const n of parseNotes(readFileSync(file, 'utf8'))) {
                if (!matches(`${n.section} ${n.source} ${n.text}`)) continue
                items.push({ date: n.date, text: line(n.date, `NOTE${n.superseded ? ' (SUPERSEDED)' : ''} · ${n.section}${n.source ? ` · ${n.source}` : ''}`, n.text.slice(0, 400)) })
              }
            }
          } else if (want.has('notes')) notes.push('No JARVIS project file yet.')

          // 1b. Salman's open actions and diary entries for this job in JOBS.md —
          //     "what's still open" is answered from here as much as from the notes.
          if (want.has('notes')) {
            for (const act of jobActions(job, projectName, a.project)) {
              if (!matches(act.text)) continue
              items.push({ date: act.date, text: line(act.date, `${act.done ? 'DONE ' : 'OPEN '}ACTION in JOBS.md${act.section ? ` · ${act.section}` : ''}`, act.text.slice(0, 400)) })
            }
          }

          // 2. The NAS job folder
          if (want.has('files')) {
            if (job) {
              const files = jobFiles(job.path).filter((f) => matches(`${f.rel} ${f.kind} ${f.stage}`))
              const pick = terms.length ? files : files.filter((f) => f.status !== 'superseded')
              for (const f of pick.sort((x, y) => y.modified - x.modified).slice(0, terms.length ? 40 : 25)) {
                const st = f.status === 'dated' ? '' : ` (${f.status.toUpperCase()}${f.revision ? ` REV ${f.revision}` : ''}${f.status === 'superseded' && f.why ? ` — ${f.why}` : ''})`
                items.push({ date: f.modified, text: line(f.modified, `FILE ${f.kind}${st}${f.stage ? ` · ${f.stage}` : ''}`, `${f.name} — ${f.rel}`) })
              }
            } else if (candidates.length) notes.push(`Several NAS jobs match: ${candidates.map((j) => `${j.number} ${j.address}`).join('; ')} — ask which.`)
            else notes.push(nasReachable() ? 'No NAS job folder for this property.' : 'The NAS is not reachable.')
          }

          // 3. Email — by house number + street and by postcode
          if (want.has('email') && accounts().length) {
            const addr = job?.address ?? a.project
            const pc = job?.postcode ?? findPostcode(addr)
            const street = String(addr).split(',')[0].replace(/\b[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}\b/i, '').split(/\s+/).slice(0, 3).join(' ').trim()
            const q = [street && `"${street}"`, pc && `"${pc}"`].filter(Boolean).join(' OR ') + (terms.length ? ` ${terms.join(' ')}` : '')
            try {
              const { messages, errors } = await searchMail(accounts(), q, { max: 20 })
              for (const m of messages) items.push({ date: m.date, text: line(m.date, `EMAIL (${m.account})`, `from ${m.from} to ${m.to} — ${m.subject}`) })
              if (errors.length) notes.push(`Email not fully searched: ${errors.join('; ')}`)
            } catch (err) {
              notes.push(`Email search failed: ${err.message}`)
            }
          }

          // 4. Past conversations — Salman with JARVIS (desk, Telegram) and with Claude Code.
          //    Searched by house number + street, and again by job number, since
          //    he says "1110" as often as "Longmeadow".
          if (want.has('chats')) {
            const addr = job?.address ?? a.project
            const key = String(addr).split(',')[0].split(/\s+/).slice(0, 3).join(' ')
            const queries = [...new Set([key, job?.number && `job ${job.number}`].filter(Boolean))]
            const seen = new Set()
            for (const q of queries) {
              try {
                const { hits } = await searchAll(`${q} ${terms.join(' ')}`.trim(), { limit: 12, includeJarvis: true })
                for (const h of hits) {
                  const id = `${h.session.id}#${h.index}`
                  if (seen.has(id)) continue
                  seen.add(id)
                  const d = h.message.at ? new Date(h.message.at) : null
                  const who = h.message.role === 'you' ? 'Salman said' : h.session.jarvis ? 'JARVIS said' : 'Claude said'
                  items.push({ date: d, text: line(d, `CHAT ${h.session.jarvis ? 'with JARVIS' : 'with Claude Code'} · ${who}`, `${h.session.title ?? h.session.id}: ${h.snippet}`) })
                }
              } catch {}
            }
          }

          items.sort((x, y) => (y.date?.getTime?.() ?? 0) - (x.date?.getTime?.() ?? 0))
          const head = [
            `History for ${job ? `job ${job.number} — ${job.address}` : a.project}${projectName ? ` (notes: ${projectName})` : ''}${a.query ? `, matching "${a.query}"` : ''} — newest first:`,
            ...notes.map((n) => `(${n})`),
          ]
          const body = items.length ? items.slice(0, 80).map((i) => i.text).join('\n') : 'Nothing found.'
          return {
            content: [
              {
                type: 'text',
                text: `${head.join('\n')}\n${body}\n\nWhen you answer, give the source and date for each fact. Items marked SUPERSEDED are history, not the current position.`,
              },
            ],
          }
        },
      ),
    ],
  })
}
