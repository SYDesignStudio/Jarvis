import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { WORK_ROOT } from '../paths.mjs'

/**
 * The planning tracker: every application Salman has in play, where it has got
 * to, and what has to happen next — by him, or by chasing someone.
 *
 * One JSON file, D:\APP DEVLOPMENT\TRACKER\applications.json. An application
 * is one record: what it is (site, council, type, client, job), its
 * references (the Planning Portal's PP-… and the council's own), its dates
 * (submitted → received → valid → target → decided), a list of actions, and a
 * dated history of where each fact came from.
 *
 * Two rules. A date is only ever one somebody stated: the Portal's email, the
 * council's letter, Salman. The one exception is a target the council has not
 * given, which is worked out from the statutory period and MARKED as worked
 * out (`targetBasis: 'calculated'`), the way APPLICATIONS.md writes "≈". And
 * nothing is deleted: a record can be closed, an action ticked, a date
 * replaced — the history keeps what it replaced and why.
 */

export const TRACKER_DIR = process.env.JARVIS_TRACKER_DIR ?? join(WORK_ROOT, 'TRACKER')

const DAY = 86400_000
const iso = (d) => (d instanceof Date && !Number.isNaN(d.getTime()) ? d.toISOString().slice(0, 10) : '')
const today = (now = new Date()) => iso(now)
const addDays = (date, n) => iso(new Date(new Date(`${date}T12:00:00Z`).getTime() + n * DAY))
export const daysBetween = (a, b) => Math.round((new Date(`${b}T12:00:00Z`) - new Date(`${a}T12:00:00Z`)) / DAY)

export const STATUSES = ['draft', 'submitted', 'received', 'invalid', 'valid', 'decided', 'withdrawn', 'closed']
const OPEN = new Set(['draft', 'submitted', 'received', 'invalid', 'valid'])

