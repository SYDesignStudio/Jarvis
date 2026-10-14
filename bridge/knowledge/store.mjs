import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { WORK_ROOT } from '../paths.mjs'

/**
 * What the practice has learned, on disk, readable by Salman.
 *
 *   KNOWLEDGE\
 *     outcomes.jsonl          one record per application — the ledger (facts)
 *     lessons-pending.jsonl   lessons proposed, waiting for Salman's yes on Telegram
 *     playbooks\<Council>.md  approved lessons, each citing its cases
 *     playbooks\types\<Project type>.md
 *     policy\<Council>\INDEX.md   policies with adopted / superseded dates
 *     predictions.jsonl       the route JARVIS recommended, to score against outcomes
 *
 * Facts (outcomes, predictions) are recorded straight away; lessons — the
 * generalisations — never reach a playbook without Salman's approval, and a
 * lesson from one case says so. Nothing here is ever deleted; corrections
 * are new records.
 */

export const KNOWLEDGE_DIR = process.env.JARVIS_KNOWLEDGE_DIR ?? join(WORK_ROOT, 'KNOWLEDGE')

const DECISIONS = ['approved', 'refused', 'withdrawn', 'split', 'appeal allowed', 'appeal dismissed', 'appeal part allowed', 'pending', 'lawful', 'not lawful', 'prior approval granted', 'prior approval refused', 'unknown']

// For file and folder names (a council's playbook). Never for a reference —
// "25/0941/FFU" is the council's reference and must survive verbatim.
const safe = (s) => String(s ?? '').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/\s+/g, ' ').trim()
const tidy = (s) => String(s ?? '').replace(/[\u0000-\u001f]/g, '').replace(/\s+/g, ' ').trim()
const readLines = (file) => (existsSync(file) ? readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)) : [])
const stamp = (d = new Date()) => d.toISOString()

