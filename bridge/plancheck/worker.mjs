/**
 * The Plancheck agent: a background worker JARVIS hands long jobs to.
 *
 * A vacancy search takes ten or twenty minutes of searching and reading. Done
 * on the desk or Telegram session it would hold Salman's conversation for all
 * of that. So JARVIS delegates: the job goes on a queue here, a session of
 * its own runs it (web search, the Plancheck records, nothing else), one at a
 * time, and the report comes back to Salman's phone and to the desk when it is
 * done. JARVIS stays free, and can be asked "how is the agent getting on".
 *
 * Every job is kept in PLANCHECK/jobs.json: what was asked, when it ran, what
 * it cost, what it reported. The hub shows the last few.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { searchPlan } from './prompts.mjs'
import { PLANCHECK_ROOT } from './store.mjs'

export const WORKER_PROMPT = `You are the Plancheck agent: the background worker of Plancheck Recruitment Ltd, a
permanent-only recruitment agency for building control, planning and architecture
(London and the South East first), kept anonymous and apart from SY Design Studio.
You are given ONE job and you do it to the end, in this session, without asking
questions — if something is unclear, make the sensible choice and say so in the report.
You have web search, web fetch, reading, and the jarvis_plancheck tools (the records,
templated outreach that is only ever HELD for Salman, the gates). You never guess an
email address, never use LinkedIn or Indeed, never mention SY Design Studio, and never
add a person without a published contact detail. Record what you find as you go with
plancheck_add / plancheck_update, so nothing is lost if you run out of turns.
Your LAST message is the report Salman reads on his phone: plain text, short lines,
no markdown, what was found, what was recorded (with ids), what he should do next.`

const KINDS = {
  leads: { title: 'Vacancy leads search', prompt: () => searchPlan('leads') },
  candidates: { title: 'Candidate search', prompt: () => searchPlan('candidates') },
}

export function createWorker({ makeSession, root = PLANCHECK_ROOT, file = join(root, 'jobs.json'), notify = null, broadcast = null, now = () => new Date(), log = console.log, maxBudgetUsd = 4 } = {}) {
  mkdirSync(root, { recursive: true })
  let running = false

  function load() {
    try {
      return JSON.parse(readFileSync(file, 'utf8'))
    } catch {
      return { next: 1, jobs: [] }
    }
  }
  function save(s) {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(`${file}.tmp`, JSON.stringify(s, null, 2))
    renameSync(`${file}.tmp`, file)
  }
  const patch = (id, fields) => {
    const s = load()
    const j = s.jobs.find((x) => x.id === id)
    if (j) Object.assign(j, fields)
    save(s)
    return j
  }

  /** Put a job on the queue: a named search, or any task in words. Returns the job. */
  function enqueue({ kind = 'custom', instructions = '', title = '', by = 'JARVIS' } = {}) {
    const s = load()
    const k = KINDS[kind]
    if (!k && !instructions.trim()) throw new Error('a custom job needs instructions')
    const queuedAlready = s.jobs.find((j) => (j.status === 'queued' || j.status === 'running') && j.kind === kind && (kind !== 'custom' || j.instructions === instructions))
    if (queuedAlready) return { job: queuedAlready, duplicate: true }
    const job = {
      id: s.next++,
      kind,
      title: title || k?.title || instructions.slice(0, 60),
      instructions: instructions.trim(),
      prompt: (k ? k.prompt() : '') + (instructions.trim() ? `${k ? '\n\nALSO, from Salman: ' : 'JOB FROM SALMAN: '}${instructions.trim()}` : ''),
      by,
      status: 'queued',
      queuedAt: now().toISOString(),
      startedAt: null,
      finishedAt: null,
      report: '',
      costUsd: null,
      error: '',
    }
    s.jobs.push(job)
    s.jobs = s.jobs.slice(-60)
    save(s)
    log(`[jarvis:plancheck] agent job #${job.id} queued: ${job.title}`)
    setTimeout(() => void drain(), 50)
    return { job, duplicate: false }
  }

  async function drain() {
    if (running) return
    const next = load().jobs.find((j) => j.status === 'queued')
    if (!next) return
    running = true
    const job = patch(next.id, { status: 'running', startedAt: now().toISOString() })
    log(`[jarvis:plancheck] agent job #${job.id} running: ${job.title}`)
    let session = null
    try {
      session = makeSession('worker', { maxBudgetUsd })
      const { text, costUsd, ended } = await session.ask(job.prompt)
      const report = (text || '').trim() || '(no report)'
      patch(job.id, { status: 'done', finishedAt: now().toISOString(), report, costUsd: costUsd ?? null, error: ended ? `stopped early: ${ended}` : '' })
      log(`[jarvis:plancheck] agent job #${job.id} done${costUsd != null ? ` ($${costUsd.toFixed(2)})` : ''}`)
      await notify?.(`Plancheck agent — ${job.title} done${ended ? ' (stopped early)' : ''}:\n${report.slice(0, 3500)}`)
      broadcast?.({ type: 'say', text: `Sir, the Plancheck agent has finished the ${job.title.toLowerCase()}. The report is on your phone and in the hub.`, listen: false, drift: true })
      broadcast?.({ type: 'app', slug: 'plancheck-hub' })
    } catch (err) {
      patch(job.id, { status: 'failed', finishedAt: now().toISOString(), error: String(err?.message ?? err).slice(0, 300) })
      log(`[jarvis:plancheck] agent job #${job.id} failed: ${err.message}`)
      await notify?.(`Plancheck agent — ${job.title} failed: ${String(err?.message ?? err).slice(0, 200)}`)
    } finally {
      try {
        await session?.close?.()
      } catch {}
      running = false
      setTimeout(() => void drain(), 500)
    }
  }

  const list = (n = 12) => load().jobs.slice(-n).reverse()
  const status = () => {
    const jobs = load().jobs
    return { running: jobs.find((j) => j.status === 'running') ?? null, queued: jobs.filter((j) => j.status === 'queued'), recent: jobs.filter((j) => j.status === 'done' || j.status === 'failed').slice(-5).reverse() }
  }

  return { enqueue, list, status, drain, file }
}