/** Any date a person or an email might write → yyyy-mm-dd, or ''. Never guesses a missing part. */
export function parseDate(s) {
  if (s instanceof Date) return iso(s)
  const t = String(s ?? '').trim()
  if (!t) return ''
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(t)
  if (m) return `${m[1]}-${m[2]}-${m[3]}`
  m = /\b(\d{1,2})[/.](\d{1,2})[/.](\d{4})\b/.exec(t) // UK order: 21/09/2026
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`
  m = /\b(\d{1,2})(?:st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?,?\s+(\d{4})\b/i.exec(t)
  if (m) {
    const mon = 'janfebmaraprmayjunjulaugsepoctnovdec'.indexOf(m[2].toLowerCase()) / 3 + 1
    return `${m[3]}-${String(mon).padStart(2, '0')}-${m[1].padStart(2, '0')}`
  }
  return ''
}

const POSTCODE = /\b([A-Z]{1,2}\d[A-Z\d]?)\s*(\d[A-Z]{2})\b/i
export const postcodeOf = (s) => {
  const m = POSTCODE.exec(String(s ?? ''))
  return m ? `${m[1].toUpperCase()} ${m[2].toUpperCase()}` : ''
}
const squash = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')
const refKey = (s) => squash(s)
/** "17, Saxon Avenue, Feltham, TW13 5JJ" and "17 Saxon Ave" → the same house. */
export const siteKey = (address) => {
  const a = String(address ?? '').toLowerCase().replace(POSTCODE, ' ').replace(/[,.]/g, ' ')
  const m = /(\d+[a-z]?)\s+([a-z][a-z' -]+?)\s+(road|rd|avenue|ave|street|st|lane|ln|close|cl|drive|dr|way|gardens|gdns|crescent|cres|place|pl|court|ct|grove|gr|terrace|hill|rise|walk|green|park|square|sq|row|mews|knoll|vale)\b/.exec(a)
  const short = { road: 'rd', avenue: 'ave', street: 'st', lane: 'ln', close: 'cl', drive: 'dr', gardens: 'gdns', crescent: 'cres', place: 'pl', court: 'ct', grove: 'gr', square: 'sq' }
  return m ? `${m[1]} ${m[2].trim()} ${short[m[3]] ?? m[3]}`.replace(/\s+/g, ' ') : squash(a).slice(0, 30)
}

/**
 * The statutory period for a type, in days, and where it runs from. Used ONLY
 * to work out a target the council has not stated — and the result is marked
 * as calculated. Larger-home prior approval runs 42 days from receipt; the
 * rest are 8 weeks from validation (13 for a major, which is never assumed).
 */
export function statutoryDays(type) {
  const t = String(type ?? '').toLowerCase()
  if (/prior approval.*larger home|larger home ext/.test(t)) return { days: 42, from: 'received' }
  if (/prior approval/.test(t)) return { days: 56, from: 'received' }
  if (/pre-?app|enforcement|building|initial notice|full plans/.test(t)) return null
  return { days: 56, from: 'valid' }
}

/** What this application needs, worked out from its dates and actions. Pure. */
export function flagsOf(app, now = new Date()) {
  const t = today(now)
  const out = []
  if (!OPEN.has(app.status)) return out
  const mine = (app.actions ?? []).filter((a) => !a.done)
  for (const a of mine) {
    const late = a.due && a.due < t
    out.push({ kind: 'action', tone: late ? 'fail' : 'hold', text: a.text, due: a.due || '', actionId: a.id, rank: late ? 0 : a.due ? 2 : 3 })
  }
  if (app.status === 'invalid') out.push({ kind: 'invalid', tone: 'fail', text: 'Invalid — the council needs something before it will register it', rank: 0 })
  if (app.snoozeUntil && app.snoozeUntil > t) return out.sort((a, b) => a.rank - b.rank)
  if (app.chaseOn && app.chaseOn <= t) out.push({ kind: 'chase', tone: 'hold', text: `Chase due${app.chaseNote ? ` — ${app.chaseNote}` : ''}`, rank: 1 })
  const sent = app.received || app.submitted
  if ((app.status === 'submitted' || app.status === 'received') && sent && !app.councilRef) {
    const waited = daysBetween(sent, t)
    if (waited >= 70) out.push({ kind: 'chase', tone: 'hold', text: `Nothing on record since it was submitted ${waited} days ago — check the council's register and record what happened`, rank: 1 })
    else if (waited >= 10) out.push({ kind: 'chase', tone: 'hold', text: `No validation after ${waited} days — chase the council for the reference and validation`, rank: 1 })
  }
  if (app.status === 'valid' && app.target && !app.noTarget) {
    const left = daysBetween(t, app.target)
    if (left < 0) out.push({ kind: 'overdue', tone: 'fail', text: `Decision overdue by ${-left} day${left === -1 ? '' : 's'} — chase the officer, or agree an extension of time`, rank: 0 })
    else if (left <= 7) out.push({ kind: 'due', tone: 'hold', text: left === 0 ? 'Decision due today' : `Decision due in ${left} day${left === 1 ? '' : 's'}`, rank: 2 })
  }
  return out.sort((a, b) => a.rank - b.rank)
}

/** Which of the dashboard's piles it sits in. */
export function bucketOf(app, now = new Date()) {
  if (!OPEN.has(app.status)) return 'done'
  const f = flagsOf(app, now)
  if (f.some((x) => x.kind === 'action' || x.kind === 'invalid')) return 'me'
  if (f.some((x) => x.kind === 'chase' || x.kind === 'overdue')) return 'chase'
  return app.status === 'valid' ? 'decision' : 'validation'
}

