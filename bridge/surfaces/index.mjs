import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createTelegram } from './telegram.mjs'
import { createMailWatcher, accountsFromEnv } from './mail.mjs'
import { createAlertCalls, inCallHours, TOP_UP } from './alertcall.mjs'
import { backlogPrompt } from './backlog.mjs'
import { createMorningQueue } from './morning.mjs'
import { isPlancheckAccount, plancheckClassify, plancheckMailPrompt, PLANCHECK_BACKLOG_STEPS } from '../plancheck/index.mjs'
import { leadPrompt } from './leads.mjs'
import { councilPrompt } from './council.mjs'
import { attachmentBlock, documentsPrompt } from './attachments.mjs'
import { createStore } from '../knowledge/store.mjs'
import { parseApproval, applyApproval } from '../knowledge/approvals.mjs'
import { parseSendApproval, applySendApproval } from '../mailsend.mjs'
import { applyPortalMail } from '../tracker/store.mjs'
import { portalLine } from '../tracker/index.mjs'
import * as speech from './speech.mjs'
import { PATHS } from '../paths.mjs'

/**
 * The surfaces beyond the desk — Telegram, the inbox, the phone — and the one
 * chain that joins them: an important email becomes a short summary, the
 * summary becomes a Telegram message (and a line on the desk if a page is
 * open), and an urgent one becomes a phone call. Every hop reports a receipt
 * or a failure; nothing is claimed that did not happen.
 *
 * @param {object} io
 * @param {(kind: 'telegram'|'summary') => any} io.makeSession
 * @param {(frame: object) => void} io.broadcast
 * @param {object} [io.knowledge] the knowledge store the sessions share, so a
 *   "yes 12" typed on Telegram lands in the same playbook they read
 */
