import { createHash, randomBytes } from 'node:crypto'
import { calloutLine, labelFor, LINES, spokenMinutes } from './lines.mjs'

/**
 * Focus sessions: an accountability timer that watches where you actually are.
 *
 * Pure logic. The foreground reader and the clock are handed in, so the whole
 * thing runs in a test with no Windows and no waiting.
 *
 * THE PRIVACY LAW. A reading arrives with the app name and the site host in
 * plain text. Inside tick() they are hashed for comparison and turned into a
 * spoken label for at most one callout, and then they are gone: nothing in the
 * session state, the snapshot, the ledger or the logs holds an app or site
 * name. The snapshot the browser sees is booleans and counters only.
 */

// ---------------------------------------------------------------- knobs
// Colleague pace, not demo pace. Tune from real use, never from memory.

/** How often the reader reports. */
export const TICK_MS = 1000
/** A glance is not a drift. Away this long before the first callout. */
export const GRACE_MS = 8000
/** While one drift persists, repeat the callout this often. Voice-settable. */
export const NAG_EVERY_MS = 60_000
export const NAG_MIN_MS = 15_000
export const NAG_MAX_MS = 600_000
/** Consecutive ticks on one surface before a deferred lock settles on it. */
export const SETTLE_TICKS = 2
/** Never leave the JARVIS tab and the lock falls back to the browser app alone. */
export const APP_ONLY_AFTER_MS = 45_000
/** How long the no-wake-word answer window stays open after asking for intent. */
export const INTENT_WINDOW_MS = 20_000
/** A session at least this clean grows the streak. */
export const CLEAN_PERCENT = 85
/** Default session length when none is given. */
export const DEFAULT_MINUTES = 30
/** How recent a real surface must be for the card's LOCK THIS TAB to trust it. */
export const CARD_LOOKBACK_MS = 6000

const BROWSERS = new Set(['chrome', 'msedge', 'brave', 'vivaldi', 'opera'])
const HOME_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])
/** The JARVIS tab and its always-on-top card both count as home base. */
const HOME_TITLE = /J\.?A\.?R\.?V\.?I\.?S|localhost:(51|41)\d\d/i

// ---------------------------------------------------------------- engine