export function createTracker(dir = TRACKER_DIR, { now = () => new Date() } = {}) {
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'applications.json')
  const load = () => {
    if (!existsSync(file)) return { next: 1, apps: [] }
    try {
      return JSON.parse(readFileSync(file, 'utf8'))
    } catch (err) {
      // A file that will not parse is kept, not overwritten: it is the record.
      throw new Error(`the tracker file could not be read (${err.message}) — ${file}`)
    }
  }
  const save = (s) => {
    const tmp = `${file}.tmp`
    writeFileSync(tmp, JSON.stringify(s, null, 1))
    renameSync(tmp, file)
  }

  /** The record a reference, an address or an id points at — or null. */
  function find(s, q = {}) {
    if (q.id != null && q.id !== '') {
      const hit = s.apps.find((a) => a.id === Number(q.id))
      if (hit) return hit
    }
    for (const r of [q.ppRef, q.councilRef, q.ref].filter(Boolean)) {
      const k = refKey(r)
      const hit = s.apps.find((a) => (a.ppRef && refKey(a.ppRef) === k) || (a.councilRef && refKey(a.councilRef) === k) || (a.otherRefs ?? []).some((o) => refKey(o) === k))
      if (hit) return hit
    }
    return null
  }

  /** Open applications at an address — the fallback when a letter gives no reference we know. */
  function atSite(s, address, type = '') {
    const k = siteKey(address)
    const pc = postcodeOf(address)
    if (!k && !pc) return []
    const hits = s.apps.filter((a) => OPEN.has(a.status) && ((k && siteKey(a.address) === k) || (pc && postcodeOf(a.address) === pc && siteKey(a.address).split(' ')[0] === k.split(' ')[0])))
    const t = squash(type).slice(0, 8)
    const same = t ? hits.filter((a) => squash(a.type).includes(t)) : []
    return same.length ? same : hits
  }

  /** `when` is the date the thing happened (an email's own date), when that is not today. */
  function event(app, what, source, when = '') {
    app.events = [...(app.events ?? []), { at: when || today(now()), what, source: source || '' }].sort((a, b) => a.at.localeCompare(b.at)).slice(-60)
  }

  /**
   * Add an application, or bring an existing one up to date. `patch` holds only
   * what is now known; a field that changes is noted in the history with its
   * source. Matching: id, then any reference, then an open application at the
   * same address — and if two could match, it refuses rather than guesses.
   */
  function upsert(patch, { source = '', create = true, when = '' } = {}) {
    const s = load()
    let app = patch.mergeInto ? s.apps.find((a) => a.id === Number(patch.mergeInto)) ?? null : find(s, patch)
    // A new reference at a known address is a NEW application (a householder
    // and an LDC for the same house are two), so the address only matches
    // when the patch brings no reference of its own that says otherwise.
    const ownRef = patch.ppRef && !s.apps.some((a) => a.ppRef && refKey(a.ppRef) === refKey(patch.ppRef))
    if (!app && patch.address && !patch.forceNew && !ownRef) {
      const near = atSite(s, patch.address, patch.type)
      if (near.length === 1) app = near[0]
      else if (near.length > 1) {
        return { ok: false, why: `${near.length} open applications at that address (${near.map((a) => `#${a.id} ${a.type || a.ppRef || a.councilRef}`).join('; ')}) — say which by id or reference` }
      }
    }
    const isNew = !app
    if (isNew) {
      if (!create) return { ok: false, why: 'no application matches that reference or address' }
      if (!patch.address && !patch.ppRef && !patch.councilRef) return { ok: false, why: 'an application needs at least an address or a reference' }
      app = { id: s.next++, kind: 'planning', status: 'submitted', address: '', council: '', type: '', client: '', job: '', ppRef: '', councilRef: '', actions: [], events: [], createdAt: now().toISOString() }
      s.apps.push(app)
    }
    const changed = []
    const set = (k, v) => {
      if (v == null || v === '') return
      if (app[k] === v) return
      if (!isNew && app[k]) changed.push(`${k}: ${app[k]} → ${v}`)
      else changed.push(`${k}: ${v}`)
      app[k] = v
    }
    for (const k of ['kind', 'address', 'council', 'type', 'client', 'job', 'ppRef', 'councilRef', 'officer', 'officerEmail', 'fee', 'decision', 'note', 'chaseNote']) set(k, typeof patch[k] === 'string' ? patch[k].trim() : patch[k])
    for (const k of ['submitted', 'received', 'validated', 'target', 'decided', 'chaseOn', 'snoozeUntil']) {
      if (patch[k] === null) { if (app[k]) { changed.push(`${k} cleared`); app[k] = '' } continue }
      set(k, parseDate(patch[k]))
    }
    if (patch.target) app.targetBasis = patch.targetBasis === 'calculated' ? 'calculated' : 'council'
    if (patch.otherRef) app.otherRefs = [...new Set([...(app.otherRefs ?? []), String(patch.otherRef)])]
    if (app.address && !app.postcode) app.postcode = postcodeOf(app.address)

    // Status follows the dates unless it is said outright; it never goes backwards by inference.
    const order = ['draft', 'submitted', 'received', 'valid', 'decided']
    const inferred = app.decided || patch.decision ? 'decided' : app.validated ? 'valid' : app.received ? 'received' : app.submitted ? 'submitted' : app.status
    // A record Salman closed or withdrew stays that way until a DECISION arrives:
    // learning its validation date afterwards must not reopen it.
    const shut = app.status === 'closed' || app.status === 'withdrawn'
    if (patch.status && STATUSES.includes(patch.status)) set('status', patch.status)
    else if (shut) { if (patch.decision || patch.decided) set('status', 'decided') }
    else if (order.indexOf(inferred) > order.indexOf(app.status) && app.status !== 'invalid') set('status', inferred)
    else if (app.status === 'invalid' && (patch.validated || patch.decided)) set('status', inferred)

    // A target nobody has stated is worked out, and says so.
    if (patch.noTarget !== undefined) app.noTarget = Boolean(patch.noTarget)
    if (app.noTarget && app.targetBasis === 'calculated') { app.target = ''; app.targetBasis = '' }
    if (!app.noTarget && (!app.target || app.targetBasis === 'calculated')) {
      const rule = statutoryDays(app.type)
      const from = rule ? (rule.from === 'valid' ? app.validated : app.received || app.submitted) : ''
      if (rule && from) {
        const t = addDays(from, rule.days)
        if (app.target !== t) { app.target = t; app.targetBasis = 'calculated'; changed.push(`target ≈ ${t} (${rule.days} days from ${rule.from === 'valid' ? 'validation' : 'receipt'}, not stated by the council)`) }
      }
    }
    if (changed.length || isNew) event(app, patch.what || (isNew ? 'Added to the tracker' : changed.join('; ')), source, when)
    app.updatedAt = now().toISOString()
    save(s)
    return { ok: true, app, isNew, changed }
  }

  function addAction(q, { text, due = '', by = 'me' }, source = '', when = '') {
    const s = load()
    const app = find(s, q)
    if (!app) return { ok: false, why: 'no application matches' }
    const t = String(text ?? '').trim()
    if (t.length < 3) return { ok: false, why: 'the action needs saying' }
    const dup = (app.actions ?? []).find((a) => !a.done && squash(a.text) === squash(t))
    if (dup) return { ok: true, app, action: dup, already: true }
    const action = { id: (app.actions ?? []).reduce((n, a) => Math.max(n, a.id), 0) + 1, text: t, due: parseDate(due), by, done: false, addedAt: today(now()) }
    app.actions = [...(app.actions ?? []), action]
    event(app, `Action: ${t}${action.due ? ` (by ${action.due})` : ''}`, source, when)
    app.updatedAt = now().toISOString()
    save(s)
    return { ok: true, app, action }
  }

  function setAction(q, actionId, done = true, source = '', when = '') {
    const s = load()
    const app = find(s, q)
    const action = app?.actions?.find((a) => a.id === Number(actionId))
    if (!action) return { ok: false, why: 'no such action' }
    action.done = Boolean(done)
    action.doneAt = done ? today(now()) : ''
    event(app, `${done ? 'Done' : 'Reopened'}: ${action.text}`, source, when)
    app.updatedAt = now().toISOString()
    save(s)
    return { ok: true, app, action }
  }

  /** "Chased today": note it, and do not nag again for a week unless told otherwise. */
  function chased(q, { note = '', again = 7 } = {}, source = '') {
    const s = load()
    const app = find(s, q)
    if (!app) return { ok: false, why: 'no application matches' }
    const t = today(now())
    app.lastChased = t
    app.chaseOn = addDays(t, Math.max(1, Math.min(60, Number(again) || 7)))
    app.snoozeUntil = app.chaseOn
    event(app, `Chased${note ? ` — ${note}` : ''}; next look ${app.chaseOn}`, source)
    app.updatedAt = now().toISOString()
    save(s)
    return { ok: true, app }
  }

  function note(q, text, source = '') {
    const s = load()
    const app = find(s, q)
    if (!app) return { ok: false, why: 'no application matches' }
    event(app, String(text).trim().slice(0, 400), source)
    app.updatedAt = now().toISOString()
    save(s)
    return { ok: true, app }
  }

  /** Everything, each with its flags and bucket, most pressing first. */
  function list({ all = false } = {}) {
    const n = now()
    const rank = { me: 0, chase: 1, decision: 2, validation: 3, done: 4 }
    return load()
      .apps.filter((a) => all || OPEN.has(a.status) || (a.decided && daysBetween(a.decided, today(n)) <= 45))
      .map((a) => ({ ...a, flags: flagsOf(a, n), bucket: bucketOf(a, n) }))
      .sort((a, b) => rank[a.bucket] - rank[b.bucket] || (a.flags[0]?.rank ?? 9) - (b.flags[0]?.rank ?? 9) || String(a.target || '9').localeCompare(String(b.target || '9')) || b.id - a.id)
  }

  const get = (q) => {
    const app = find(load(), q)
    return app ? { ...app, flags: flagsOf(app, now()), bucket: bucketOf(app, now()) } : null
  }
  const lookup = (address, type) => atSite(load(), address, type)
  /** Everything at an address, open or not — for matching a decision to its submission. */
  const allAt = (address) => {
    const k = siteKey(address)
    return k ? load().apps.filter((a) => siteKey(a.address) === k) : []
  }

  /**
   * Two records that turn out to be one application (the Portal's submission
   * and the council's reference for it, entered separately). `keep` takes what
   * it lacks from `drop` — fields, actions, history — and `drop` is closed and
   * says where it went. Nothing is deleted.
   */
  function merge(keepId, dropId, source = '') {
    const s = load()
    const keep = s.apps.find((a) => a.id === Number(keepId))
    const drop = s.apps.find((a) => a.id === Number(dropId))
    if (!keep || !drop || keep === drop) return { ok: false, why: 'no such pair' }
    for (const k of ['council', 'type', 'client', 'job', 'ppRef', 'councilRef', 'officer', 'fee', 'submitted', 'received', 'validated', 'target', 'targetBasis', 'decided', 'decision', 'note']) {
      if (!keep[k] && drop[k]) keep[k] = drop[k]
    }
    const have = new Set((keep.actions ?? []).map((a) => squash(a.text)))
    let nextId = (keep.actions ?? []).reduce((n, a) => Math.max(n, a.id), 0)
    for (const a of drop.actions ?? []) if (!have.has(squash(a.text))) keep.actions = [...(keep.actions ?? []), { ...a, id: ++nextId }]
    keep.events = [...(keep.events ?? []), ...(drop.events ?? [])].sort((a, b) => a.at.localeCompare(b.at)).slice(-60)
    if (drop.status === 'decided' && keep.status !== 'decided') keep.status = 'decided'
    event(keep, `Merged with record #${drop.id} — the same application`, source)
    drop.mergedInto = keep.id
    drop.status = 'closed'
    // The duplicate gives up its references so a later letter finds the kept record.
    drop.otherRefs = [...new Set([...(drop.otherRefs ?? []), drop.councilRef, drop.ppRef].filter(Boolean))].map((r) => `was ${r}`)
    drop.councilRef = ''
    drop.ppRef = ''
    drop.actions = (drop.actions ?? []).map((a) => ({ ...a, done: true }))
    event(drop, `Duplicate of #${keep.id} — merged into it`, source)
    keep.updatedAt = drop.updatedAt = now().toISOString()
    save(s)
    return { ok: true, app: keep }
  }

  return { upsert, addAction, setAction, chased, note, list, get, lookup, allAt, merge, file }
}

