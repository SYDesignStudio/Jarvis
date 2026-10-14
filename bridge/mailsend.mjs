import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import nodemailer from 'nodemailer'
import { buildMessage, fileMessage, unfileMessage } from './maildraft.mjs'

/**
 * Sending from a mailbox Zapier does not reach (info@specline.co.uk, on
 * Hostinger) — over SMTP, with the password the inbox watcher already has.
 *
 * `queueSend` builds the finished email and HOLDS it: in the outbox here, and
 * as a copy in the mailbox's own Drafts folder, so Salman can read it in
 * webmail or on his phone like any draft. He is shown it on Telegram too.
 * It goes when HE says so — "send 3", "send 21-30" or "send all" typed on
 * Telegram (carried out by the bridge, no model in the loop), or told to
 * JARVIS at the desk ("send them"), which is the one session that never runs
 * a turn written by an incoming email. "cancel 3" drops it; anything
 * unanswered for a day expires. Sent, cancelled or expired, the Drafts copy
 * is taken away again so Drafts only ever shows what is still waiting.
 *
 * A revised email replaces the one it revises: held mail to the same people
 * with the same subject is superseded, so "send all" can never put three
 * versions of one email in somebody's inbox.
 *
 * Gmail accounts are refused here: those send through Zapier, as before.
 */

const TTL_MS = 24 * 60 * 60_000

/** imap.hostinger.com → smtp.hostinger.com, unless the account names its own. */
export const smtpHostOf = (acct) => acct.smtpHost || String(acct.host ?? '').replace(/^imap\./i, 'smtp.')

const bare = (s) => (/<([^>]+)>/.exec(s)?.[1] ?? String(s)).trim().toLowerCase()
const sameMail = (a, b) =>
  a.account === b.account &&
  a.subject.trim().toLowerCase() === b.subject.trim().toLowerCase() &&
  a.to.map(bare).sort().join(',') === b.to.map(bare).sort().join(',')