export function createFocusEngine({ now = () => Date.now(), onSay = () => {}, onEnd = () => {} } = {}) {
  // Salted per process, so a hash in memory cannot be looked up in a table.
  const salt = randomBytes(16)
  const hash = (s) => (s ? createHash('sha256').update(salt).update(s).digest('hex') : null)

  /** null when no session is running. */
  let s = null
  let lastTickAt = 0
  let readerOk = false

  const say = (text, extra = {}) => onSay({ text, ...extra })

  function classify(r) {
    if (!r || r.ok === false || !r.app) return { kind: 'unknown' }
    const browser = BROWSERS.has(r.app)
    const home =
      (browser && HOME_HOSTS.has(r.host)) || (browser && HOME_TITLE.test(r.title ?? ''))
    if (home) return { kind: 'home' }
    return {
      kind: 'surface',
      browser,
      app: hash(r.app),
      host: browser && r.host ? hash(r.host) : null,
    }
  }

  const onTarget = (c) => {
    const t = s.target
    if (!t || c.kind !== 'surface') return false
    if (c.app !== t.app) return false
    if (t.appOnly || !t.host) return true
    return c.host === t.host
  }

  function lockOn(c, { announce = true } = {}) {
    s.target = { app: c.app, host: c.appOnly ? null : c.host, appOnly: Boolean(c.appOnly) }
    s.deferred = false
    s.settleKey = null
    s.settleCount = 0
    if (announce) say(LINES.lockedOn)
  }

  function endExcursion() {
    s.excursion = null
    s.excused = false
  }

  function start({ minutes = DEFAULT_MINUTES, intent = '', style = 'butler', reading, fromButton = false } = {}) {
    if (s) return { ok: false, line: LINES.alreadyRunning }
    const t = now()
    const mins = Math.max(1, Math.min(240, Number(minutes) || DEFAULT_MINUTES))
    s = {
      startedAt: t,
      endsAt: t + mins * 60_000,
      plannedMs: mins * 60_000,
      paused: false,
      pausedAt: 0,
      intent: String(intent ?? '').trim().slice(0, 80),
      style: style === 'drill' ? 'drill' : 'butler',
      target: null,
      deferred: true,
      deferredSince: t,
      settleKey: null,
      settleCount: 0,
      awaitingIntentUntil: 0,
      onTargetMs: 0,
      activeMs: 0,
      adriftMs: 0,
      drifts: 0,
      calloutsGiven: 0,
      excursion: null,
      excused: false,
      snoozeUntil: 0,
      nagEveryMs: NAG_EVERY_MS,
      lastReal: null,
    }
    // Where you are when you ask is the target, unless that is JARVIS himself —
    // the FOCUS button lives in his tab, so locking "the active tab" at click
    // time would lock the one place you are guaranteed to leave.
    const c = classify(reading)
    if (!fromButton && c.kind === 'surface') {
      lockOn(c, { announce: false })
      return { ok: true, line: `Locked on, sir. ${spokenMinutes(mins)}.`, deferred: false }
    }
    if (!s.intent) {
      s.awaitingIntentUntil = t + INTENT_WINDOW_MS
      return { ok: true, line: LINES.deferredAskIntent, deferred: true, listen: true }
    }
    return { ok: true, line: LINES.deferred, deferred: true }
  }

  function tick(reading) {
    const t = now()
    const dt = lastTickAt ? Math.min(t - lastTickAt, 5000) : 0
    lastTickAt = t
    readerOk = Boolean(reading && reading.ok !== false)
    if (!s) return

    if (s.paused) return

    if (t >= s.endsAt) return finish(true)

    const c = classify(reading)
    if (c.kind === 'surface') s.lastReal = { at: t, app: c.app, host: c.host, browser: c.browser }

    // --- deferred lock: wait for the user to settle somewhere real.
    if (s.deferred) {
      if (c.kind === 'surface') {
        const key = `${c.app}|${c.host ?? ''}`
        s.settleCount = s.settleKey === key ? s.settleCount + 1 : 1
        s.settleKey = key
        if (s.settleCount >= SETTLE_TICKS) lockOn(c)
      } else {
        s.settleKey = null
        s.settleCount = 0
        if (c.kind === 'home' && t - s.deferredSince >= APP_ONLY_AFTER_MS) {
          // Never left. Hold them to the browser app rather than to nothing.
          const app = hash(reading.app)
          s.target = { app, host: null, appOnly: true }
          s.deferred = false
          say(LINES.appOnly)
        }
      }
      return
    }

    s.activeMs += dt

    if (c.kind === 'unknown') return
    if (c.kind === 'home') {
      // Coming back to talk to him is never a drift.
      endExcursion()
      return
    }
    if (onTarget(c)) {
      s.onTargetMs += dt
      endExcursion()
      return
    }

    // --- adrift.
    if (!s.excursion) s.excursion = { since: t, calls: 0, lastCallAt: 0, adriftMs: 0 }
    const x = s.excursion
    if (x.calls > 0) {
      x.adriftMs += dt
      s.adriftMs += dt
    }
    if (s.excused || t < s.snoozeUntil) return

    const due =
      x.calls === 0 ? t - x.since >= GRACE_MS : t - x.lastCallAt >= s.nagEveryMs
    if (!due) return

    if (x.calls === 0) {
      s.drifts += 1
      // The grace period was spent adrift too; it counts once the drift is real.
      x.adriftMs += t - x.since
      s.adriftMs += t - x.since
    }
    // The label is derived here, spoken, and never assigned to anything that
    // outlives this call.
    say(
      calloutLine({
        tier: s.drifts,
        label: labelFor({ app: reading.app, host: reading.host, browser: c.browser }),
        intent: s.intent,
        firstOfSession: s.calloutsGiven === 0,
        style: s.style,
      }),
      { drift: true },
    )
    s.calloutsGiven += 1
    x.calls += 1
    x.lastCallAt = t
  }

  function finish(completed) {
    const done = s
    s = null
    const clean = done.onTargetMs + done.adriftMs
    const record = {
      ts: new Date(now()).toISOString(),
      plannedMin: Math.round(done.plannedMs / 60_000),
      activeMin: Math.round(done.activeMs / 60_000),
      onTargetMin: Math.round(done.onTargetMs / 60_000),
      drifts: done.drifts,
      secondsAdrift: Math.round(done.adriftMs / 1000),
      percent: clean > 0 ? Math.round((done.onTargetMs / clean) * 100) : 0,
      completed,
    }
    onEnd(record)
    return record
  }

  /** Every voice or button action that changes a running session. */
  function control(action, { minutes, seconds, reading, fromCard = false } = {}) {
    if (!s && action !== 'status') return { ok: false, line: LINES.noSession }
    const t = now()
    switch (action) {
      case 'pause':
        if (!s.paused) {
          s.paused = true
          s.pausedAt = t
        }
        return { ok: true, line: LINES.paused }
      case 'resume':
        if (s.paused) {
          s.endsAt += t - s.pausedAt
          s.paused = false
          lastTickAt = t
        }
        return { ok: true, line: LINES.resumed }
      case 'extend': {
        const m = Math.max(1, Math.min(120, Number(minutes) || 10))
        s.endsAt += m * 60_000
        s.plannedMs += m * 60_000
        return { ok: true, line: `Another ${spokenMinutes(m)}, sir.` }
      }
      case 'abort': {
        finish(false)
        return { ok: true, line: LINES.aborted }
      }
      case 'snooze': {
        const sec = Math.max(5, Math.min(900, Number(seconds) || 60))
        s.snoozeUntil = t + sec * 1000
        return { ok: true, line: `${sec} seconds, sir.` }
      }
      case 'excuse': {
        // Refund the excursion in progress and stay quiet until they are back.
        if (s.excursion) {
          s.adriftMs = Math.max(0, s.adriftMs - s.excursion.adriftMs)
          if (s.excursion.calls > 0) s.drifts = Math.max(0, s.drifts - 1)
        }
        s.excused = true
        return { ok: true, line: LINES.excused }
      }
      case 'cadence': {
        const sec = Math.max(NAG_MIN_MS / 1000, Math.min(NAG_MAX_MS / 1000, Number(seconds) || 60))
        s.nagEveryMs = sec * 1000
        return { ok: true, line: `Every ${sec} seconds, sir.` }
      }
      case 'lock_here': {
        // A click on the always-on-top card makes the card itself the front
        // window, so from the card "here" means the last real surface before
        // the click, not whatever is frontmost now.
        const c = fromCard ? null : classify(reading)
        const recent = s.lastReal && t - s.lastReal.at <= CARD_LOOKBACK_MS ? s.lastReal : null
        const where = c?.kind === 'surface' ? c : fromCard ? recent : null
        if (!where) {
          s.target = null
          s.deferred = true
          s.deferredSince = t
          s.settleKey = null
          s.settleCount = 0
          endExcursion()
          return { ok: true, line: LINES.deferred, deferred: true }
        }
        if (s.excursion) {
          s.adriftMs = Math.max(0, s.adriftMs - s.excursion.adriftMs)
          if (s.excursion.calls > 0) s.drifts = Math.max(0, s.drifts - 1)
        }
        endExcursion()
        lockOn(where, { announce: false })
        return { ok: true, line: LINES.lockedOn }
      }
      case 'status':
        return { ok: true, line: s ? statusLine() : LINES.noSession }
      default:
        return { ok: false, line: `I do not know how to ${action}, sir.` }
    }
  }

  function statusLine() {
    const left = Math.max(0, s.endsAt - now())
    return (
      `${spokenMinutes(left / 60_000)} left, sir. ` +
      `${spokenMinutes(s.onTargetMs / 60_000)} on target, ` +
      `${s.drifts} drift${s.drifts === 1 ? '' : 's'}.`
    )
  }

  /** Is the no-wake-word answer window open? Consuming it closes it. */
  function takeIntent(text) {
    if (!s || !s.awaitingIntentUntil || now() > s.awaitingIntentUntil) return false
    s.intent = String(text ?? '').trim().slice(0, 80)
    s.awaitingIntentUntil = 0
    return true
  }

  /**
   * What the browser is allowed to know: booleans and counters only. No app,
   * no site, no hash, no label, no intent — the test in scripts/ proves it.
   */
  function snapshot() {
    const t = now()
    if (!s) return { active: false }
    const adrift = Boolean(s.excursion && s.excursion.calls > 0)
    return {
      active: true,
      paused: s.paused,
      deferred: s.deferred,
      settleTicks: s.settleCount,
      locked: Boolean(s.target),
      appOnly: Boolean(s.target?.appOnly),
      awaitingIntent: Boolean(s.awaitingIntentUntil && t <= s.awaitingIntentUntil),
      adrift,
      excused: s.excused,
      snoozed: t < s.snoozeUntil,
      remainingMs: Math.max(0, s.endsAt - (s.paused ? s.pausedAt : t)),
      plannedMs: s.plannedMs,
      onTargetMs: s.onTargetMs,
      adriftMs: s.adriftMs,
      drifts: s.drifts,
      nagEveryMs: s.nagEveryMs,
    }
  }

  /** For the diag endpoint: health of the machinery, still no identities. */
  function diag() {
    return {
      sessionOn: Boolean(s),
      readerOk,
      lastTickAgeMs: lastTickAt ? now() - lastTickAt : null,
      ...(s
        ? {
            deferred: s.deferred,
            settleTicks: s.settleCount,
            appTarget: Boolean(s.target),
            tabTarget: Boolean(s.target?.host),
            paused: s.paused,
          }
        : {}),
    }
  }

  return {
    start,
    tick,
    control,
    takeIntent,
    snapshot,
    diag,
    get running() {
      return Boolean(s)
    },
  }
}

/** Streak: consecutive completed, clean sessions counting back from the latest. */
export function streakOf(ledger) {
  let n = 0
  for (let i = ledger.length - 1; i >= 0; i--) {
    const r = ledger[i]
    if (r.completed && r.percent >= CLEAN_PERCENT) n++
    else break
  }
  return n
}

export function reportLine(record, streak) {
  const on = spokenMinutes(record.onTargetMin)
  const drifts = `${record.drifts} drift${record.drifts === 1 ? '' : 's'}`
  const tail =
    record.percent >= CLEAN_PERCENT
      ? streak > 1
        ? ` Clean session. That is ${streak} in a row, sir.`
        : ' Clean session, sir.'
      : ' Not your cleanest, sir.'
  return `Session complete. ${on} on target out of ${record.plannedMin}, ${drifts}.${tail}`
}