export function createSurfaces({ env, dataDir, jobsFile, makeSession, broadcast, knowledge = createStore(), outbox = null, tracker = null, plancheck = null, restart = null, listen = true, log = console.log }) {
  const telegram = createTelegram({
    token: env.TELEGRAM_BOT_TOKEN,
    chatId: env.TELEGRAM_CHAT_ID,
    makeSession: () => makeSession('telegram'),
    speech,
    inboxDir: PATHS.inbox,
    quickCall: () => quickCall(),
    restart,
    // Lesson approvals typed on Telegram go straight to the knowledge store.
    // So does "send 3" / "cancel 3" for an email JARVIS has held for him.
    approvals: async (text) => {
      const send = outbox ? parseSendApproval(text) : null
      if (send) return applySendApproval(outbox, send)
      const parsed = parseApproval(text)
      return parsed ? applyApproval(knowledge, parsed) : null
    },
    log,
  })

  /**
   * "Call me" from Telegram (the one-tap Shortcut): ring him now with a light
   * briefing — the diary and the jobs list, so the voice can answer the usual
   * questions — and carry out whatever he says on the call afterwards.
   * Deliberately no model turn first: the ring is what he tapped for.
   */
  async function quickCall() {
    if (!phone) {
      await telegram.notify('The phone line is not configured, sir.')
      return
    }
    await telegram.notify('Ringing you now, sir.', { silent: true })
    const jobs = jobsMarkdown()
    const diary = /## Diary\s*([\s\S]*?)(?=\n## |\s*$)/.exec(jobs)?.[1]?.trim() || '(nothing in the diary)'
    const when = new Date().toLocaleString('en-GB', { weekday: 'long', hour: '2-digit', minute: '2-digit' })
    const briefing =
      `Salman asked to be rung — one tap from his phone, ${when}. He has not said what about. ` +
      `Open with "Sir, you rang." and ask what he needs; read nothing out unless he asks. Take his instructions as usual.\n\n` +
      `If he asks, this is his diary:\n${diary.slice(0, 1500)}\n\nAnd his jobs list:\n${jobs.slice(0, 5000)}`
    const r = await phone.callMe(briefing, { force: true })
    if (!r.ok) {
      await telegram.notify(`I could not reach you by phone, sir: ${r.why}.`)
      return
    }
    log(`[jarvis:phone] quick call answered, ${r.seconds}s`)
    if (r.reply) await afterCall(r.reply)
  }

  const phone = createAlertCalls({
    apiKey: env.RETELL_API_KEY,
    fromNumber: env.RETELL_FROM_NUMBER,
    myNumber: env.JARVIS_MY_NUMBER,
    voiceId: env.RETELL_VOICE_ID,
    model: env.RETELL_LLM_MODEL ?? 'gpt-4.1',
    statePath: join(dataDir, 'retell.json'),
    log,
  })

  /** What lands outside calling hours is rung in one call at 8am. */
  const morning = phone
    ? createMorningQueue({
        file: join(dataDir, 'morning-calls.json'),
        callMe: async (text) => {
          const r = await phone.callMe(text)
          if (r.ok && r.reply) await afterCall(r.reply)
          return r
        },
        inCallHours,
        notify: (t, o) => (telegram ? telegram.notify(t, o) : Promise.resolve(false)),
        log,
      })
    : null

  let summariser = null
  const summarise = async (mail, verdict) => {
    const raw = `From ${mail.from.replace(/<.*?>/g, '').trim()}: ${mail.subject}` + (mail.text ? ` — ${mail.text.slice(0, 160)}` : '')
    try {
      if (!summariser || summariser.closed) summariser = makeSession('summary')
      if (summariser.busy) return raw
      const { text } = await summariser.ask(
        `An email has arrived for Salman. Flagged because: ${verdict.why.join(', ')}.\n\n` +
          `From: ${mail.from}\nSubject: ${mail.subject}\n\n${mail.text.slice(0, 3000)}\n\n` +
          'Write the one message Jarvis sends to his phone: who it is from, what it says, and what it asks of him, ' +
          'in at most three short sentences. Plain text, no markdown, no preamble.',
      )
      return text?.trim() || raw
    } catch {
      return raw
    }
  }

  /**
   * What the user said on a call, carried out by the full JARVIS afterwards:
   * reminders set, notes captured, a call back if they asked for one. The
   * voice on the call could only listen; this is where it is acted on.
   */
  const afterCall = async (reply) => {
    if (!telegram) return
    await telegram.run(
      `You have just rung the user with a briefing and the call has ended. This is everything they said on the call, transcribed:\n\n"${reply}"\n\n` +
        'Carry out any instructions in it now — reminders, diary entries, notes, anything you have a tool for — and ' +
        'then report in one or two lines what you did. If they asked to be called back, or asked for something that is ' +
        'better heard than read, ring them with the outcome using call_me; otherwise reply here. If there were no ' +
        'instructions, say so in one line.',
    )
  }

  const accounts = accountsFromEnv(env)
  const jobsMarkdown = () => {
    try {
      return readFileSync(jobsFile, 'utf8')
    } catch {
      return ''
    }
  }
  const mailboxes = accounts
    .filter((a) => {
      if (a.host) return true
      log(`[jarvis:mail] ${a.user}: no IMAP host known for that domain — set MAIL_n_HOST`)
      return false
    })
    .map((a) =>
      createMailWatcher({
        ...a,
        statePath: join(dataDir, `mail-state-${a.user.replace(/[^a-z0-9]+/gi, '_').toLowerCase()}.json`),
        jobsMarkdown,
        attachDir: join(PATHS.inbox, 'Mail'),
        onImportant: (m, verdict) => deliver(m, verdict, a.user),
        onBacklog: (items, info) => catchUp(items, info, a.user),
        // Plancheck's inbox has no SY clients to match: everything there matters.
        ...(isPlancheckAccount(a.user) ? { classifier: plancheckClassify } : {}),
        // Planning Portal notifications go straight onto the tracker — read
        // exactly, by the bridge, with one quiet line to Telegram.
        onEvery: tracker
          ? (m) => {
              const r = applyPortalMail(tracker, m)
              if (r?.ok && (r.isNew || r.changed.length)) {
                log(`[jarvis:tracker] ${r.event}: ${r.app.address} ${r.app.ppRef}`)
                const line = portalLine(r)
                if (line && telegram) void telegram.notify(line, { silent: true })
              }
            }
          : null,
        log,
      }),
    )
    .filter(Boolean)
  const mail = mailboxes.length ? mailboxes : null
  let creditTimer = null

  /**
   * A backlog, after the PC has been off: say what is waiting, then one session
   * works through the lot and sends one briefing. Without Telegram there is no
   * session to run it on, so the emails go through one by one as usual.
   */
  async function catchUp(items, { since, seen }, account) {
    if (!telegram) {
      for (const { mail, verdict } of items) await deliver(mail, verdict, account)
      return true
    }
    const n = (f) => items.filter(f).length
    const urgent = n((i) => i.verdict.level === 'urgent')
    const leads = n((i) => i.verdict.level === 'lead')
    const council = n((i) => i.verdict.level !== 'lead' && i.verdict.why.includes('council'))
    const sinceLine = since ? new Date(since).toLocaleDateString('en-GB', { day: 'numeric', month: 'long' }) : 'the last check'
    log(`[jarvis:mail] catch-up on ${account}: ${items.length} to work through (${urgent} urgent, ${council} council, ${leads} leads)`)
    await telegram.notify(
      `Catching up on ${account}, sir: ${seen} new email${seen === 1 ? '' : 's'} since ${sinceLine}, ${items.length} worth your attention — ${urgent} urgent, ${council} from councils, ${leads} new enquir${leads === 1 ? 'y' : 'ies'}. Working through them now; one briefing to follow.`,
      { silent: true },
    )
    broadcast({ type: 'say', text: `Sir, ${seen} emails came in on ${account} while the machine was off. I am working through them; the briefing goes to your phone.`, listen: false, drift: true })
    // Two inboxes can find their piles at the same moment. run() cuts into a
    // busy session, which would kill the other catch-up half-way; so wait for
    // it, up to 45 minutes, and if it is still busy let the pile be kept and
    // tried again later.
    const until = Date.now() + 45 * 60_000
    while (telegram.busy() && Date.now() < until) await new Promise((r) => setTimeout(r, 15_000))
    if (telegram.busy()) {
      log(`[jarvis:mail] catch-up on ${account} is waiting: the Telegram session is still busy`)
      return false
    }
    return telegram.run(backlogPrompt(items, { account, since, seen, callAllowed: Boolean(phone) && inCallHours(), ...(isPlancheckAccount(account) ? { steps: PLANCHECK_BACKLOG_STEPS } : {}) }))
  }

  /**
   * An email to Plancheck Recruitment: one line to the phone, then the full
   * JARVIS as Plancheck — matching the sender to the records, updating them,
   * holding any reply. Never a call, never the SY routines.
   */
  async function deliverPlancheck(m, verdict, account) {
    if (!telegram) {
      log(`[jarvis:plancheck] ${verdict.why.join(', ')} on ${account}: "${m.subject}" — no Telegram, so no session to work it`)
      return
    }
    const from = m.from.replace(/<.*?>/g, '').trim()
    const addr = (m.from.match(/[\w.+-]+@[\w.-]+\.\w+/) ?? [''])[0].toLowerCase()
    const matches = []
    if (plancheck && addr) {
      for (const kind of ['employers', 'candidates', 'leads']) for (const r of plancheck.list(kind, { q: addr })) matches.push({ kind, ...r })
    }
    log(`[jarvis:plancheck] ${verdict.why.join(', ')} on ${account}: "${m.subject}" from ${from}${matches.length ? ` (${matches.map((x) => x.id).join(', ')})` : ''}`)
    await telegram.notify(`Plancheck: ${from} — ${m.subject}. Working through it now.`, { silent: true })
    await telegram.run(plancheckMailPrompt(m, { account, matches }))
  }

  async function deliver(m, verdict, account) {
      if (isPlancheckAccount(account)) return deliverPlancheck(m, verdict, account)
      // A new enquiry goes to the full JARVIS, who triages it and rings. Without
      // Telegram there is no session to run it on, so it falls back to a plain
      // alert call below.
      if (verdict.level === 'lead' && telegram) {
        log(`[jarvis:mail] lead on ${account}: "${m.subject}" (${verdict.why.join(', ')})`)
        await telegram.notify(`New enquiry: ${m.from.replace(/<.*?>/g, '').trim()} — ${m.subject}. Looking into it now, sir.`, { silent: true })
        const block = attachmentBlock(m.attachments)
        await telegram.run(leadPrompt(m, { account, callAllowed: Boolean(phone) && inCallHours() }) + (block ? `\n\n${block}` : ''))
        return
      }
      // A council email: matched to its project, requests and deadline pulled
      // out, drawings found, a draft reply saved (never sent), and Salman told
      // "this project needs your review" — rung if the deadline is close.
      if (verdict.why.includes('council') && telegram) {
        log(`[jarvis:mail] council email on ${account}: "${m.subject}" (${verdict.why.join(', ')})`)
        await telegram.notify(`Council email: ${m.from.replace(/<.*?>/g, '').trim()} — ${m.subject}. Working through it now, sir.`, { silent: true })
        await telegram.run(councilPrompt(m, { account, callAllowed: Boolean(phone) && inCallHours() }))
        return
      }
      const urgent = verdict.level === 'urgent' || verdict.level === 'lead'
      // A client or job email carrying documents: JARVIS opens every one,
      // files what it says and sets the actions — not a one-line summary of
      // the covering note. Urgent mail still rings first (below), then reads.
      const docs = m.attachments?.length && telegram
      if (docs && !urgent) {
        log(`[jarvis:mail] ${verdict.level} with ${m.attachments.length} attachment(s) on ${account}: "${m.subject}"`)
        await telegram.notify(`${m.from.replace(/<.*?>/g, '').trim()} — ${m.subject}. ${m.attachments.length} attachment(s); reading them now, sir.`, { silent: true })
        await telegram.run(documentsPrompt(m, m.attachments, { account, why: verdict.why }))
        return
      }
      const summary = await summarise(m, verdict)
      const via = mailboxes.length > 1 ? ` (${account})` : ''
      const line = `${urgent ? 'URGENT · ' : ''}${summary}${via}`
      log(`[jarvis:mail] ${verdict.level} on ${account}: "${m.subject}" (${verdict.why.join(', ')})`)

      const sent = telegram ? await telegram.notify(line) : false
      // A page that is open hears it too; skippable, so it never talks over an answer.
      broadcast({ type: 'say', text: `Sir, ${summary}`, listen: false, drift: true })

      if (urgent && phone) {
        // An alert call carries a briefing, not one line: the summary, the
        // full text of the email, and where it sits in the jobs list.
        const briefing =
          `URGENT EMAIL.\n${summary}\n\nThe email in full:\nFrom: ${m.from}\nSubject: ${m.subject}\n${m.text.slice(0, 3000)}\n\n` +
          `Jobs list for context:\n${jobsMarkdown().slice(0, 3000)}`
        const r = await phone.callMe(briefing)
        if (!r.ok && /outside call hours/.test(r.why) && morning) morning.add(briefing, { about: m.subject })
        const receipt = r.ok
          ? `Called you — answered, ${r.seconds}s.`
          : r.noCredit
            ? `I tried to ring you about this but the phone line is out of credit — ${TOP_UP}.`
            : /outside call hours/.test(r.why)
              ? 'Queued for the 8am call.'
              : `Could not reach you by phone: ${r.why}.`
        log(`[jarvis:phone] ${receipt}`)
        if (telegram) await telegram.notify(receipt, { silent: true })
        if (r.ok && r.reply) await afterCall(r.reply)
        if (docs) await telegram.run(documentsPrompt(m, m.attachments, { account, why: verdict.why }))
      } else if (docs) {
        await telegram.run(documentsPrompt(m, m.attachments, { account, why: verdict.why }))
      } else if (!sent && !telegram) {
        log('[jarvis:mail] no Telegram configured — the alert went only to the desk')
      }
  }

  return {
    async start() {
      if (telegram) await telegram.start({ listen })
      if (listen) for (const box of mailboxes) box.start()
      else log('[jarvis] satellite: the PC owns Telegram and the inbox watchers; this JARVIS sends but does not listen')
      if (phone) log(`[jarvis] phone alerts ready — calls between ${8}:00 and ${21}:00`)
      if (morning && listen) {
        morning.start()
        const waiting = morning.list().length
        if (waiting) log(`[jarvis:phone] ${waiting} item(s) waiting for the morning call`)
      }
      // The phone account can run dry with nothing else going wrong. Look at
      // start and every six hours; while it is empty, say so on Telegram once
      // a day — a missed alert call is exactly the failure nobody notices.
      if (phone && listen) {
        let warnedAt = 0
        const watchCredit = async () => {
          const ok = await phone.checkCredit().catch(() => null)
          if (ok === false) {
            log(`[jarvis:phone] Retell is out of credit — alert calls cannot be placed (${TOP_UP})`)
            if (telegram && Date.now() - warnedAt > 20 * 3600_000) {
              warnedAt = Date.now()
              await telegram.notify(`Sir, the phone line is out of credit, so I cannot ring you with alerts. Please ${TOP_UP}. Until then everything comes here instead.`)
            }
          } else if (ok === true && warnedAt) {
            warnedAt = 0
            log('[jarvis:phone] Retell credit is back — alert calls can be placed again')
            if (telegram) await telegram.notify('The phone line has credit again, sir. Alert calls are back on.', { silent: true })
          }
        }
        void watchCredit()
        creditTimer = setInterval(() => void watchCredit(), 6 * 3600_000)
      }
      if (!telegram && !mail && !phone) log('[jarvis] no surfaces configured (Telegram, mail, phone) — see .env.example')
    },
    stop() {
      if (creditTimer) clearInterval(creditTimer)
      morning?.stop()
      telegram?.stop()
      for (const box of mailboxes) box.stop()
      summariser?.close()
    },
    notify: (text, opts) => (telegram ? telegram.notify(text, opts) : Promise.resolve(false)),
    /** A prompt run as JARVIS on the Telegram session — the weekly Plancheck searches use it. */
    runOnTelegram: (prompt) => (telegram ? telegram.run(prompt) : Promise.resolve(false)),
    sendDocument: (path, caption) => (telegram ? telegram.sendDocument(path, caption) : Promise.resolve(false)),
    sendFile: (path, caption, opts) => (telegram ? telegram.sendFile(path, caption, opts) : Promise.resolve({ ok: false, why: 'Telegram is not configured' })),
    callMe: (text, opts) => (phone ? phone.callMe(text, opts) : Promise.resolve({ ok: false, why: 'phone not configured' })),
    /** Hold a briefing for the 8am call. Returns how many are waiting. */
    queueMorningCall: (text, opts) => (morning ? morning.add(text, opts) : 0),
    morningQueue: () => (morning ? morning.list() : []),
    checkMailNow: () => Promise.all(mailboxes.map((box) => box.checkNow())),
    diag: () => ({
      telegram: telegram ? telegram.diag() : { configured: false },
      mail: mail ? mailboxes.map((box) => box.diag()) : [],
      phone: phone ? { ...phone.diag(), morningQueue: morning ? morning.list().length : 0 } : { configured: false },
    }),
  }
}