export function createOutbox({ dir, accounts, transportFor = defaultTransport, file = fileMessage, unfile = unfileMessage, now = () => Date.now(), log = () => {} }) {
  mkdirSync(dir, { recursive: true })
  const index = join(dir, 'outbox.json')
  const load = () => {
    try {
      return JSON.parse(readFileSync(index, 'utf8'))
    } catch {
      return { next: 1, items: [] }
    }
  }
  const save = (s) => writeFileSync(index, JSON.stringify(s, null, 1))
  const emlOf = (id) => join(dir, `${id}.eml`)
  const acctOf = (entry) => accounts.find((a) => a.user === entry.account)

  /** Forget a held email: its file here and its copy in Drafts. Best effort on the mailbox. */
  async function discard(entry) {
    rmSync(emlOf(entry.id), { force: true })
    const acct = acctOf(entry)
    if (acct && entry.messageId && entry.draft) {
      try {
        await unfile(acct, entry.messageId, '\\Drafts')
      } catch (err) {
        log(`[jarvis:outbox] draft copy of #${entry.id} not removed: ${err.message}`)
      }
    }
  }

  /** Drop what has waited more than a day; returns the live state. */
  function sweep() {
    const s = load()
    const keep = s.items.filter((i) => now() - i.queuedAt < TTL_MS)
    if (keep.length !== s.items.length) {
      save({ ...s, items: keep })
      for (const i of s.items) if (!keep.includes(i)) discard(i).catch(() => {})
    }
    return { ...s, items: keep }
  }

  /** Build the email and hold it. Returns the entry Salman is shown, with `superseded` ids and `draft` folder. */
  async function queueSend(opts) {
    const m = await buildMessage(accounts, opts)
    if (/gmail\.com$/i.test(m.acct.host)) throw new Error(`${m.acct.user} is a Gmail account — send it through Zapier Gmail as usual`)
    const s = sweep()
    const id = s.next
    const entry = {
      id,
      account: m.acct.user,
      to: m.to,
      cc: m.cc,
      subject: m.subject,
      preview: m.text.replace(/\r/g, '').trim().slice(0, 900),
      files: m.files.map((f) => ({ name: f.name, size: f.size })),
      threaded: m.threaded,
      messageId: /^Message-ID:\s*(<[^>]+>)/im.exec(m.raw)?.[1] ?? '',
      queuedAt: now(),
      draft: '',
    }
    // A revision replaces what it revises.
    const old = s.items.filter((i) => sameMail(i, entry))
    writeFileSync(emlOf(id), m.raw)
    save({ next: id + 1, items: [...s.items.filter((i) => !old.includes(i)), entry] })
    for (const o of old) await discard(o)
    // The copy he can see in the mailbox. If it cannot be filed the email is still held.
    try {
      entry.draft = (await file(m.acct, m.raw, '\\Drafts', ['\\Draft', '\\Seen'])) || ''
      const again = load()
      save({ ...again, items: again.items.map((i) => (i.id === id ? { ...i, draft: entry.draft } : i)) })
    } catch (err) {
      log(`[jarvis:outbox] #${id} held, but not filed in Drafts: ${err.message}`)
    }
    return { ...entry, superseded: old.map((o) => o.id) }
  }

  const pending = () => sweep().items

  /** Which held ids a request means: a list, or 'all'. */
  const resolve = (ids) => (ids === 'all' ? pending().map((i) => i.id) : [...new Set((ids ?? []).map(Number).filter(Number.isFinite))])

  /** Send one held email. Resolves { ok, entry, why?, filed? } — never throws. */
  async function confirm(id) {
    const s = sweep()
    const entry = s.items.find((i) => i.id === Number(id))
    if (!entry) return { ok: false, id: Number(id), why: `there is no email #${id} waiting (it may have been sent, cancelled, replaced or expired)` }
    const acct = acctOf(entry)
    if (!acct) return { ok: false, id: entry.id, entry, why: `${entry.account} is no longer configured` }
    let raw
    try {
      raw = readFileSync(emlOf(entry.id))
    } catch {
      return { ok: false, id: entry.id, entry, why: 'the held message could not be read' }
    }
    // Taken out of the outbox BEFORE the send, so a second "send 3" (a double
    // tap, a retry) can never put the same email out twice.
    save({ ...s, items: s.items.filter((i) => i.id !== entry.id) })
    try {
      await transportFor(acct).sendMail({ envelope: { from: acct.user, to: [...entry.to, ...entry.cc].map(bare) }, raw })
    } catch (err) {
      // Not sent: put it back so it can be tried again.
      const again = load()
      save({ ...again, items: [...again.items, entry].sort((a, b) => a.id - b.id) })
      return { ok: false, id: entry.id, entry, why: String(err.message).split('\n')[0] }
    }
    // SMTP does not keep a copy; file one in Sent so webmail shows it, and
    // take the held copy out of Drafts.
    let filed = ''
    try {
      filed = await file(acct, raw, '\\Sent', ['\\Seen'])
    } catch {}
    await discard(entry)
    return { ok: true, id: entry.id, entry, filed }
  }

  async function cancel(id) {
    const s = sweep()
    const entry = s.items.find((i) => i.id === Number(id))
    if (!entry) return { ok: false, id: Number(id), why: `there is no email #${id} waiting` }
    save({ ...s, items: s.items.filter((i) => i.id !== entry.id) })
    await discard(entry)
    return { ok: true, id: entry.id, entry }
  }

  /** Several at once, one after another — a mail server will not thank us for ten connections. */
  async function confirmMany(ids) {
    const out = []
    for (const id of resolve(ids)) out.push(await confirm(id))
    return out
  }
  async function cancelMany(ids) {
    const out = []
    for (const id of resolve(ids)) out.push(await cancel(id))
    return out
  }

  return { queueSend, pending, confirm, cancel, confirmMany, cancelMany }
}

function defaultTransport(acct) {
  return nodemailer.createTransport({ host: smtpHostOf(acct), port: 465, secure: true, auth: { user: acct.user, pass: acct.password } })
}

