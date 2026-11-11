/**
 * Plancheck Recruitment inside JARVIS: the tools, the classifier for its
 * mailbox, and the brand guard. See store.mjs for the records and prompts.mjs
 * for what the model is told.
 */
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { KINDS, isPlancheckAccount, createPlancheckStore, PLANCHECK_ROOT } from './store.mjs'
import { seedTemplates, readTemplates, fillTemplate } from './templates.mjs'
import { searchPlan } from './prompts.mjs'

export { createPlancheckStore, isPlancheckAccount, PLANCHECK_ROOT } from './store.mjs'
export { PLANCHECK_PERSONA, plancheckMailPrompt, PLANCHECK_BACKLOG_STEPS, searchPlan } from './prompts.mjs'

/**
 * Every email to the Plancheck mailbox matters — it is a business inbox with
 * no clients to match against — so the SY classifier is wrong for it. Noise
 * is still noise; website forms and assessment results are leads; the rest
 * is important.
 */
const PC_NOISE = /\b(unsubscribe|newsletter|no-?reply@(?!plancheckrecruitment)|noreply@(?!plancheckrecruitment)|donotreply|marketing|promo|webinar|invoice ready|your order)\b/i
export function plancheckClassify({ from = '', subject = '', text = '' }) {
  const f = String(from).toLowerCase()
  const s = String(subject)
  if (/new candidate registration|new vacancy|assessment completed/i.test(s)) return { level: 'lead', why: ['plancheck', /assessment/i.test(s) ? 'assessment' : 'website form'] }
  if (PC_NOISE.test(f) || PC_NOISE.test(s)) return null
  if (/mailer-daemon|postmaster|delivery status|undeliver/i.test(`${f} ${s}`)) return { level: 'important', why: ['plancheck', 'bounce'] }
  if (/automatic reply|out of office|auto-?reply/i.test(s)) return { level: 'important', why: ['plancheck', 'auto-reply'] }
  if (/\b(stop|unsubscribe|remove me|do not contact|don't contact)\b/i.test(`${s} ${text.slice(0, 600)}`)) return { level: 'important', why: ['plancheck', 'opt-out'] }
  return { level: 'important', why: ['plancheck'] }
}

/** The brand guard the outbox applies to every held email. */
export function plancheckGate(entry, { store = null } = {}) {
  const pc = isPlancheckAccount(entry.account)
  const text = `${entry.subject ?? ''}\n${entry.text ?? ''}`
  if (!pc && /plancheck/i.test(text)) return 'Plancheck mail goes only from info@plancheckrecruitment.co.uk — never from an SY Design Studio address'
  if (pc) {
    if (/sy ?design ?studio|sydesignstudio|salman yousaf/i.test(text)) return 'a Plancheck email must not mention SY Design Studio or Salman\'s full name — the two businesses stay separate'
    if (store) {
      const b = (entry.to ?? []).map((t) => store.blocked({ email: t })).find(Boolean)
      if (b) return `${b.email || b.name} is on the Plancheck do-not-contact list${b.reason ? ` (${b.reason})` : ''}`
      const s = store.load()
      const held = (entry.pendingSameAccount ?? 0)
      if (store.sentToday() + held >= s.settings.dailyCap) return `Plancheck's cap of ${s.settings.dailyCap} emails a day is reached — the domain is new; the rest go tomorrow`
    }
  }
  return null
}

/** The Terms of Business file, if Salman has put one in PLANCHECK/files. */
export function termsFile(root = PLANCHECK_ROOT) {
  const dir = join(root, 'files')
  if (!existsSync(dir)) return null
  const walk = (d, depth = 0) => {
    let out = []
    for (const f of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, f.name)
      if (f.isDirectory() && depth < 3) out = out.concat(walk(p, depth + 1))
      else if (/terms[- ]of[- ]business/i.test(f.name) && /\.(pdf|docx)$/i.test(f.name) && !/draft|superseded/i.test(p)) out.push(p)
    }
    return out
  }
  const found = walk(dir).sort((a, b) => (a.endsWith('.pdf') ? -1 : 1) - (b.endsWith('.pdf') ? -1 : 1))
  return found[0] ?? null
}

const SEND_FIELDS = ['first_name', 'name', 'org', 'role', 'discipline', 'discipline_people', 'discipline_title', 'area', 'who', 'screening_line', 'closing_line', 'slot_1', 'slot_2', 'original_subject', 'sent_date', 'topic', 'employer_description', 'salary', 'location', 'assessment_link', 'feedback_line']

/**
 * The tools. `outbox` holds and sends; `accounts` tells us which mailbox is
 * Plancheck's; `openDashboard` puts the hub on screen (desk only).
 */
export function plancheckServer({ store, outbox = null, accounts = () => [], openDashboard = null, root = PLANCHECK_ROOT, notify = null } = {}) {
  const text = (t) => ({ content: [{ type: 'text', text: t }] })
  const fail = (t) => ({ isError: true, content: [{ type: 'text', text: t }] })
  const templatesDir = join(root, 'templates')
  seedTemplates(templatesDir)
  const plancheckAccount = () => accounts().find((a) => isPlancheckAccount(a.user)) ?? null

  const line = (kind, r) => {
    const who = kind === 'leads' ? `${r.org ?? ''} — ${r.role ?? ''}` : `${r.name ?? ''}${r.org ? ` (${r.org})` : ''}${r.title ? `, ${r.title}` : ''}`
    const extra = kind === 'leads' ? ` · ${r.discipline ?? ''}${r.closes ? ` · closes ${r.closes}` : ''}${r.priority ? ` · ${r.priority}` : ''}${r.agencies && r.agencies !== 'not stated' ? ` · agencies: ${r.agencies}` : ''}` : kind === 'candidates' ? ` · ${r.discipline ?? ''}${r.rbiClass ? ` ${r.rbiClass}` : ''}${r.location ? ` · ${r.location}` : ''}` : ` · ${r.sector ?? ''}${r.termsSignedAt ? ' · TERMS SIGNED' : ''}`
    const contact = r.email ? ` · ${r.email}` : r.contactEmail ? ` · ${r.contactEmail}` : ' · no email'
    const when = r.lastContactAt ? ` · emailed ${r.lastContactAt.slice(0, 10)}` : ''
    const chase = r.chaseOn && !r.repliedAt ? ` · chase from ${r.chaseOn}` : r.repliedAt ? ` · replied ${r.repliedAt.slice(0, 10)}` : ''
    return `${r.id} [${r.status}] ${who}${extra}${contact}${when}${chase}`
  }
  const record = z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))

  return createSdkMcpServer({
    name: 'jarvis_plancheck',
    version: '1.0.0',
    instructions: 'Plancheck Recruitment: the records (employers, candidates, leads, submissions), templated outreach held for approval, the compliance gates, and the weekly searches.',
    tools: [
      tool('plancheck_overview', 'How Plancheck stands: counts, this week against targets, chases due, deletions due, emails sent today against the cap.', {}, async () => {
        const o = store.overview()
        const c = o.counts
        return text(
          `Employers ${c.employers} (contacted ${c.employersContacted}, replied ${c.employersReplied}, terms signed ${c.termsSigned}) · Candidates ${c.candidates} (approached ${c.candidatesApproached}, registered ${c.candidatesRegistered}, ready ${c.candidatesReady}) · Open leads ${c.leadsOpen} · Submissions ${c.submissions} · Placed ${c.placed}\n` +
            `This week: ${o.thisWeek.employerEmails}/${o.thisWeek.targets.employerEmails} employer emails, ${o.thisWeek.candidateEmails}/${o.thisWeek.targets.candidateEmails} candidate emails · Sent today ${o.sentToday}/${o.settings.dailyCap} · Chases due ${o.chaseDue} · Due for deletion ${o.dueForDeletion} · Do-not-contact ${o.doNotContact}` +
            (plancheckAccount() ? '' : '\nThe Plancheck mailbox is NOT configured on this machine (MAIL_n_USER=info@plancheckrecruitment.co.uk in .env.local) — nothing can be sent until it is.'),
        )
      }),
      tool(
        'plancheck_list',
        'List records. kind = employers | candidates | leads | submissions. Filters: status, discipline, q (any text), open (true = not closed/placed/do-not-contact).',
        { kind: z.enum(KINDS), status: z.string().optional(), discipline: z.string().optional(), q: z.string().optional(), open: z.boolean().optional() },
        async ({ kind, ...f }) => {
          try {
            const rows = store.list(kind, f)
            return text(rows.length ? rows.map((r) => (kind === 'submissions' ? `${r.id} ${r.candidateId} → ${r.employerId} [${r.status}] ${r.at.slice(0, 10)}` : line(kind, r))).join('\n') : `No ${kind} match.`)
          } catch (err) {
            return fail(err.message)
          }
        },
      ),
      tool('plancheck_get', 'One record in full, with its history.', { kind: z.enum(KINDS), id: z.string() }, async ({ kind, id }) => {
        const r = store.get(kind, id)
        return r ? text(JSON.stringify(r, null, 1)) : fail(`No ${kind.slice(0, -1)} ${id}.`)
      }),
      tool(
        'plancheck_add',
        'Add a record. employers: name, title, org, email, phone, sector (council | approver | consultancy | practice | housebuilder), region, source. candidates: name, title, org (current employer), discipline (building control | planning | architecture), rbiClass, location, email, phone, contactType (work | personal), source, status (sourced by default; registered for a website registration). leads: org, role, discipline, level, salary, location, closes, url, contactName, contactEmail, contactPhone, agencies (no | yes | not stated), route, priority (A | B | C), source. Refuses duplicates and anyone on the do-not-contact list.',
        { kind: z.enum(['employers', 'candidates', 'leads']), fields: record, note: z.string().optional() },
        async ({ kind, fields, note }) => {
          const r = store.add(kind, { ...fields, ...(note ? { notes: note } : {}) }, { source: 'JARVIS' })
          return r.ok ? text(`Added ${line(kind, r.record)}`) : fail(`Not added: ${r.why}`)
        },
      ),
      tool('plancheck_update', 'Change fields on a record (status, email, salary, notes, closes, priority …). what = one line for the history.', { kind: z.enum(KINDS), id: z.string(), fields: record, what: z.string().optional() }, async ({ kind, id, fields, what }) => {
        const r = store.update(kind, id, fields, { source: 'JARVIS', what })
        return r.ok ? text(`${r.record.id}: ${r.changed.length ? `updated ${r.changed.join(', ')}` : 'nothing changed'}`) : fail(r.why)
      }),
      tool('plancheck_note', 'Add a dated line to a record\'s history — what they said, what was decided.', { kind: z.enum(KINDS), id: z.string(), text: z.string() }, async ({ kind, id, text: t }) => {
        const r = store.note(kind, id, t, 'JARVIS')
        return r.ok ? text(`Noted on ${r.record.id}.`) : fail(r.why)
      }),
      tool(
        'plancheck_templates',
        'The email templates (PLANCHECK/templates, Salman can edit them): list them, or read one with its placeholders.',
        { name: z.string().optional() },
        async ({ name }) => {
          const all = readTemplates(templatesDir)
          if (!name) return text(Object.entries(all).map(([k, t]) => `${k} — ${t.title}`).join('\n'))
          const t = all[name]
          if (!t) return fail(`No template "${name}". Have: ${Object.keys(all).join(', ')}`)
          const ph = [...new Set([...`${t.subject}\n${t.body}`.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((m) => m[1]))]
          return text(`${t.title}\nSubject: ${t.subject}\nPlaceholders: ${ph.join(', ')}\n\n${t.body}`)
        },
      ),
      tool(
        'plancheck_send',
        'Write to an employer, candidate or lead from a template and HOLD it in the outbox for Salman\'s "send N" — never sent directly. Fills the template from the record (first_name, org, role, discipline …) plus the values you pass; refuses if a placeholder is left unfilled, if the person is on the do-not-contact list, if it would be a second chase, or if today\'s cap is reached. attach_terms = true attaches the Terms of Business from PLANCHECK/files. Then logs the email against the record; the chase date is set when it actually goes.',
        {
          kind: z.enum(['employers', 'candidates', 'leads']),
          id: z.string(),
          template: z.string().describe('A template name from plancheck_templates, e.g. employer-vacancy-reply, candidate-approach, employer-follow-up.'),
          values: z.record(z.string(), z.string()).optional().describe(`Placeholder values. Known ones: ${SEND_FIELDS.join(', ')}.`),
          to: z.string().optional().describe('Override the recipient address (defaults to the record\'s email / contactEmail).'),
          attach_terms: z.boolean().optional(),
          reply_to_id: z.union([z.number(), z.string()]).optional().describe('The [id] of the email being answered, to keep the thread.'),
        },
        async ({ kind, id, template, values = {}, to, attach_terms = false, reply_to_id }) => {
          if (!outbox) return fail('Sending is not available in this session — do it at the desk.')
          const acct = plancheckAccount()
          if (!acct) return fail('The Plancheck mailbox is not configured on this machine. Salman adds MAIL_n_USER=info@plancheckrecruitment.co.uk, MAIL_n_PASSWORD, MAIL_n_HOST=imap.hostinger.com and MAIL_n_SMTP_HOST=smtp.hostinger.com to .env.local, then restarts.')
          const r = store.get(kind, id)
          if (!r) return fail(`No ${kind.slice(0, -1)} ${id}.`)
          const t = readTemplates(templatesDir)[template]
          if (!t) return fail(`No template "${template}". plancheck_templates lists them.`)
          const addr = to || r.email || r.contactEmail
          if (!addr) return fail(`${r.id} has no email address on file — only a published address may be used; never guess one.`)
          if (/chase|follow/i.test(template) && (r.chased ?? 0) >= 1) return fail(`${r.id} has already been chased once — one chase only, ever.`)
          if (/chase|follow/i.test(template) && r.repliedAt) return fail(`${r.id} replied on ${r.repliedAt.slice(0, 10)} — nothing to chase.`)
          const b = store.blocked({ email: addr, name: r.name })
          if (b) return fail(`Refused: ${addr} is on the do-not-contact list${b.reason ? ` (${b.reason})` : ''}.`)
          const first = (r.name ?? r.contactName ?? '').split(/\s+/)[0] || ''
          const disc = r.discipline ?? ''
          const defaults = {
            first_name: first,
            name: r.name ?? r.contactName ?? '',
            org: r.org ?? '',
            role: r.role ?? '',
            discipline: disc,
            discipline_people: disc === 'building control' ? 'registered inspectors' : disc === 'planning' ? 'planning officers' : disc === 'architecture' ? 'architects and technologists' : 'people',
            discipline_title: disc ? disc.charAt(0).toUpperCase() + disc.slice(1) : 'Built environment',
            screening_line: disc === 'building control' ? ' — a written assessment on the Approved Documents, and we check their RBI class on the BSR register' : disc === 'planning' ? ' — a structured technical conversation on casework, conditions and officer reporting' : disc === 'architecture' ? ' — ARB registration checked and a portfolio review' : '',
            closing_line: r.closes ? `I know the advert closes on ${r.closes}.` : '',
            location: r.location ?? '',
            salary: r.salary ?? '',
            area: r.location ?? r.region ?? 'London and the South East',
            original_subject: r.lastSubject ?? '',
            sent_date: r.lastContactAt ? new Date(r.lastContactAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'long' }) : '',
          }
          const filled = fillTemplate(t, { ...defaults, ...values })
          if (filled.missing.length) return fail(`Not sent — fill these placeholders first: ${filled.missing.join(', ')}. (Pass them in values.)`)
          const attachments = []
          if (attach_terms) {
            const f = termsFile(root)
            if (!f) return fail('No Terms of Business file found in PLANCHECK/files (a PDF or DOCX with "Terms of Business" in its name). Ask Salman to put it there.')
            attachments.push(f)
          }
          try {
            const entry = await outbox.queueSend({ account: acct.user, to: [addr], subject: filled.subject, text: filled.body, attachments, replyToId: reply_to_id })
            store.logContact(kind, id, { subject: entry.subject, template, outboxId: entry.id, account: acct.user, to: addr, sent: false }, 'JARVIS')
            store.update(kind, id, { lastSubject: entry.subject }, { source: 'JARVIS', what: '' })
            if (notify) await notify(`Plancheck · held email #${entry.id} to ${addr} — "${entry.subject}" (${template}). Say "send ${entry.id}" to send it.`, { silent: true })
            return text(`HELD as email #${entry.id} from ${acct.user} to ${addr} — "${entry.subject}" (${template}${attachments.length ? ', Terms of Business attached' : ''}). NOT sent yet: it goes when Salman says "send ${entry.id}". Logged against ${r.id}.`)
          } catch (err) {
            return fail(`Not queued: ${err.message}`)
          }
        },
      ),
      tool('plancheck_replied', 'They wrote back: the chase stops and the status moves on. summary = one line of what they said.', { kind: z.enum(['employers', 'candidates', 'leads']), id: z.string(), summary: z.string().optional() }, async ({ kind, id, summary }) => {
        const r = store.replied(kind, id, summary, 'JARVIS')
        return r.ok ? text(`${r.record.id} marked replied (${r.record.status}).`) : fail(r.why)
      }),
      tool('plancheck_do_not_contact', 'They asked not to be contacted: blocked from every future email, and their address kept only for that purpose.', { kind: z.enum(['employers', 'candidates', 'leads']), id: z.string(), reason: z.string().optional() }, async ({ kind, id, reason }) => {
        const r = store.doNotContact(kind, id, reason, 'JARVIS')
        return r.ok ? text(`${r.record.id} is now do-not-contact.`) : fail(r.why)
      }),
      tool('plancheck_chase_due', 'Who is due a follow-up today: contacted, no reply, five working days passed, not yet chased.', {}, async () => {
        const due = store.chaseDue()
        return text(due.length ? due.map((r) => line(r.kind, r)).join('\n') : 'Nobody is due a chase today.')
      }),
      tool('plancheck_terms_signed', 'An employer has agreed the Terms of Business in writing. how = where that is recorded (the email, its date).', { employerId: z.string(), how: z.string() }, async ({ employerId, how }) => {
        const r = store.update('employers', employerId, { termsSignedAt: new Date().toISOString(), termsHow: how, status: 'terms_signed' }, { source: 'JARVIS', what: `Terms of Business agreed — ${how}` })
        return r.ok ? text(`${r.record.id}: terms signed.`) : fail(r.why)
      }),
      tool('plancheck_agree', 'A candidate has said yes to being put forward to ONE named employer. how = the email and date.', { candidateId: z.string(), employerId: z.string(), how: z.string() }, async ({ candidateId, employerId, how }) => {
        const c = store.get('candidates', candidateId)
        const e = store.get('employers', employerId)
        if (!c || !e) return fail(`Unknown ${!c ? 'candidate' : 'employer'}.`)
        const agreed = [...(c.agreedEmployers ?? []), { employerId: e.id, at: new Date().toISOString(), how }]
        store.update('candidates', candidateId, { agreedEmployers: agreed }, { source: 'JARVIS', what: `Agreed to be put forward to ${e.org ?? e.name} — ${how}` })
        return text(`${c.id} agreed to ${e.id} (${e.org ?? e.name}).`)
      }),
      tool('plancheck_submit', 'Put a candidate forward to an employer. REFUSED unless the employer has signed the terms, the candidate has agreed to that employer, and the privacy notice went to the candidate. Records the submission; the CV itself goes by plancheck_send/send_email afterwards.', { candidateId: z.string(), employerId: z.string(), leadId: z.string().optional() }, async ({ candidateId, employerId, leadId }) => {
        const r = store.submit(candidateId, employerId, { leadId, source: 'JARVIS' })
        return r.ok ? text(`Submission ${r.record.id} recorded: ${candidateId} → ${employerId}. Now send the CV and screening report with send_email from the Plancheck account.`) : fail(`Refused: ${r.why}.`)
      }),
      tool('plancheck_terms_file', 'Where the Terms of Business file is (PLANCHECK/files), for attaching.', {}, async () => {
        const f = termsFile(root)
        return f ? text(f) : text('No Terms of Business file in PLANCHECK/files yet — ask Salman to copy it there (PDF or DOCX with "Terms of Business" in the name).')
      }),
      tool('plancheck_search_plan', 'The weekly search to carry out with WebSearch/WebFetch: what = leads (vacancies, Mondays) or candidates (Tuesdays). Returns the plan; you do the searching and record with plancheck_add.', { what: z.enum(['leads', 'candidates']) }, async ({ what }) => text(searchPlan(what))),
      ...(openDashboard
        ? [
            tool('plancheck_dashboard', 'Put the Plancheck hub on screen — this week, employers, candidates, leads, pipeline, chase, compliance.', {}, async () => {
              openDashboard()
              return text('The Plancheck hub is on screen.')
            }),
          ]
        : []),
    ],
  })
}
