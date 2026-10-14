import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs'
import { dirname } from 'node:path'
import { ImapFlow } from 'imapflow'
import { simpleParser } from 'mailparser'
import { saveAttachments } from './attachments.mjs'

/**
 * The inbox watcher.
 *
 * Every few minutes it looks at what has arrived since last time and decides,
 * with rules that cost nothing, whether it matters: a client from JOBS.md, a
 * council, a job address in the subject, the words that mean money or
 * trouble. Only what matters goes any further — one short model summary, a
 * Telegram message, and for the urgent few, a phone call.
 *
 * The rules are the point. A model reading every newsletter would cost more
 * per day than the phone line, and the things worth a call are exactly the
 * ones a rule can name: enforcement, refusal, a deadline, an invoice.
 */

export const MAIL_POLL_MS = 5 * 60_000

const COUNCIL = /\.gov\.uk$|council|planning|buildingcontrol|building-control/i
const MONEY_TROUBLE =
  /\b(enforcement|refus(ed|al)|decision|appeal|notice|condition|deadline|invoice|payment|overdue|urgent|immediately|final|court|complaint|breach|stop notice|discharge)\b/i
const URGENT = /\b(enforcement|refus(ed|al)|deadline|final notice|stop notice|court|urgent|immediately|breach)\b/i
const NOISE = /\b(unsubscribe|newsletter|no-?reply|noreply|donotreply|notification@|marketing|promo|webinar)\b/i

/**
 * A new enquiry: someone asking for help (a quote, a fee, a call) about the
 * kind of work the practice does. Both halves are required — "can you help"
 * alone is every cold pitch, and "extension" alone is every newsletter.
 */
const LEAD_ASK =
  /\b(quote|quotation|your fees?|fees? for|price|pricing|how much|cost of|enquiry|inquiry|would you be available|are you available|available for a (short |quick |brief )?call|can you (help|carry out|provide|do|check|confirm|draw|prepare|advise|survey)|could you (help|quote|provide|advise)|looking for (an? )?(architect|architectural|designer|draughtsman|technologist|someone|help)|need (plans|drawings|an architect|help)|interested in your services|would like to (discuss|arrange|get|book))\b/i
const LEAD_WORK =
  /\b(extension|loft|dormer|garage|conversion|outbuilding|annexe?|planning (permission|application)|permitted development|building reg(ulation)?s?|lawful development|new build|flats?|basement|refurb\w*|renovat\w*|rebuild|demolish\w*|measured survey|drawings|plans|porch|hip.to.gable|mansard|change of use|hmo|garden room|side return)\b/i
/** Lead services and website forms; they send from no-reply addresses, so they bypass the noise rule. */
const LEAD_SOURCE = /(bark\.com|checkatrade|mybuilder|houzz|ratedpeople|trustatrader|yell\.com|wix|squarespace|formspree|webflow|contact form|new (form )?submission|new enquiry|new lead)/i

/**
 * Clients and job addresses, read out of JOBS.md every check so a new job
 * counts from the moment it is written down.
 */
