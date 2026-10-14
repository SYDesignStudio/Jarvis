import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createTelegram } from './telegram.mjs'
import { createMailWatcher, accountsFromEnv } from './mail.mjs'
import { createAlertCalls, inCallHours } from './alertcall.mjs'
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
export function createSurfaces({ env, dataDir, jobsFile, makeSession, broadcast, knowledge = createStore(), outbox = null, tracker = null, restart = null, listen = true, log = console.log }) {
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

  async function deliver(m, verdict, account) {
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
        const receipt = r.ok
          ? `Called you — answered, ${r.seconds}s.`
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
      if (!telegram && !mail && !phone) log('[jarvis] no surfaces configured (Telegram, mail, phone) — see .env.example')
    },
    stop() {
      telegram?.stop()
      for (const box of mailboxes) box.stop()
      summariser?.close()
    },
    notify: (text, opts) => (telegram ? telegram.notify(text, opts) : Promise.resolve(false)),
    sendDocument: (path, caption) => (telegram ? telegram.sendDocument(path, caption) : Promise.resolve(false)),
    sendFile: (path, caption, opts) => (telegram ? telegram.sendFile(path, caption, opts) : Promise.resolve({ ok: false, why: 'Telegram is not configured' })),
    callMe: (text, opts) => (phone ? phone.callMe(text, opts) : Promise.resolve({ ok: false, why: 'phone not configured' })),
    checkMailNow: () => Promise.all(mailboxes.map((box) => box.checkNow())),
    diag: () => ({
      telegram: telegram ? telegram.diag() : { configured: false },
      mail: mail ? mailboxes.map((box) => box.diag()) : [],
      phone: phone ? phone.diag() : { configured: false },
    }),
  }
}
