import { spawn } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { createFocusEngine, reportLine, streakOf, TICK_MS } from './engine.mjs'

/**
 * Focus sessions, wired to the machine: the Windows foreground reader, the
 * aggregates-only ledger, the voice tools, and the button endpoint.
 *
 * The session lives here, in the bridge, not in the page — so reloading the
 * tab rejoins it and the countdown never dies with a browser crash.
 */

const HERE = dirname(fileURLToPath(import.meta.url))
const LEDGER = join(HERE, '..', '..', 'data', 'focus-ledger.json')

/** The only keys a ledger record may carry. Anything else is dropped on write. */
export const LEDGER_KEYS = [
  'ts', 'plannedMin', 'activeMin', 'onTargetMin', 'drifts', 'secondsAdrift', 'percent', 'completed',
]

export function readLedger(path = LEDGER) {
  try {
    const rows = JSON.parse(readFileSync(path, 'utf8'))
    return Array.isArray(rows) ? rows : []
  } catch {
    return []
  }
}

export function appendLedger(record, path = LEDGER) {
  const clean = {}
  for (const k of LEDGER_KEYS) if (k in record) clean[k] = record[k]
  const rows = [...readLedger(path), clean].slice(-500)
  mkdirSync(dirname(path), { recursive: true })
  // Written aside and renamed, so a crash mid-write cannot leave half a ledger.
  writeFileSync(`${path}.tmp`, JSON.stringify(rows, null, 2))
  renameSync(`${path}.tmp`, path)
  return rows
}

// ---------------------------------------------------------------- reader

/**
 * The foreground reader: one long-lived PowerShell that re-queries the front
 * window every tick and prints a JSON line. Passed as -EncodedCommand, which
 * the machine's script-execution policy does not apply to, so nothing about
 * the system's settings has to change for it to run.
 */
function startReader(onReading) {
  // PowerShell reads the front window; there is no reader on the Mac yet.
  if (process.platform !== 'win32') return null
  const script = readFileSync(join(HERE, 'foreground.ps1'), 'utf8')
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  const child = spawn(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] },
  )
  let buf = ''
  child.stdout.on('data', (d) => {
    buf += d.toString()
    let nl
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      if (!line.startsWith('{')) continue
      try {
        onReading(JSON.parse(line))
      } catch {
        /* a torn line; the next tick replaces it */
      }
    }
  })
  child.on('error', (err) => console.error('[jarvis] focus reader failed:', err.message))
  return child
}

// ---------------------------------------------------------------- wiring

/**
 * @param {object} io
 * @param {(frame: object) => void} io.broadcast  send a frame to every open page
 */