/** Can this account log in to its SMTP server? For the preflight. Sends nothing. */
export async function smtpReady(acct) {
  try {
    await defaultTransport(acct).verify()
    return { ok: true, host: smtpHostOf(acct) }
  } catch (err) {
    return { ok: false, host: smtpHostOf(acct), why: String(err.message).split('\n')[0] }
  }
}

// ------------------------------------------------------------ telling Salman

const mb = (n) => `${(n / 1048576).toFixed(1)} MB`

/** What Salman is shown when an email is held for him. */
export function sendPreview(e) {
  const files = e.files.length ? `\nAttached: ${e.files.map((f) => `${f.name} (${mb(f.size)})`).join(', ')}` : ''
  return [
    `Email #${e.id} ready to send from ${e.account}${e.threaded ? ' (reply in thread)' : ''}${e.superseded?.length ? ` — replaces #${e.superseded.join(', #')}` : ''}`,
    `To: ${e.to.join(', ')}${e.cc.length ? `\nCc: ${e.cc.join(', ')}` : ''}`,
    `Subject: ${e.subject}`,
    '',
    e.preview + files,
    '',
    `${e.draft ? `It is in ${e.draft} in the mailbox too. ` : ''}Reply "send ${e.id}" to send it, or "cancel ${e.id}". Nothing goes until you do.`,
  ].join('\n')
}

/** One line per held email, for a list. */
export const heldLine = (e) => `#${e.id} to ${e.to.join(', ')} — "${e.subject}"${e.files.length ? ` · ${e.files.map((f) => `${f.name} ${mb(f.size)}`).join(', ')}` : ''}`

/**
 * "send 3", "Send #3", "send 3 4 5", "send 21-30", "send all", "cancel all"
 * → { verb, ids: number[] | 'all' }. Only the bare command counts; anything
 * with other words in it is conversation and goes to JARVIS.
 */
export function parseSendApproval(text) {
  const m = /^\s*(send|cancel)\s+(all|[#\d][#\d\s,–-]*)\s*[.!]?\s*$/i.exec(String(text ?? ''))
  if (!m) return null
  const verb = m[1].toLowerCase()
  if (/^all$/i.test(m[2])) return { verb, ids: 'all' }
  const ids = []
  for (const part of m[2].replace(/#/g, '').split(/[\s,]+/).filter(Boolean)) {
    const r = /^(\d{1,5})[–-](\d{1,5})$/.exec(part)
    if (r) {
      const [a, b] = [Number(r[1]), Number(r[2])]
      if (b < a || b - a > 200) return null
      for (let i = a; i <= b; i++) ids.push(i)
    } else if (/^\d{1,5}$/.test(part)) ids.push(Number(part))
    else return null
  }
  return ids.length ? { verb, ids: [...new Set(ids)] } : null
}

/** Carry out a send or cancel. Returns the lines to tell him — what went, what did not, and why. */
export async function applySendApproval(outbox, parsed) {
  const results = parsed.verb === 'cancel' ? await outbox.cancelMany(parsed.ids) : await outbox.confirmMany(parsed.ids)
  if (!results.length) return ['There are no emails waiting.']
  if (parsed.verb === 'cancel') {
    return results.map((r) => (r.ok ? `Email #${r.id} to ${r.entry.to.join(', ')} cancelled — not sent.` : `Nothing cancelled: ${r.why}.`))
  }
  const lines = results.map((r) =>
    r.ok
      ? `Sent: email #${r.id} from ${r.entry.account} to ${r.entry.to.join(', ')} — "${r.entry.subject}".${r.filed ? ` A copy is in ${r.filed}.` : ' (No copy could be filed in Sent.)'}`
      : `NOT sent: ${r.why}.${r.entry ? ` Email #${r.id} is still waiting — "send ${r.id}" tries again.` : ''}`,
  )
  if (results.length > 1) lines.push(`${results.filter((r) => r.ok).length} of ${results.length} sent.`)
  return lines
}
