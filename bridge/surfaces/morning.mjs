/**
 * The morning call.
 *
 * Salman wants to be rung about the emails that matter — a validation
 * letter, an officer's comments, a new enquiry — not just told. Calls stop at
 * 9pm and start at 8am, so what lands overnight is queued here and rung in
 * one call at eight: "Good morning, sir. Three things came in overnight…".
 * One call, not three; and if he does not answer it is tried again twice,
 * then left on Telegram.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

const RETRY_MS = 30 * 60_000
const MAX_ATTEMPTS = 3

export function createMorningQueue({ file, callMe, inCallHours, notify = null, now = () => new Date(), log = console.log }) {
  let timer = null
  let ringing = false

  function load() {
    try {
      return JSON.parse(readFileSync(file, 'utf8'))
    } catch {
      return { items: [], attempts: 0, nextTryAt: 0 }
    }
  }
  function save(s) {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(`${file}.tmp`, JSON.stringify(s, null, 2))
    renameSync(`${file}.tmp`, file)
  }

  /** Something to ring about when calls are allowed again. Returns the queue length. */
  function add(text, { about = '' } = {}) {
    const s = load()
    const t = String(text ?? '').trim()
    if (!t) return s.items.length
    // The same subject queued twice (a chase, a re-read) rings once.
    if (!s.items.some((i) => i.about && about && i.about === about)) s.items.push({ at: now().toISOString(), about, text: t.slice(0, 4000) })
    s.attempts = 0
    s.nextTryAt = 0
    save(s)
    log(`[jarvis:phone] queued for the morning call: ${about || t.slice(0, 60)}`)
    return s.items.length
  }

  /** The one briefing the voice reads. */
  function briefing(items, at = now()) {
    const n = items.length
    const head = `Good morning, sir. ${n === 1 ? 'One thing' : `${n} things`} came in while calls were off, ${items[0]?.at ? `since ${new Date(items[0].at).toLocaleString('en-GB', { weekday: 'long', hour: '2-digit', minute: '2-digit' })}` : 'overnight'}. ` +
      `Take them in order; after each, ask whether he wants anything done about it before moving on.\n\n`
    return head + items.map((i, k) => `${k + 1}. ${i.about ? `${i.about}. ` : ''}${i.text}`).join('\n\n') + `\n\nIt is ${at.toLocaleString('en-GB', { weekday: 'long', hour: '2-digit', minute: '2-digit' })}.`
  }

  /** Ring if there is anything queued and calls are allowed. */
  async function tick() {
    if (ringing) return
    const s = load()
    if (!s.items.length || !inCallHours() || Date.now() < (s.nextTryAt ?? 0)) return
    ringing = true
    try {
      const text = briefing(s.items)
      const r = await callMe(text)
      if (r.ok) {
        log(`[jarvis:phone] morning call answered, ${r.seconds}s — ${s.items.length} item(s)`)
        save({ items: [], attempts: 0, nextTryAt: 0 })
        return { rang: true, reply: r.reply }
      }
      const attempts = (s.attempts ?? 0) + 1
      if (attempts >= MAX_ATTEMPTS || r.noCredit) {
        log(`[jarvis:phone] morning call given up after ${attempts} attempt(s): ${r.why}`)
        await notify?.(`I could not reach you by phone this morning (${r.why}). The ${s.items.length} thing${s.items.length === 1 ? '' : 's'} I was going to ring about:\n\n${s.items.map((i, k) => `${k + 1}. ${i.about ? `${i.about}: ` : ''}${i.text.slice(0, 400)}`).join('\n\n')}`)
        save({ items: [], attempts: 0, nextTryAt: 0 })
        return { rang: false, why: r.why, gaveUp: true }
      }
      save({ ...s, attempts, nextTryAt: Date.now() + RETRY_MS })
      log(`[jarvis:phone] morning call not answered (${r.why}); trying again in 30 minutes`)
      return { rang: false, why: r.why }
    } finally {
      ringing = false
    }
  }

  return {
    add,
    list: () => load().items,
    clear: () => save({ items: [], attempts: 0, nextTryAt: 0 }),
    briefing,
    tick,
    start() {
      timer = setInterval(() => void tick(), 60_000)
    },
    stop() {
      if (timer) clearInterval(timer)
      timer = null
    },
  }
}
