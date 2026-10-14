import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { createStore } from './store.mjs'
import { lessonMessage } from './approvals.mjs'
import { runBackfill, recentJobs } from './backfill.mjs'

/**
 * jarvis_knowledge: what the practice has learned, and how it keeps learning.
 * Outcomes and predictions are facts and go straight in; lessons wait for
 * Salman's yes on Telegram. The catch-up runs in the background inside the
 * bridge with read-only learner sessions.
 */

const ok = (text) => ({ content: [{ type: 'text', text }] })
const fail = (text) => ({ isError: true, content: [{ type: 'text', text }] })
const str = () => z.string().optional().catch(undefined)
const list = () => z.array(z.string()).optional().catch(undefined)

// One catch-up at a time across every session (an SDK server instance can
// serve only one session, so each session gets its own instance of this).
let running = null

/**
 * A fresh instance per session — never share one between sessions.
 * opts.quiet — for the learner sessions: a proposed lesson is reported by the
 * catch-up runner in its per-job message, not one Telegram message each.
 */
export function knowledgeServer({ store = createStore(), notify = async () => false, makeLearner = null, quiet = false, job = null, log = console.log } = {}) {
  // A learner works one job; whatever it records belongs to that job even
  // when it forgets to say so (or names another).
  const stamp = (a) => (job ? { ...a, job: String(job) } : a)
  return createSdkMcpServer({
    name: 'jarvis_knowledge',
    version: '1.0.0',
    instructions:
      'The practice\'s learned knowledge. Before advising on a site or a route: playbook(council) and search_outcomes. ' +
      'When a decision arrives: record_outcome, then propose_lesson (Salman approves on Telegram). After recommending a route: record_prediction.',
    alwaysLoad: true,
    tools: [
      tool(
        'record_outcome',
        'Record what a council or inspector decided on an application — a FACT, recorded at once. Reasons verbatim. Pending applications too.',
        {
          council: z.string().min(2),
          reference: z.string().min(3),
          job: str().describe('Job number, e.g. 1110'),
          address: str(),
          projectType: str(),
          proposal: str(),
          decision: z.string().describe('approved | refused | withdrawn | split | appeal allowed | appeal dismissed | appeal part allowed | lawful | not lawful | prior approval granted | prior approval refused | pending'),
          decisionDate: str().describe('YYYY-MM-DD'),
          policies: list(),
          reasons: list().describe('refusal reasons verbatim, or the key reasons for approval'),
          conditions: list(),
          appeal: str().describe('e.g. "APP/F5540/D/12/2176220 — part allowed 2012-09-10"'),
          officer: str(),
          sources: list().describe('file paths or "email from X, date"'),
        },
        async (a) => {
          try {
            const r = store.recordOutcome({ ...stamp(a), by: 'jarvis' })
            return ok(`${r.updated ? 'Updated' : 'Recorded'}: ${r.record.council} ${r.record.reference} — ${r.record.decision}${r.record.decisionDate ? ` (${r.record.decisionDate})` : ''}.`)
          } catch (err) {
            return fail(`Not recorded: ${err.message}`)
          }
        },
      ),
      tool(
        'propose_lesson',
        'Propose a lesson for a council or project-type playbook. It is NOT added until Salman approves it on Telegram. Specific and actionable, with the case references it rests on.',
        { council: str(), projectType: str(), lesson: z.string().min(10), refs: z.array(z.string()).min(1), job: str() },
        async (a) => {
          try {
            const rec = store.proposeLesson(stamp(a))
            if (!quiet) await notify(lessonMessage([rec]))
            return ok(`Proposed as #${rec.id} (${rec.cases} case${rec.cases === 1 ? '' : 's'}) — waiting for Salman's approval.`)
          } catch (err) {
            return fail(`Not proposed: ${err.message}`)
          }
        },
      ),
      tool('playbook', 'The approved lessons for a council (or a project type). Read before advising.', { council: str(), projectType: str() }, async (a) => {
        const text = store.playbook(a.council, a.projectType)
        const pending = store.pendingLessons().filter((l) => (a.council && l.council === a.council) || (a.projectType && l.projectType === a.projectType))
        return ok((text || `No approved lessons yet for ${a.council || a.projectType} — no local track record on file.`) + (pending.length ? `\n\nAwaiting Salman's approval (not yet usable as a rule): ${pending.map((l) => `#${l.id} ${l.lesson}`).join('; ')}` : ''))
      }),
      tool(
        'search_outcomes',
        'What happened on past applications: by council, project type, decision, job or free text. Each record carries its sources.',
        { council: str(), projectType: str(), decision: str(), job: str(), query: str() },
        async (a) => {
          const rows = store.outcomes(a).slice(-40)
          if (!rows.length) return ok('No recorded outcomes match.')
          return ok(rows.map((o) => `${o.decisionDate ?? '—'} · ${o.council} ${o.reference} · ${o.projectType ?? ''} · ${o.decision}${o.job ? ` · job ${o.job}` : ''}\n   ${o.proposal ?? ''}${o.reasons?.length ? `\n   reasons: ${o.reasons.join(' | ').slice(0, 400)}` : ''}${o.policies?.length ? `\n   policies: ${o.policies.join(', ')}` : ''}\n   sources: ${(o.sources ?? []).join('; ').slice(0, 300)}`).join('\n'))
        },
      ),
      tool(
        'policy_note',
        'Add a policy, SPD or guidance document to a council\'s policy library, with adoption and superseded dates and where it came from.',
        { council: z.string().min(2), title: z.string().min(2), adopted: str(), superseded: str(), source: str(), summary: str() },
        async (a) => {
          try {
            return ok(`Noted in ${store.policyNote(a)}.`)
          } catch (err) {
            return fail(`Not noted: ${err.message}`)
          }
        },
      ),
      tool('policies', 'The policy library for a council, with dates — check a policy is current before citing it.', { council: z.string().min(2) }, async (a) =>
        ok(store.policies(a.council) || `No policies on file for ${a.council} yet.`),
      ),
      tool(
        'record_prediction',
        'Record the route you recommended for a job (PD, householder, pre-app first…) and your view of its prospects, so outcomes can be scored against it later.',
        { job: str(), address: z.string().min(3), council: str(), route: z.string().min(3), prospects: str() },
        async (a) => {
          store.recordPrediction(a)
          return ok(`Recorded: ${a.address} — ${a.route}${a.prospects ? ` (${a.prospects})` : ''}. The outcome will be scored against it.`)
        },
      ),
      tool(
        'start_learning_catchup',
        'Start (or resume) the background catch-up: learner agents read decision documents off the NAS for jobs touched in the last two years, newest first, and message Salman per job. Only when Salman asks.',
        { limit: z.union([z.number(), z.string()]).optional().catch(undefined), concurrency: z.union([z.number(), z.string()]).optional().catch(undefined), total_budget_usd: z.union([z.number(), z.string()]).optional().catch(undefined) },
        async (a) => {
          if (!makeLearner) return fail('Learner sessions are not available on this surface.')
          if (running) return fail('The catch-up is already running.')
          const limit = Math.min(100, Math.max(1, Number(a.limit) || 10))
          const concurrency = Math.min(5, Math.max(1, Number(a.concurrency) || 3))
          const totalBudget = Math.max(1, Number(a.total_budget_usd) || 40)
          running = runBackfill({ store, makeLearner, notify, log, limit, concurrency, totalBudget })
            .catch((err) => log(`[jarvis:learn] ${err.message}`))
            .finally(() => (running = null))
          const done = Object.keys(store.state().done).length
          return ok(`Catch-up started: up to ${limit} job(s), ${concurrency} at a time, budget $${totalBudget}. ${done} already done. Progress comes to Telegram job by job.`)
        },
      ),
      tool('learning_status', 'How the knowledge base stands: outcomes, lessons approved and pending, jobs caught up, money spent.', {}, async () => {
        const s = store.state()
        const pend = store.pendingLessons()
        let recent = ''
        try {
          recent = ` of ${recentJobs().length} in the last two years`
        } catch {
          recent = ' (the NAS is not reachable to count the rest)'
        }
        return ok(
          `${store.outcomes().length} outcome(s) recorded · ${store.approvedLessons().length} lesson(s) approved · ${pend.length} awaiting approval${pend.length ? ` (#${pend.map((l) => l.id).join(', #')})` : ''} · ` +
            `${Object.keys(s.done).length} job(s) caught up${recent} · $${(s.spent ?? 0).toFixed(2)} spent${running ? ' · catch-up RUNNING' : ''}.`,
        )
      }),
    ],
  })
}
