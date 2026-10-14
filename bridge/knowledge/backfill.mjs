import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { listJobs, nasReachable } from '../memory/jobs.mjs'
import { lessonMessage } from './approvals.mjs'

/**
 * The catch-up: background learner agents read each job's decision notices,
 * officer reports and appeal decisions off the NAS and record what happened.
 *
 * One JARVIS coordinates nothing here — this runner is plain code. It picks
 * the jobs (touched in the last two years, newest first), runs a few learner
 * sessions at a time, caps what each may cost and what the whole run may
 * cost, remembers what is done so it can resume, and sends Salman one
 * Telegram message per job: the outcomes recorded and the lessons proposed,
 * with the ids he approves by reply. Learner sessions are read-only apart
 * from the knowledge tools — the caller builds them that way.
 */

export const RECENT_DAYS = 730

export function recentJobs({ jobs = listJobs({ fresh: true }), now = Date.now(), days = RECENT_DAYS, touchedAt = defaultTouched } = {}) {
  const cutoff = now - days * 86400_000
  return jobs
    .map((j) => ({ ...j, touched: touchedAt(j) }))
    .filter((j) => j.touched > cutoff)
    .sort((a, b) => Number(b.number) - Number(a.number))
}

function defaultTouched(job) {
  let newest = 0
  try {
    for (const n of readdirSync(job.path)) {
      try {
        newest = Math.max(newest, statSync(join(job.path, n)).mtimeMs)
      } catch {}
    }
  } catch {}
  return newest
}

export function learnerPrompt(job) {
  return [
    `You are JARVIS's learner, working through one job in the background. Job ${job.number} — ${job.address}. Folder: ${job.path} (READ-ONLY; you cannot write there and must not try).`,
    '',
    'Goal: record what the council (and any inspector) actually decided on this job, and propose at most two lessons the practice should remember.',
    '',
    '1. FIND the decision documents. Use Glob under the job folder for *.pdf, *.docx and *.msg whose names contain any of: decision, notice, refus, grant, approv, permission, lawful, certificate, officer, delegated, report, appeal, prior approval. Look especially in "08 Local Authority", "06  PDF Documents\\01 Planning", "04 Previous Planning" and "02 Planning". Ignore drawings, calcs, invoices and photos. Read at most 12 documents.',
    '2. READ each with read_planning_document (PDFs). Never judge a document by its name.',
    '3. For EVERY application you find a decision for, call record_outcome with: council, reference (e.g. P/2011/3291 or 26/0772/FFU), projectType (house extension / loft conversion / flat conversion / garage conversion / new build house / new build flats / basement / new garage / other), proposal (one line), decision (approved, refused, withdrawn, split, appeal allowed, appeal dismissed, appeal part allowed, lawful, not lawful, prior approval granted/refused, pending), decisionDate (YYYY-MM-DD), policies (the policy codes the officer relied on), reasons (refusal reasons VERBATIM, or the key reasons for approval), conditions (short), appeal if any, sources (the file paths you read). Record pending applications too, with what is known.',
    '4. PROPOSE at most two lessons with propose_lesson — specific, actionable, in the practice\'s voice ("Hounslow corner plots: set two-storey side extensions 1 m back from the side boundary"), each with the refs it rests on. If the documents support no lesson, propose none.',
    '5. Reply with three short lines: documents read, outcomes recorded (reference → decision), lessons proposed (#ids). If there were no decision documents, say so and record nothing.',
    '',
    `Job number for the records: ${job.number}. Never invent a reference, date, policy or reason — leave a field empty rather than guess.`,
  ].join('\n')
}

/**
 * Run the catch-up. opts: { limit, concurrency, perJobBudget, totalBudget, makeLearner, notify, store, log }
 * makeLearner() → a session with ask(prompt) resolving { text, costUsd? }.
 */
export async function runBackfill({ store, makeLearner, notify, log = console.log, limit = 10, concurrency = 3, perJobBudget = 1.5, totalBudget = 40, jobs = null }) {
  if (!jobs && !nasReachable()) throw new Error('the NAS is not reachable')
  const state = store.state()
  const queue = (jobs ?? recentJobs()).filter((j) => !state.done[j.number]).slice(0, limit)
  const summary = { started: queue.length, finished: 0, failed: 0, outcomes: 0, lessons: 0, spent: state.spent ?? 0, stopped: '' }
  if (!queue.length) {
    await notify?.('Nothing left to learn from in the last two years, sir.')
    return summary
  }
  await notify?.(`Learning from ${queue.length} job(s), ${concurrency} at a time. One message per job as each is done; reply yes/no/edit to the lesson numbers.`, { silent: true })

  let i = 0
  const worker = async () => {
    while (i < queue.length) {
      if (summary.spent >= totalBudget) {
        summary.stopped = `budget of $${totalBudget} reached`
        return
      }
      const job = queue[i++]
      const before = { outcomes: store.outcomes({ job: job.number }).length, pending: store.pendingLessons().map((l) => l.id) }
      const session = makeLearner({ maxBudgetUsd: perJobBudget, job: job.number })
      try {
        log(`[jarvis:learn] ${job.number} ${job.address}`)
        const r = await session.ask(learnerPrompt(job))
        const cost = Number(r?.costUsd) || 0
        summary.spent += cost
        const recorded = store.outcomes({ job: job.number })
        // Only THIS job's lessons: with three learners running, "new since I
        // started" also catches what the other two proposed in the meantime.
        const newLessons = store.pendingLessons().filter((l) => !before.pending.includes(l.id) && String(l.job ?? '') === String(job.number))
        summary.outcomes += Math.max(0, recorded.length - before.outcomes)
        summary.lessons += newLessons.length
        summary.finished++
        const s = store.state()
        s.done[job.number] = { at: new Date().toISOString(), outcomes: recorded.length, lessons: newLessons.map((l) => l.id), cost }
        s.spent = (s.spent ?? 0) + cost
        store.saveState(s)
        const head = `${job.number} ${job.address}: ${recorded.length ? recorded.map((o) => `${o.reference} ${o.decision}`).join(', ') : 'no decisions found'}${cost ? ` ($${cost.toFixed(2)})` : ''}`
        const msg = newLessons.length ? `${head}\n${lessonMessage(newLessons, { job: job.number })}` : head
        await notify?.(msg, { silent: !newLessons.length })
      } catch (err) {
        summary.failed++
        log(`[jarvis:learn] ${job.number} failed: ${err.message}`)
        await notify?.(`${job.number} ${job.address}: could not be learned from — ${String(err.message).split('\n')[0]}`, { silent: true })
      } finally {
        session.close?.()
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker))
  await notify?.(
    `Catch-up done: ${summary.finished} job(s) read, ${summary.outcomes} outcome(s) recorded, ${summary.lessons} lesson(s) proposed, $${summary.spent.toFixed(2)} spent in total${summary.failed ? `, ${summary.failed} failed` : ''}${summary.stopped ? ` — stopped: ${summary.stopped}` : ''}.`,
  )
  return summary
}