export function createFocus({ broadcast }) {
  let reader = null
  /** The latest reading, held only until the next one replaces it. */
  let latest = null
  let latestAt = 0
  let ticker = null
  /** Older than this and the reader has stalled: the tick reads as unknown. */
  const STALE_MS = TICK_MS * 3

  const engine = createFocusEngine({
    onSay: ({ text, listen, drift }) => broadcast({ type: 'say', text, listen: Boolean(listen), drift: Boolean(drift) }),
    onEnd: (record) => {
      stopMachinery()
      const rows = appendLedger(record)
      broadcast({
        type: 'say',
        text: record.completed ? reportLine(record, streakOf(rows)) : '',
        listen: false,
      })
      broadcast({ type: 'focus', state: engine.snapshot() })
    },
  })

  function startMachinery() {
    if (reader) return
    reader = startReader((r) => {
      latest = r
      latestAt = Date.now()
    })
    reader.on('exit', () => {
      reader = null
    })
    // The engine ticks on our clock, not the reader's: a reader that stalls
    // still produces ticks, and a stale reading is handed over as unknown
    // rather than replayed as if it were current.
    ticker = setInterval(() => {
      engine.tick(Date.now() - latestAt <= STALE_MS ? latest : null)
      broadcast({ type: 'focus', state: engine.snapshot() })
    }, TICK_MS)
  }

  function stopMachinery() {
    if (ticker) clearInterval(ticker)
    ticker = null
    reader?.kill()
    reader = null
    latest = null
    latestAt = 0
  }

  /**
   * A fresh reading for a voice command — "lock on this tab" means the tab in
   * front NOW. Waits for a reader line newer than the request rather than
   * trusting the last one.
   */
  const freshReading = (waitMs = TICK_MS * 2.5) =>
    new Promise((resolve) => {
      if (!reader) return resolve(null)
      const asked = Date.now()
      const poll = setInterval(() => {
        const fresh = latestAt > asked
        if (fresh || Date.now() - asked > waitMs) {
          clearInterval(poll)
          resolve(fresh ? latest : null)
        }
      }, 50)
    })

  async function start(opts) {
    // The reader has to be running before the start decision, so "thirty
    // minutes on this" said from a work tab locks that tab immediately.
    startMachinery()
    // A cold reader spends a second or two compiling its helper before the
    // first line, so the very first read gets a longer wait.
    const reading = opts.fromButton ? null : await freshReading(6000)
    const res = engine.start({ ...opts, reading })
    if (!res.ok && !engine.running) stopMachinery()
    broadcast({ type: 'focus', state: engine.snapshot() })
    return res
  }

  async function control(action, opts = {}) {
    const reading = action === 'lock_here' && !opts.fromCard ? await freshReading() : null
    const res = engine.control(action, { ...opts, reading })
    if (!engine.running) stopMachinery()
    broadcast({ type: 'focus', state: engine.snapshot() })
    return res
  }

  // -------------------------------------------------------------- tools

  const said = (res) => ({
    content: [
      {
        type: 'text',
        text:
          `Say exactly this and nothing else: "${res.line}"` +
          (res.deferred
            ? ' The session is waiting for the user to go to their work before it locks on.'
            : ''),
      },
    ],
  })

  // Built per connection: one MCP server object serves one agent session, while
  // the focus session behind it is shared by every open page.
  const makeServer = () => createSdkMcpServer({
    name: 'jarvis_focus',
    version: '1.0.0',
    instructions:
      'Focus sessions: an accountability timer that watches which window and site ' +
      'the user is on and calls out drift by name. Use these tools for anything ' +
      'about a focus session, timer on work, "keep me on this", or locking a tab.',
    alwaysLoad: true,
    tools: [
      tool(
        'focus_start',
        'Start a focus session. Use for "thirty minutes on this", "keep me focused", ' +
          '"start a focus session", "time me on the drawings". If they said what the ' +
          'work is, pass it as intent in their own words (short). style "drill" only ' +
          'if they ask to be shouted at.',
        {
          minutes: z.union([z.number(), z.string()]).optional().catch(undefined),
          intent: z.string().optional().catch(undefined),
          style: z.enum(['butler', 'drill']).optional().catch(undefined),
        },
        async (a) => said(await start({ minutes: Number(a.minutes) || undefined, intent: a.intent, style: a.style })),
      ),
      tool(
        'focus_control',
        'Change the running focus session. Actions: ' +
          'pause, resume, extend (minutes), abort, status; ' +
          'snooze (seconds) for "give me fifteen seconds"; ' +
          'excuse for "it\'s okay, I\'m doing research" — forgives the current drift; ' +
          'cadence (seconds) for "call me out every thirty seconds"; ' +
          'lock_here for "lock on this tab", "keep me in this tab", "this is the tab", ' +
          '"stay on this tab". To change the target the user goes to the tab and says ' +
          '"lock on this tab" — never tell them to click FOCUS again or restart.',
        {
          action: z.enum(['pause', 'resume', 'extend', 'abort', 'status', 'snooze', 'excuse', 'cadence', 'lock_here']),
          minutes: z.union([z.number(), z.string()]).optional().catch(undefined),
          seconds: z.union([z.number(), z.string()]).optional().catch(undefined),
        },
        async (a) => said(await control(a.action, { minutes: a.minutes, seconds: a.seconds })),
      ),
    ],
  })

  return {
    makeServer,
    start,
    control,
    snapshot: () => engine.snapshot(),
    diag: () => ({ ...engine.diag(), readerRunning: Boolean(reader) }),
    takeIntent: (text) => {
      const ok = engine.takeIntent(text)
      if (ok) broadcast({ type: 'focus', state: engine.snapshot() })
      return ok
    },
    stop: stopMachinery,
  }
}
