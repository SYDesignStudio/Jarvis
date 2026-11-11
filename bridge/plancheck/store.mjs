/**
 * Plancheck Recruitment's records — the one master copy.
 *
 * Salman's second business: a permanent-only recruitment agency for building
 * control, planning and architecture, kept anonymous and apart from SY
 * Design Studio. Before this, the records were spreadsheets edited by hand,
 * by ChatGPT and by a Mac app, and they overwrote one another. Now JARVIS
 * holds them in one JSON file in the shared work folder (so the PC and the
 * Mac see the same), with a history on every record and nothing deleted —
 * closed, not removed — because who was contacted, when and on what basis
 * is exactly what the ICO would ask for.
 *
 * Four kinds of record:
 *   employers   the people who hire — heads of service, directors, managers
 *   candidates  surveyors, planners, architects (PC-0001, PC-0002 …)
 *   leads       live vacancies found on job boards, each a reason to write
 *   submissions a candidate put forward to an employer, with both consents
 * plus an outreach log (every email, by whom and from which template), a
 * do-not-contact list that is checked before anything goes out, and a few
 * settings (the daily sending cap, the chase interval).
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { WORK_ROOT } from '../paths.mjs'

export const PLANCHECK_ROOT = process.env.JARVIS_PLANCHECK_DIR ?? join(WORK_ROOT, 'PLANCHECK')
export const PLANCHECK_ACCOUNT = /@plancheckrecruitment\.co\.uk\s*>?$/i
export const isPlancheckAccount = (addr) => PLANCHECK_ACCOUNT.test(String(addr ?? '').trim())

export const KINDS = ['employers', 'candidates', 'leads', 'submissions']
export const EMPLOYER_STATUS = ['new', 'contacted', 'chased', 'replied', 'terms_sent', 'terms_signed', 'vacancy', 'closed', 'do_not_contact']
export const CANDIDATE_STATUS = ['sourced', 'approached', 'chased', 'replied', 'registered', 'call_booked', 'screened', 'ready', 'submitted', 'placed', 'not_interested', 'closed', 'do_not_contact']
export const LEAD_STATUS = ['new', 'contacted', 'watch', 'leave', 'closed']
export const DISCIPLINES = ['building control', 'planning', 'architecture']

const DAY = 86400_000
const EMPTY = () => ({
  version: 1,
  next: { employers: 1, candidates: 1, leads: 1, submissions: 1 },
  employers: [],
  candidates: [],
  leads: [],
  submissions: [],
  outreach: [],
  doNotContact: [],
  settings: { dailyCap: 15, chaseAfterWorkingDays: 5, deleteUnansweredAfterMonths: 6 },
})

/** Working days forward, Monday to Friday. */
export function addWorkingDays(from, n) {
  const d = new Date(from)
  let left = n
  while (left > 0) {
    d.setDate(d.getDate() + 1)
    if (d.getDay() !== 0 && d.getDay() !== 6) left--
  }
  return d
}

const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9@.]+/g, ' ').trim()
const emailOf = (s) => (String(s ?? '').match(/[\w.+-]+@[\w.-]+\.\w+/) ?? [''])[0].toLowerCase()

