import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { ImapFlow } from 'imapflow'
import { simpleParser } from 'mailparser'
import { applyPortalMail, daysBetween, parseDate, STATUSES } from './store.mjs'

/**
 * jarvis_tracker: the planning tracker's tools, its dashboard data, and the
 * two ways it fills itself — Planning Portal emails, read exactly by the
 * bridge the moment they arrive, and council letters, which JARVIS reads and
 * records with tracker_update while working the email.
 */

const ok = (text) => ({ content: [{ type: 'text', text }] })
const fail = (text) => ({ isError: true, content: [{ type: 'text', text }] })
const str = () => z.string().optional().catch(undefined)
const day = (d) => (d ? new Date(`${d}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '—')

const BUCKET = { me: 'NEEDS YOU', chase: 'TO CHASE', decision: 'AWAITING DECISION', validation: 'AWAITING VALIDATION', done: 'DECIDED / CLOSED' }

/** One application in a line or three, for JARVIS to speak from. */
export function appLine(a) {
  const refs = [a.councilRef, a.ppRef].filter(Boolean).join(' / ') || 'no reference yet'
  const dates = [a.submitted && `submitted ${day(a.submitted)}`, a.validated && `valid ${day(a.validated)}`, a.target && `target ${a.targetBasis === 'calculated' ? '≈ ' : ''}${day(a.target)}`, a.decided && `decided ${day(a.decided)}`].filter(Boolean).join(' · ')
  return [
    `[#${a.id}] ${a.address || '(no address)'} — ${a.council || 'council ?'} ${refs} — ${a.type || 'type ?'}${a.client ? ` — ${a.client}` : ''}${a.job ? ` — job ${a.job}` : ''}`,
    `     ${a.status.toUpperCase()}${a.decision ? `: ${a.decision}` : ''}${dates ? ` · ${dates}` : ''}${a.officer ? ` · officer ${a.officer}` : ''}`,
    ...(a.flags ?? []).map((f) => `     → ${f.kind === 'action' ? `ACTION${f.due ? ` by ${day(f.due)}` : ''}: ` : ''}${f.text}${f.actionId ? ` (action ${f.actionId})` : ''}`),
  ].join('\n')
}

export function trackerSummary(apps) {
  if (!apps.length) return 'The tracker is empty.'
  const out = []
  for (const b of ['me', 'chase', 'decision', 'validation', 'done']) {
    const rows = apps.filter((a) => a.bucket === b)
    if (!rows.length) continue
    out.push(`${BUCKET[b]} (${rows.length})`, ...rows.map(appLine), '')
  }
  return out.join('\n').trim()
}

/** Read the Planning Portal's notifications from the last N days and apply them, oldest first. */
export async function syncPortalMail(tracker, accounts, { days = 120, log = () => {} } = {}) {
  const found = []
  for (const acct of accounts.filter((a) => /gmail\.com$/i.test(a.host))) {
    const c = new ImapFlow({ host: acct.host, port: 993, secure: true, auth: { user: acct.user, pass: acct.password }, logger: false })
    try {
      await c.connect()
      const lock = await c.getMailboxLock('[Gmail]/All Mail')
      try {
        const uids = (await c.search({ gmraw: `from:notifications@planningportal.co.uk newer_than:${Math.max(1, Math.min(730, days))}d` }, { uid: true })) || []
        if (uids.length) {
          for await (const m of c.fetch(uids, { uid: true, envelope: true, source: true }, { uid: true })) {
            const p = await simpleParser(m.source).catch(() => null)
            found.push({ from: m.envelope?.from?.[0]?.address ?? '', subject: m.envelope?.subject ?? '', date: m.envelope?.date ?? null, text: p?.text ?? '' })
          }
        }
      } finally {
        lock.release()
      }
    } catch (err) {
      log(`[jarvis:tracker] ${acct.user}: ${err.message}`)
    } finally {
      await c.logout().catch(() => {})
    }
  }
  found.sort((a, b) => new Date(a.date ?? 0) - new Date(b.date ?? 0))
  const res = { read: found.length, applied: 0, added: 0, skipped: 0 }
  for (const mail of found) {
    const r = applyPortalMail(tracker, mail)
    if (!r) res.skipped++
    else if (r.ok) { res.applied++; if (r.isNew) res.added++ }
  }
  return res
}

/**
 * What the dashboard may do, from the page. Small on purpose: tick an action,
 * add one, note a chase, set a date, record a decision, close. Returns the
 * store's own answer.
 */
export function trackerAct(tracker, body) {
  const q = { id: body.id }
  const src = 'Salman, on the dashboard'
  switch (body.op) {
    case 'action_done': return tracker.setAction(q, body.actionId, body.done !== false, src)
    case 'action_add': return tracker.addAction(q, { text: body.text, due: body.due }, src)
    case 'chased': return tracker.chased(q, { note: body.note, again: body.again }, src)
    case 'note': return tracker.note(q, body.text, src)
    case 'update': {
      const allowed = {}
      for (const k of ['councilRef', 'officer', 'validated', 'target', 'decided', 'decision', 'status', 'chaseOn', 'client', 'job', 'type', 'council']) if (body[k] !== undefined) allowed[k] = body[k]
      if (allowed.target) allowed.targetBasis = 'council'
      if (allowed.status && !STATUSES.includes(allowed.status)) return { ok: false, why: 'no such status' }
      return tracker.upsert({ ...q, ...allowed, what: body.what }, { source: src, create: false })
    }
    case 'add': return tracker.upsert({ address: body.address, council: body.council, type: body.type, client: body.client, councilRef: body.councilRef, submitted: body.submitted, forceNew: true, what: 'Added by hand' }, { source: src })
  }
  return { ok: false, why: 'unknown operation' }
}

export function trackerServer({ tracker, accounts = () => [], openDashboard = null, changed = () => {}, log = console.log }) {
  const ref = { id: z.union([z.number(), z.string()]).optional().catch(undefined).describe('the [#id] from tracker_list'), ref: str().describe('a council reference or PP-… reference'), address: str() }
  const done = (r, say) => {
    if (!r.ok) return fail(`Not recorded: ${r.why}. Say so.`)
    changed()
    return ok(say(r))
  }
  return createSdkMcpServer({
    name: 'jarvis_tracker',
    version: '1.0.0',
    instructions:
      'The planning tracker: every application submitted, when it was validated, its target decision date, what to chase and what Salman must do. ' +
      'tracker_list before answering anything about where an application stands or what is due. tracker_update whenever a council email or letter gives a reference, a validation date, a target date, an officer or a decision.',
    alwaysLoad: true,
    tools: [
      tool(
        'tracker_list',
        'Every live planning application, most pressing first: what needs Salman, what to chase, what is awaiting decision or validation, with ids, references, dates and open actions. ' +
          'Use for "what applications are live", "what do I need to chase", "when is the Saxon Avenue decision due", "what needs doing". Pass find to narrow to an address, client or reference.',
        { find: str(), all: z.boolean().optional().catch(undefined).describe('true includes everything ever decided or closed') },
        async (a) => {
          let apps = tracker.list({ all: a.all === true })
          if (a.find) {
            const f = a.find.toLowerCase().replace(/[^a-z0-9 ]/g, '')
            apps = apps.filter((x) => `${x.address} ${x.client} ${x.council} ${x.councilRef} ${x.ppRef} ${x.job} ${x.type}`.toLowerCase().replace(/[^a-z0-9 ]/g, '').includes(f))
          }
          return ok(trackerSummary(apps))
        },
      ),
      tool(
        'tracker_update',
        'Add an application to the tracker, or bring one up to date. Pass what identifies it (id, a reference, or the address) and ONLY the facts you have read — never a guessed date. ' +
          'From a validation or acknowledgement letter: councilRef, validated, target (the determination / decision-due date the letter states), officer. From a decision: decided + decision. ' +
          'If the council says it is invalid: status "invalid" and a tracker_action for what they want. Dates as written ("17 November 2026", "17/11/2026"). ' +
          'source = where it came from ("validation letter from Hounslow, 28 Sep 2026"). If it says two applications could match, ask Salman which.',
        {
          ...ref,
          ppRef: str(), councilRef: str(), council: str(), type: str(), client: str(), job: str().describe('NAS job number'),
          officer: str(), fee: str(),
          submitted: str(), received: str(), validated: str(), target: str().describe('the decision-due date the COUNCIL states'), decided: str(),
          decision: str().describe('approved | refused | withdrawn | lawful | not lawful | prior approval granted/refused | split …'),
          status: z.enum(STATUSES).optional().catch(undefined),
          chaseOn: str().describe('when to chase next'),
          what: str().describe('one line for the history, e.g. "Validated; 8-week date 17 Nov"'),
          source: z.string().min(3),
        },
        async (a) => {
          const { source, ref: r, ...patch } = a
          return done(tracker.upsert({ ...patch, ...(r ? { ref: r } : {}), targetBasis: patch.target ? 'council' : undefined }, { source }), (x) => `${x.isNew ? 'Added' : 'Updated'} on the tracker:\n${appLine(tracker.get({ id: x.app.id }))}${x.changed.length ? `\nChanged: ${x.changed.join('; ')}` : ''}`)
        },
      ),
      tool(
        'tracker_action',
        'Put an action against an application — something Salman must do ("send current site photos to Hounslow"), with a due date if one was given. One action per thing. Not for chasing the council: that is worked out from the dates.',
        { ...ref, text: z.string().min(3), due: str(), source: str() },
        async (a) => done(tracker.addAction({ id: a.id, ref: a.ref, ...(a.address && !a.id && !a.ref ? { id: tracker.lookup(a.address)[0]?.id } : {}) }, { text: a.text, due: a.due }, a.source ?? ''), (x) => `${x.already ? 'Already on the list' : 'Action added'} for #${x.app.id} ${x.app.address}: ${x.action.text}${x.action.due ? ` (by ${day(x.action.due)})` : ''}`),
      ),
      tool(
        'tracker_done',
        'Tick an action off (action = its number from tracker_list), or note that an application has been chased (chased = true, with a note of who and how; it will not nag again for `again` days, default 7).',
        { ...ref, action: z.union([z.number(), z.string()]).optional().catch(undefined), chased: z.boolean().optional().catch(undefined), note: str(), again: z.union([z.number(), z.string()]).optional().catch(undefined) },
        async (a) => {
          const q = { id: a.id, ref: a.ref }
          if (a.chased) return done(tracker.chased(q, { note: a.note, again: a.again }, 'Salman, via JARVIS'), (x) => `Chase noted for #${x.app.id} ${x.app.address}; next look ${day(x.app.chaseOn)}.`)
          if (a.action == null) return fail('Say which action, or chased = true.')
          return done(tracker.setAction(q, a.action, true, 'Salman, via JARVIS'), (x) => `Done: ${x.action.text} (#${x.app.id} ${x.app.address}).`)
        },
      ),
      tool(
        'tracker_sync_portal',
        'Read the Planning Portal notification emails from the last N days (default 120) and bring the tracker up to date from them: submitted, received by the council, fee paid. Safe to run again — nothing is duplicated. Use when Salman says the tracker is missing a submission.',
        { days: z.union([z.number(), z.string()]).optional().catch(undefined) },
        async (a) => {
          try {
            const r = await syncPortalMail(tracker, accounts(), { days: Number(a.days) || 120, log })
            changed()
            return ok(`Read ${r.read} Planning Portal email(s): ${r.applied} applied, ${r.added} new application(s) added.`)
          } catch (err) {
            return fail(`Could not read the Portal emails: ${err.message}`)
          }
        },
      ),
      ...(openDashboard
        ? [
            tool('tracker_dashboard', 'Put the planning tracker on screen: what needs him, what to chase, every application with its dates and actions. Use for "show me the tracker", "bring up my applications", "what needs chasing" when he is at the desk.', {}, async () => {
              openDashboard()
              return ok('The planning tracker is on screen.')
            }),
          ]
        : []),
    ],
  })
}

/** One line for Telegram when the tracker changes by itself. */
export function portalLine(r) {
  const a = r.app
  const where = `${a.address}${a.council ? ` (${a.council})` : ''}`
  if (r.event === 'submitted') return `Tracker: ${where} — ${a.type} submitted, ${a.ppRef}.`
  if (r.event === 'received') return `Tracker: ${where} — received by the council, ${a.ppRef}. Waiting for validation.`
  if (r.event === 'paid') return `Tracker: ${where} — client has paid the Portal fee, ${a.ppRef}.`
  if (r.event === 'awaiting-payment') return `Tracker: ${where} — ${a.ppRef} is waiting for the client to pay the fee.`
  return ''
}

export { daysBetween, parseDate }