export function jobsContext(markdown) {
  const clients = new Set()
  const places = new Set()
  for (const line of String(markdown ?? '').split(/\r?\n/)) {
    if (!line.startsWith('|')) continue
    const cells = line.split('|').map((c) => c.trim())
    // | Job | Client | Scope | Status | Notes |
    if (cells.length < 5 || /^-+$/.test(cells[1]) || /^job$/i.test(cells[1])) continue
    const job = cells[1]
    const client = cells[2]
    const place = job.split(',')[0].replace(/^\d+\s+/, '').trim()
    if (place.length >= 5 && !/^—$/.test(place)) places.add(place.toLowerCase())
    for (const name of client.split(/\s+and\s+|,|\//)) {
      const n = name.replace(/\(.*?\)/g, '').trim()
      if (n.length >= 4 && !/^—$/.test(n)) clients.add(n.toLowerCase())
    }
  }
  return { clients: [...clients], places: [...places] }
}

/** Does every part of a name appear in the sender string? "Robin Glassup" in "Glassup, Robin <r@…>". */
const nameMatches = (name, from) => name.split(/\s+/).every((part) => part.length < 3 || from.includes(part))

/**
 * Pure. Returns null for "not important", else
 * { level: 'important' | 'urgent' | 'lead', why }.
 */
export function classify({ from = '', subject = '', text = '' }, ctx) {
  const f = from.toLowerCase()
  const s = subject.toLowerCase()
  const body = `${s} ${text.slice(0, 2000).toLowerCase()}`
  const address = (f.match(/<([^>]+)>/)?.[1] ?? f).trim()
  const domain = address.split('@')[1] ?? ''

  const client = ctx.clients.find((c) => nameMatches(c, f))
  const place = ctx.places.find((p) => body.includes(p))
  const council = COUNCIL.test(domain) || COUNCIL.test(f)

  // A new enquiry, from someone who is not already a client or a council.
  const fromService = LEAD_SOURCE.test(`${f} ${s}`)
  if (!client && !place && !council && (!NOISE.test(f) || fromService)) {
    const work = body.match(LEAD_WORK)?.[0]
    if (work && (LEAD_ASK.test(body) || fromService)) {
      return { level: 'lead', why: [fromService ? 'enquiry via a lead service or website form' : 'new enquiry', work.toLowerCase()] }
    }
  }

  if (NOISE.test(f) && !COUNCIL.test(domain)) return null

  const why = []
  if (client) why.push(`client ${client}`)
  if (council) why.push('council')
  if (place) why.push(`job ${place}`)
  const trouble = body.match(MONEY_TROUBLE)?.[0]
  if (trouble && (client || place || COUNCIL.test(domain))) why.push(trouble)

  if (!why.length) return null
  const urgent = URGENT.test(body) && (client || place || COUNCIL.test(domain) || COUNCIL.test(f))
  return { level: urgent ? 'urgent' : 'important', why }
}

// ---------------------------------------------------------------- accounts

/** The IMAP host for a provider, from the address alone. Unknown domains need MAIL_n_HOST. */
export function guessImapHost(user) {
  const domain = String(user ?? '').toLowerCase().split('@')[1] ?? ''
  if (/^(gmail|googlemail)\.com$/.test(domain)) return 'imap.gmail.com'
  if (/^(outlook|hotmail|live|msn)\./.test(domain)) return 'outlook.office365.com'
  if (/^(yahoo|ymail|rocketmail)\./.test(domain)) return 'imap.mail.yahoo.com'
  if (/^(icloud|me|mac)\.com$/.test(domain)) return 'imap.mail.me.com'
  if (/^(aol)\.com$/.test(domain)) return 'imap.aol.com'
  if (/^(proton|protonmail)\./.test(domain)) return '127.0.0.1' // needs Proton Bridge
  return ''
}

/**
 * Every inbox in the environment: GMAIL_USER/GMAIL_APP_PASSWORD (the first
 * one) plus MAIL_1_USER … MAIL_9_USER with their _PASSWORD and optional _HOST.
 * A Google Workspace address on a custom domain has no guessable host, so
 * GMAIL_* defaults to imap.gmail.com and everything else must say.
 */
export function accountsFromEnv(env) {
  const out = []
  if (env.GMAIL_USER && env.GMAIL_APP_PASSWORD) {
    out.push({ user: env.GMAIL_USER, password: env.GMAIL_APP_PASSWORD, host: env.IMAP_HOST || 'imap.gmail.com' })
  }
  for (let i = 1; i <= 9; i++) {
    const user = env[`MAIL_${i}_USER`]
    const password = env[`MAIL_${i}_PASSWORD`]
    if (!user || !password) continue
    // MAIL_n_SMTP_HOST only when it is not the IMAP host with "smtp." in front.
    out.push({ user, password, host: env[`MAIL_${i}_HOST`] || guessImapHost(user), ...(env[`MAIL_${i}_SMTP_HOST`] ? { smtpHost: env[`MAIL_${i}_SMTP_HOST`] } : {}) })
  }
  return out
}

// ---------------------------------------------------------------- state

function readState(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return { uidNext: null, seen: [] }
  }
}
function writeState(path, state) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(`${path}.tmp`, JSON.stringify({ ...state, seen: state.seen.slice(-500) }))
  renameSync(`${path}.tmp`, path)
}