export function createPlancheckStore({ root = PLANCHECK_ROOT, file = join(root, 'plancheck.json'), now = () => new Date() } = {}) {
  mkdirSync(root, { recursive: true })
  for (const d of ['templates', 'files', 'exports']) mkdirSync(join(root, d), { recursive: true })

  function load() {
    try {
      const s = JSON.parse(readFileSync(file, 'utf8'))
      return { ...EMPTY(), ...s, next: { ...EMPTY().next, ...(s.next ?? {}) }, settings: { ...EMPTY().settings, ...(s.settings ?? {}) } }
    } catch {
      return EMPTY()
    }
  }
  function save(s) {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(`${file}.tmp`, JSON.stringify(s, null, 2))
    renameSync(`${file}.tmp`, file)
  }
  const stamp = () => now().toISOString()
  const idFor = (s, kind) => {
    const n = s.next[kind]++
    return kind === 'candidates' ? `PC-${String(n).padStart(4, '0')}` : `${{ employers: 'E', leads: 'L', submissions: 'S' }[kind]}${n}`
  }
  const event = (rec, what, source = '') => {
    rec.log = rec.log ?? []
    rec.log.push({ at: stamp(), what, ...(source ? { source } : {}) })
    rec.updatedAt = stamp()
  }
  const find = (s, kind, id) => {
    const q = String(id ?? '').trim().toUpperCase()
    return s[kind].find((r) => r.id.toUpperCase() === q) ?? null
  }

  /** The do-not-contact list, and anyone whose record says so. */
  function blocked(s, { email, name } = {}) {
    const e = emailOf(email)
    const n = norm(name)
    for (const d of s.doNotContact) {
      if (e && d.email && d.email === e) return d
      if (n && d.name && norm(d.name) === n) return d
    }
    for (const kind of ['employers', 'candidates']) {
      for (const r of s[kind]) {
        if (r.status === 'do_not_contact' && ((e && emailOf(r.email) === e) || (n && norm(r.name) === n))) return { email: r.email, name: r.name, reason: 'record marked do not contact' }
      }
    }
    return null
  }

  // ---------------------------------------------------------------- records

  function list(kind, { status, q, discipline, open = false } = {}) {
    const s = load()
    if (!KINDS.includes(kind)) throw new Error(`no such kind "${kind}" — ${KINDS.join(', ')}`)
    let rows = s[kind]
    if (status) rows = rows.filter((r) => r.status === status)
    if (discipline) rows = rows.filter((r) => norm(r.discipline) === norm(discipline))
    if (open) rows = rows.filter((r) => !['closed', 'leave', 'do_not_contact', 'not_interested', 'placed'].includes(r.status))
    if (q) {
      const needle = norm(q)
      rows = rows.filter((r) => norm(JSON.stringify(r)).includes(needle))
    }
    return rows
  }

  function get(kind, id) {
    return find(load(), kind, id)
  }

  /** A duplicate is the same email, or the same name at the same organisation. */
  function duplicateOf(s, kind, rec) {
    const e = emailOf(rec.email)
    const n = norm(rec.name)
    const o = norm(rec.org)
    return s[kind].find((r) => (e && emailOf(r.email) === e) || (n && norm(r.name) === n && (!o || norm(r.org) === o))) ?? null
  }

  function add(kind, rec, { source = '' } = {}) {
    const s = load()
    if (!KINDS.includes(kind)) throw new Error(`no such kind "${kind}"`)
    if (kind !== 'leads' && kind !== 'submissions') {
      // Blocked first: someone who asked not to be contacted is never re-added, whatever name they come in under.
      const b = blocked(s, rec)
      if (b) return { ok: false, why: `on the do-not-contact list${b.reason ? ` (${b.reason})` : ''}` }
      const dup = duplicateOf(s, kind, rec)
      if (dup) return { ok: false, why: `already on file as ${dup.id} (${dup.name ?? dup.org})`, record: dup }
    }
    if (kind === 'leads') {
      const dup = s.leads.find((l) => (rec.url && l.url === rec.url) || (norm(l.org) === norm(rec.org) && norm(l.role) === norm(rec.role)))
      if (dup) return { ok: false, why: `already on file as ${dup.id} (${dup.org} — ${dup.role})`, record: dup }
    }
    const status = rec.status ?? (kind === 'employers' ? 'new' : kind === 'candidates' ? 'sourced' : kind === 'leads' ? 'new' : 'proposed')
    const record = { id: idFor(s, kind), ...rec, status, createdAt: stamp(), updatedAt: stamp(), log: [] }
    if (kind === 'leads') record.foundAt = record.foundAt ?? stamp().slice(0, 10)
    event(record, `Added${rec.source ? ` from ${rec.source}` : ''}`, source)
    s[kind].push(record)
    save(s)
    return { ok: true, record }
  }

  function update(kind, id, patch, { source = '', what = '' } = {}) {
    const s = load()
    const r = find(s, kind, id)
    if (!r) return { ok: false, why: `no ${kind.slice(0, -1)} ${id}` }
    const changed = []
    for (const [k, v] of Object.entries(patch ?? {})) {
      if (['id', 'log', 'createdAt'].includes(k) || v === undefined) continue
      if (JSON.stringify(r[k]) !== JSON.stringify(v)) {
        r[k] = v
        changed.push(k)
      }
    }
    if (changed.length) event(r, what || `Updated ${changed.join(', ')}`, source)
    save(s)
    return { ok: true, record: r, changed }
  }

  function note(kind, id, text, source = '') {
    const s = load()
    const r = find(s, kind, id)
    if (!r) return { ok: false, why: `no ${kind.slice(0, -1)} ${id}` }
    event(r, text, source)
    save(s)
    return { ok: true, record: r }
  }

  // ---------------------------------------------------------------- outreach

  /** An email went (or is held) to this record: the log entry the ICO would ask for, and the chase date. */
  function logContact(kind, id, { subject = '', template = '', outboxId = null, account = '', to = '', sent = true, _already = false } = {}, source = '') {
    const s = load()
    const r = find(s, kind, id)
    if (!r) return { ok: false, why: `no ${kind.slice(0, -1)} ${id}` }
    const at = stamp()
    if (!_already) s.outreach.push({ at, kind, id, to: to || r.email || '', subject, template, outboxId, account, sent })
    if (sent) {
      const first = !r.contactedAt
      r.contactedAt = r.contactedAt ?? at
      r.lastContactAt = at
      r.contacts = (r.contacts ?? 0) + 1
      r.chaseOn = addWorkingDays(now(), s.settings.chaseAfterWorkingDays).toISOString().slice(0, 10)
      if (kind === 'candidates' && first && r.status === 'sourced') r.status = 'approached'
      else if (kind === 'employers' && first && r.status === 'new') r.status = 'contacted'
      else if (kind === 'leads' && r.status === 'new') r.status = 'contacted'
      if (template && /chase|follow/i.test(template)) {
        r.chased = (r.chased ?? 0) + 1
        if (kind !== 'leads') r.status = 'chased'
        r.chaseOn = null
      }
      if (kind === 'candidates' && /approach|privacy/i.test(template + subject)) r.privacyNoticeSentAt = r.privacyNoticeSentAt ?? at
    }
    event(r, `${sent ? 'Emailed' : 'Email held'}${template ? ` (${template})` : ''}: ${subject}`, source)
    save(s)
    return { ok: true, record: r }
  }

  /** A held email went out: the log entry becomes a real contact, and the status and chase date follow. */
  function markSent(outboxId) {
    const s = load()
    const o = s.outreach.find((x) => x.outboxId === Number(outboxId) && !x.sent)
    if (!o) return { ok: false, why: `no held Plancheck email #${outboxId} in the log` }
    o.sent = true
    o.at = stamp()
    save(s)
    return logContact(o.kind, o.id, { subject: o.subject, template: o.template, outboxId: o.outboxId, account: o.account, to: o.to, sent: true, _already: true }, 'outbox')
  }

  /** They wrote back: no more chasing, status moves on, their words kept. */
  function replied(kind, id, summary = '', source = '') {
    const s = load()
    const r = find(s, kind, id)
    if (!r) return { ok: false, why: `no ${kind.slice(0, -1)} ${id}` }
    r.repliedAt = stamp()
    r.chaseOn = null
    if (['new', 'contacted', 'chased', 'sourced', 'approached'].includes(r.status)) r.status = 'replied'
    event(r, `Replied${summary ? `: ${summary}` : ''}`, source)
    save(s)
    return { ok: true, record: r }
  }

  function doNotContact(kind, id, reason = '', source = '') {
    const s = load()
    const r = find(s, kind, id)
    if (!r) return { ok: false, why: `no ${kind.slice(0, -1)} ${id}` }
    r.status = 'do_not_contact'
    r.chaseOn = null
    s.doNotContact.push({ email: emailOf(r.email), name: r.name ?? r.org ?? '', reason, at: stamp() })
    event(r, `Do not contact${reason ? `: ${reason}` : ''}`, source)
    save(s)
    return { ok: true, record: r }
  }

  /** Who is due a chase today: contacted, no reply, chase date passed, not yet chased. */
  function chaseDue(at = now()) {
    const s = load()
    const today = at.toISOString().slice(0, 10)
    const due = []
    for (const kind of ['employers', 'candidates', 'leads']) {
      for (const r of s[kind]) {
        if (!r.chaseOn || r.chaseOn > today) continue
        if (r.repliedAt || (r.chased ?? 0) >= 1) continue
        if (['closed', 'leave', 'do_not_contact', 'not_interested', 'placed'].includes(r.status)) continue
        due.push({ kind, ...r })
      }
    }
    return due
  }

  /** Approached people who never replied: the privacy notice promises deletion at six months. */
  function dueForDeletion(at = now()) {
    const s = load()
    const cutoff = new Date(at.getTime() - s.settings.deleteUnansweredAfterMonths * 30.4 * DAY).toISOString()
    return s.candidates.filter((r) => ['sourced', 'approached', 'chased'].includes(r.status) && !r.repliedAt && (r.contactedAt ?? r.createdAt) < cutoff)
  }

  /** Emails that went out today from the Plancheck mailbox (sent, not held). */
  function sentToday(at = now()) {
    const day = at.toISOString().slice(0, 10)
    return load().outreach.filter((o) => o.sent && o.at.slice(0, 10) === day).length
  }

  // ---------------------------------------------------------------- submissions

  /** A CV goes to an employer only with signed terms and the candidate's yes to that employer. */
  function canSubmit(candidateId, employerId) {
    const s = load()
    const c = find(s, 'candidates', candidateId)
    const e = find(s, 'employers', employerId)
    if (!c) return { ok: false, why: `no candidate ${candidateId}` }
    if (!e) return { ok: false, why: `no employer ${employerId}` }
    const missing = []
    if (!e.termsSignedAt) missing.push(`${e.org ?? e.name} has not signed the Terms of Business`)
    if (!(c.agreedEmployers ?? []).some((a) => a.employerId === e.id)) missing.push(`${c.name} has not agreed to be put forward to ${e.org ?? e.name}`)
    if (!c.privacyNoticeSentAt) missing.push(`${c.name} has not been sent the privacy notice`)
    return missing.length ? { ok: false, why: missing.join('; '), candidate: c, employer: e } : { ok: true, candidate: c, employer: e }
  }

  function submit(candidateId, employerId, { leadId = null, source = '' } = {}) {
    const gate = canSubmit(candidateId, employerId)
    if (!gate.ok) return gate
    const s = load()
    const rec = { id: idFor(s, 'submissions'), candidateId: gate.candidate.id, employerId: gate.employer.id, leadId, at: stamp(), status: 'submitted', log: [] }
    event(rec, 'Submitted', source)
    s.submissions.push(rec)
    const c = find(s, 'candidates', candidateId)
    c.status = 'submitted'
    event(c, `Submitted to ${gate.employer.org ?? gate.employer.name}`, source)
    save(s)
    return { ok: true, record: rec }
  }

  // ---------------------------------------------------------------- the whole picture

  function overview(at = now()) {
    const s = load()
    const count = (kind, pred) => s[kind].filter(pred).length
    return {
      at: at.toISOString(),
      settings: s.settings,
      counts: {
        employers: s.employers.length,
        employersContacted: count('employers', (r) => r.contactedAt),
        employersReplied: count('employers', (r) => r.repliedAt),
        termsSigned: count('employers', (r) => r.termsSignedAt),
        candidates: s.candidates.length,
        candidatesApproached: count('candidates', (r) => r.contactedAt),
        candidatesRegistered: count('candidates', (r) => ['registered', 'call_booked', 'screened', 'ready', 'submitted', 'placed'].includes(r.status)),
        candidatesReady: count('candidates', (r) => ['ready', 'submitted'].includes(r.status)),
        leadsOpen: count('leads', (r) => ['new', 'contacted', 'watch'].includes(r.status)),
        submissions: s.submissions.length,
        placed: count('candidates', (r) => r.status === 'placed'),
      },
      sentToday: sentToday(at),
      chaseDue: chaseDue(at).length,
      dueForDeletion: dueForDeletion(at).length,
      doNotContact: s.doNotContact.length,
      thisWeek: weekTally(s, at),
    }
  }

  /** Sent emails this week by kind, against the targets the plan set. */
  function weekTally(s, at) {
    const d = new Date(at)
    const day = (d.getDay() + 6) % 7 // Monday = 0
    const monday = new Date(d.getFullYear(), d.getMonth(), d.getDate() - day).toISOString()
    const week = s.outreach.filter((o) => o.sent && o.at >= monday)
    return {
      employerEmails: week.filter((o) => o.kind === 'employers' || o.kind === 'leads').length,
      candidateEmails: week.filter((o) => o.kind === 'candidates').length,
      targets: { employerEmails: 25, candidateEmails: 20, calls: 5, screenings: 2 },
    }
  }

  /** Everything the dashboard shows, in one read. */
  function snapshot(at = now()) {
    const s = load()
    return {
      ...overview(at),
      employers: s.employers,
      candidates: s.candidates,
      leads: s.leads,
      submissions: s.submissions,
      chase: chaseDue(at),
      deletions: dueForDeletion(at).map((r) => ({ id: r.id, name: r.name, contactedAt: r.contactedAt ?? r.createdAt })),
      doNotContactList: s.doNotContact,
      outreach: s.outreach.slice(-200),
    }
  }

  return { root, file, list, get, add, update, note, logContact, markSent, replied, doNotContact, chaseDue, dueForDeletion, sentToday, canSubmit, submit, overview, snapshot, blocked: (who) => blocked(load(), who), load }
}