// ------------------------------------------------------- Planning Portal mail

/** "Hounslow Council London Borough", "Brent London Borough", "Royal Borough of Kingston upon Thames" → the name he uses. */
export const councilName = (s) =>
  String(s ?? '')
    .replace(/\b(London Borough( of)?|Royal Borough of|Borough Council|City Council|District Council|County Council|Council)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()

const field = (text, label) => new RegExp(`${label}:\\s*([^\\n*]+?)\\s*(?=\\*|\\n|$)`, 'i').exec(text)?.[1]?.trim() ?? ''

/**
 * A Planning Portal notification → what it says, or null if it is not one.
 * These are machine-written and regular, so they are read here, exactly, and
 * no model is asked to interpret them. `text` is the plain-text body.
 */
export function parsePortalMail({ from = '', subject = '', text = '', date = null }) {
  if (!/notifications@planningportal\.co\.uk/i.test(from)) return null
  const body = String(text).replace(/\r/g, '')
  const ref = /\b(PP-\d{6,10})\b/.exec(`${subject} ${body}`)?.[1] ?? ''
  if (!ref) return null
  const council = (/submitted to ([^.\n]+?)\.\s/i.exec(body)?.[1] ?? /received by ([^.\n]+?) and they will/i.exec(body)?.[1] ?? /submitted to ([^.\n]+?)\.\s*When/i.exec(body.replace(/\n/g, ' '))?.[1] ?? '').replace(/\s+/g, ' ').trim()
  const base = {
    ppRef: ref,
    type: field(body, 'Application Type') || (/PP-\d+\s*-\s*(.+)$/.exec(subject)?.[1] ?? '').trim(),
    client: field(body, 'Applicant'),
    address: field(body, 'Application site address').replace(/^(\d+[a-z]?),\s+/i, '$1 '),
    council: councilName(council),
    fee: field(body, 'Application Fee'),
  }
  // The payment emails are prose, not a list: "Site Address: … Applicant Name: … Applicant email address:".
  const flat = body.replace(/\s+/g, ' ')
  if (!base.address) base.address = (/Site Address:\s*(.+?)\s+Applicant Name:/i.exec(flat)?.[1] ?? '').replace(/^(\d+[a-z]?),\s+/i, '$1 ')
  if (!base.client) base.client = /Applicant Name:\s*(.+?)\s+Applicant email/i.exec(flat)?.[1] ?? ''
  if (!base.fee) base.fee = /Application fee[^:]*:\s*(£[\d.,]+)/i.exec(flat)?.[1] ?? ''
  if (!base.council) base.council = councilName(/submitted to\s+([^.]+?)\.\s/i.exec(flat)?.[1] ?? /please contact\s+(.+?)\s+who will initiate/i.exec(flat)?.[1] ?? '')
  // "…with the reference PP-1 which refers to 115, Northumberland Crescent, Feltham, TW14 9SP using the Planning Portal"
  if (!base.address) base.address = (/which refers to\s+(.+?)\s+using the Planning Portal/i.exec(flat)?.[1] ?? '').replace(/^(\d+[a-z]?),\s+/i, '$1 ')
  if (!base.fee) base.fee = /Total amount:\s*(£[\d.,]+\d)/i.exec(flat)?.[1] ?? ''
  const sent = parseDate(field(body, 'Submission date')) || parseDate(date)
  if (/^Application Submitted/i.test(subject)) return { event: 'submitted', patch: { ...base, submitted: sent, what: `Submitted on the Planning Portal (${ref})` } }
  if (/update on your application/i.test(subject) && /has now been received by/i.test(body)) {
    return { event: 'received', patch: { ...base, submitted: sent, received: parseDate(field(body, 'Received date')) || parseDate(date), what: `Received by the council from the Portal (${ref}) — not yet validated` } }
  }
  if (/nominee has paid/i.test(subject)) return { event: 'paid', patch: { ...base, what: `Fee paid on the Portal by the applicant (${ref})` } }
  if (/nominated to pay/i.test(subject)) {
    // The person asked to pay is the client: "Dear Ying Ying Ng," / "Dear Mr Mohammed,".
    if (!base.client) base.client = (/^\s*Dear\s+([^,\n]{2,60}),/im.exec(body)?.[1] ?? '').trim()
  }
  if (/nominated to pay/i.test(subject)) return { event: 'awaiting-payment', patch: { ...base, status: 'draft', what: `Waiting for the applicant to pay the fee on the Portal (${ref})` } }
  return null
}

/** Apply one Portal email. Returns { ok, app, isNew, event } or null when it is not a Portal email. */
export function applyPortalMail(tracker, mail) {
  const p = parsePortalMail(mail)
  if (!p) return null
  const when = parseDate(mail.date)
  const source = `Planning Portal email${when ? `, ${when}` : ''}`
  // "Awaiting payment" must not drag a submitted application back to draft.
  const existing = tracker.get({ ppRef: p.patch.ppRef })
  const patch = { ...p.patch }
  if (existing && p.event === 'awaiting-payment') delete patch.status
  const r = tracker.upsert(patch, { source, when })
  if (r.ok && p.event === 'awaiting-payment' && r.isNew) tracker.addAction({ id: r.app.id }, { text: `Client to pay the fee on the Planning Portal (${patch.fee || 'fee'}) — chase if not paid`, by: 'client' }, source, when)
  if (r.ok && p.event === 'paid') {
    const open = (r.app.actions ?? []).find((a) => !a.done && /pay the fee/i.test(a.text))
    if (open) tracker.setAction({ id: r.app.id }, open.id, true, source, when)
  }
  return { ...r, event: p.event }
}