export function createStore(root = KNOWLEDGE_DIR) {
  const files = {
    outcomes: join(root, 'outcomes.jsonl'),
    pending: join(root, 'lessons-pending.jsonl'),
    predictions: join(root, 'predictions.jsonl'),
    playbooks: join(root, 'playbooks'),
    policy: join(root, 'policy'),
    state: join(root, 'backfill-state.json'),
  }
  mkdirSync(join(files.playbooks, 'types'), { recursive: true })
  mkdirSync(files.policy, { recursive: true })

  // ---------------------------------------------------------------- outcomes

  // Matching is forgiving: "25/0941/FFU", "25_0941_FFU" and "25/0941/ffu" are one application.
  const key = (o) => `${tidy(o.council).toLowerCase()}|${tidy(o.reference).toLowerCase().replace(/[^a-z0-9]/g, '')}`

  /** Add or update one application's outcome. Later records win field by field; sources accumulate. */
  function recordOutcome(o) {
    if (!o?.council || !o?.reference) throw new Error('an outcome needs a council and a reference')
    const decision = DECISIONS.includes(String(o.decision ?? '').toLowerCase()) ? String(o.decision).toLowerCase() : 'unknown'
    const all = readLines(files.outcomes)
    const k = key(o)
    const prev = all.find((x) => key(x) === k)
    const rec = {
      ...(prev ?? {}),
      ...Object.fromEntries(Object.entries(o).filter(([, v]) => v != null && v !== '' && !(Array.isArray(v) && !v.length))),
      council: tidy(o.council),
      reference: tidy(o.reference),
      decision,
      sources: [...new Set([...(prev?.sources ?? []), ...(o.sources ?? [])])],
      reasons: o.reasons?.length ? o.reasons : (prev?.reasons ?? []),
      policies: [...new Set([...(prev?.policies ?? []), ...(o.policies ?? [])])],
      conditions: o.conditions?.length ? o.conditions : (prev?.conditions ?? []),
      recordedAt: prev?.recordedAt ?? stamp(),
      updatedAt: stamp(),
    }
    const next = prev ? all.map((x) => (key(x) === k ? rec : x)) : [...all, rec]
    writeFileSync(files.outcomes, next.map((x) => JSON.stringify(x)).join('\n') + '\n')
    return { record: rec, updated: Boolean(prev) }
  }

  function outcomes({ council, projectType, decision, job, query } = {}) {
    const q = String(query ?? '').toLowerCase()
    return readLines(files.outcomes).filter(
      (o) =>
        (!council || o.council.toLowerCase() === safe(council).toLowerCase()) &&
        (!projectType || String(o.projectType ?? '').toLowerCase().includes(String(projectType).toLowerCase())) &&
        (!decision || o.decision === String(decision).toLowerCase()) &&
        (!job || String(o.job ?? '') === String(job)) &&
        (!q || JSON.stringify(o).toLowerCase().includes(q)),
    )
  }

  // ---------------------------------------------------------------- lessons

  function nextLessonId() {
    const ids = [...readLines(files.pending), ...approvedLessons()].map((l) => Number(l.id) || 0)
    return (ids.length ? Math.max(...ids) : 0) + 1
  }

  /** A lesson waits here until Salman says yes. Returns the record with its id. */
  function proposeLesson({ council, projectType, lesson, refs = [], by = 'jarvis', job = '' }) {
    if (!lesson || (!council && !projectType)) throw new Error('a lesson needs wording and a council or project type')
    if (!refs.length) throw new Error('a lesson needs at least one case reference')
    const rec = { id: nextLessonId(), council: council ? safe(council) : '', projectType: projectType ? safe(projectType) : '', lesson: String(lesson).trim(), refs, cases: refs.length, by, job, proposedAt: stamp(), status: 'pending' }
    appendFileSync(files.pending, JSON.stringify(rec) + '\n')
    return rec
  }

  const pendingLessons = () => readLines(files.pending).filter((l) => l.status === 'pending')

  function playbookFile(council, projectType) {
    return council ? join(files.playbooks, `${safe(council)}.md`) : join(files.playbooks, 'types', `${safe(projectType)}.md`)
  }

  function approvedLessons() {
    const out = []
    const scan = (dir, kind) => {
      if (!existsSync(dir)) return
      for (const f of readdirSync(dir).filter((n) => n.endsWith('.md'))) {
        const name = f.replace(/\.md$/, '')
        for (const line of readFileSync(join(dir, f), 'utf8').split(/\r?\n/)) {
          const m = /^- \[#(\d+) · (\d+) cases?\] (.+?) — refs: (.+?) · approved (\S+)$/.exec(line)
          if (m) out.push({ id: Number(m[1]), cases: Number(m[2]), lesson: m[3], refs: m[4].split('; '), approvedAt: m[5], [kind]: name, status: 'approved' })
        }
      }
    }
    scan(files.playbooks, 'council')
    scan(join(files.playbooks, 'types'), 'projectType')
    return out
  }

  function decide(id, verdict, { text = '' } = {}) {
    const all = readLines(files.pending)
    const rec = all.find((l) => Number(l.id) === Number(id))
    if (!rec) return { error: `no pending lesson #${id}` }
    if (rec.status !== 'pending') return { error: `lesson #${id} was already ${rec.status}` }
    rec.status = verdict === 'no' ? 'rejected' : 'approved'
    rec.decidedAt = stamp()
    if (verdict === 'edit' && text) rec.lesson = String(text).trim()
    writeFileSync(files.pending, all.map((x) => JSON.stringify(x)).join('\n') + '\n')
    if (rec.status === 'approved') {
      const file = playbookFile(rec.council, rec.projectType)
      const head = `# ${rec.council || rec.projectType} — playbook\n\nApproved lessons, each citing its cases. A lesson from one case is one case.\n\n`
      const line = `- [#${rec.id} · ${rec.cases} case${rec.cases === 1 ? '' : 's'}] ${rec.lesson} — refs: ${rec.refs.join('; ')} · approved ${rec.decidedAt.slice(0, 10)}\n`
      if (!existsSync(file)) writeFileSync(file, head + line)
      else appendFileSync(file, line)
      rec.file = file
    }
    return { record: rec }
  }

  function playbook(council, projectType) {
    const file = playbookFile(council, projectType)
    return existsSync(file) ? readFileSync(file, 'utf8') : ''
  }

  // ---------------------------------------------------------------- policy

  function policyNote({ council, title, adopted = '', superseded = '', source = '', summary = '' }) {
    if (!council || !title) throw new Error('a policy note needs a council and a title')
    const dir = join(files.policy, safe(council))
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'INDEX.md')
    if (!existsSync(file)) writeFileSync(file, `# ${safe(council)} — policy library\n\n| Policy | Adopted | Superseded | Source | Notes |\n|---|---|---|---|---|\n`)
    // Table cells, not file names: a source URL keeps its slashes.
    const cell = (s) => tidy(s).replace(/\|/g, '/')
    appendFileSync(file, `| ${cell(title)} | ${cell(adopted)} | ${cell(superseded) || '—'} | ${cell(source)} | ${cell(summary)} |\n`)
    return file
  }

  const policies = (council) => {
    const file = join(files.policy, safe(council), 'INDEX.md')
    return existsSync(file) ? readFileSync(file, 'utf8') : ''
  }

  // ---------------------------------------------------------------- predictions

  function recordPrediction({ job, address, council, route, prospects, by = 'jarvis' }) {
    const rec = { job, address, council, route, prospects, by, at: stamp() }
    appendFileSync(files.predictions, JSON.stringify(rec) + '\n')
    return rec
  }
  const predictions = () => readLines(files.predictions)

  // ---------------------------------------------------------------- backfill state

  const state = () => (existsSync(files.state) ? JSON.parse(readFileSync(files.state, 'utf8')) : { done: {}, spent: 0 })
  const saveState = (s) => writeFileSync(files.state, JSON.stringify(s, null, 1))

  return { root, files, recordOutcome, outcomes, proposeLesson, pendingLessons, approvedLessons, decide, playbook, policyNote, policies, recordPrediction, predictions, state, saveState }
}