// ---------------------------------------------------------------- watcher

/**
 * @param {object} io
 * @param {() => string} io.jobsMarkdown        current JOBS.md text
 * @param {(mail, verdict) => Promise<void>} io.onImportant  deliver it
 */
export function createMailWatcher({ user, password, host = 'imap.gmail.com', statePath, jobsMarkdown, onImportant, onEvery = null, attachDir = null, pollMs = MAIL_POLL_MS, log = console.log }) {
  if (!user || !password) return null
  let timer = null
  let checking = false
  let last = { at: 0, ok: false, error: '', seen: 0, important: 0 }
  const state = readState(statePath)

  async function check() {
    if (checking) return
    checking = true
    // Important mail is collected while connected and delivered after logging
    // out: reading attachments or working a council email takes minutes, and
    // the mailbox connection would drop underneath it.
    const pending = []
    const client = new ImapFlow({ host, port: 993, secure: true, auth: { user, pass: password }, logger: false })
    try {
      await client.connect()
      const lock = await client.getMailboxLock('INBOX')
      try {
        const box = client.mailbox
        // First run: take the watermark and read nothing old. A fresh watcher
        // that announced a month of backlog would be switched off within a minute.
        if (state.uidNext == null) {
          state.uidNext = box.uidNext
          writeState(statePath, state)
          last = { at: Date.now(), ok: true, error: '', seen: 0, important: 0 }
          return
        }
        const ctx = jobsContext(jobsMarkdown())
        let seen = 0
        let important = 0
        const range = `${state.uidNext}:*`
        for await (const msg of client.fetch(range, { uid: true, envelope: true, source: true }, { uid: true })) {
          if (msg.uid < state.uidNext) continue
          seen++
          state.uidNext = Math.max(state.uidNext, msg.uid + 1)
          const id = msg.envelope?.messageId ?? `uid:${msg.uid}`
          if (state.seen.includes(id)) continue
          state.seen.push(id)
          const parsed = await simpleParser(msg.source).catch(() => null)
          const mail = {
            id,
            from: msg.envelope?.from?.map((a) => `${a.name ?? ''} <${a.address ?? ''}>`).join(', ') ?? '',
            subject: msg.envelope?.subject ?? '',
            date: msg.envelope?.date ?? new Date(),
            text: (parsed?.text ?? '').replace(/\s+/g, ' ').trim(),
          }
          // Every new message, important or not, is offered to the tracker:
          // a Planning Portal notification is routine mail, and it is also
          // the record of a submission. Given the body as written, not squashed.
          if (onEvery) {
            try {
              onEvery({ ...mail, text: parsed?.text ?? '' })
            } catch (err) {
              log(`[jarvis:mail] tracker hook failed for "${mail.subject}": ${err.message}`)
            }
          }
          const verdict = classify(mail, ctx)
          if (!verdict) continue
          important++
          try {
            mail.attachments = saveAttachments(parsed, mail, attachDir)
          } catch (err) {
            mail.attachments = []
            log(`[jarvis:mail] could not save attachments of "${mail.subject}": ${err.message}`)
          }
          pending.push({ mail, verdict })
        }
        writeState(statePath, state)
        last = { at: Date.now(), ok: true, error: '', seen, important }
      } finally {
        lock.release()
      }
    } catch (err) {
      last = { ...last, at: Date.now(), ok: false, error: err.message }
      log(`[jarvis:mail] check failed: ${err.message}`)
    } finally {
      await client.logout().catch(() => {})
    }
    try {
      for (const { mail, verdict } of pending) {
        try {
          await onImportant(mail, verdict)
        } catch (err) {
          log(`[jarvis:mail] delivery failed for "${mail.subject}": ${err.message}`)
        }
      }
    } finally {
      checking = false
    }
  }

  return {
    start() {
      void check()
      timer = setInterval(() => void check(), pollMs)
      log(`[jarvis] watching ${user} every ${Math.round(pollMs / 60_000)} minutes`)
    },
    stop() {
      if (timer) clearInterval(timer)
      timer = null
    },
    checkNow: check,
    diag: () => ({ configured: true, user, ...last, lastCheckAgeMs: last.at ? Date.now() - last.at : null }),
  }
}
