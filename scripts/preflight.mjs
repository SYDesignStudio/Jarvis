/**
 * Preflight: every live chain, end to end, against the RUNNING system.
 *
 * Not unit tests and not mocks. The failures that hurt are the ones where every
 * unit test passes and a real chain is dead — a bridge still running last
 * week's code, a model that is not the one configured, a key the browser can
 * read. Each check is a real call.
 *
 *   npm run preflight            full run (one short paid turn, ~a few pence)
 *   npm run preflight -- --free  skip the paid turn
 *
 * Exits non-zero on any failure. "Done" means this passed.
 */
import { spawn, spawnSync } from 'node:child_process'
import { accessSync, constants, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { JOBS_FILE } from '../bridge/paths.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(join(ROOT, 'package.json'))
const WebSocket = require('ws')

const FACE = 'http://localhost:5173'
const BRIDGE = 'http://localhost:8787'
const WS = 'ws://localhost:8787'
const ORIGIN = FACE
const FREE = process.argv.includes('--free')
const NOTIFY = process.argv.includes('--notify') || process.argv.includes('--call')
const CALL = process.argv.includes('--call')

let pass = 0
let fail = 0
let warn = 0
const ok = (m) => (pass++, console.log(`  \x1b[32m✓\x1b[0m ${m}`))
const bad = (m, fix) => (fail++, console.log(`  \x1b[31m✗\x1b[0m ${m}${fix ? `\n      → ${fix}` : ''}`))
const meh = (m) => (warn++, console.log(`  \x1b[33m!\x1b[0m ${m}`))
const section = (t) => console.log(`\n${t}`)

const get = (url, opts = {}) =>
  fetch(url, { ...opts, signal: AbortSignal.timeout(opts.timeout ?? 8000) })

function envLocal() {
  const out = {}
  try {
    for (const line of readFileSync(join(ROOT, '.env.local'), 'utf8').split(/\r?\n/)) {
      const m = /^\s*([\w.-]+)\s*=\s*(.*?)\s*$/.exec(line)
      if (m && !m[1].startsWith('#')) out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2')
    }
  } catch {
    /* no file is fine */
  }
  return out
}

function newestMtime(dir, match) {
  let newest = 0
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) newest = Math.max(newest, newestMtime(p, match))
    else if (match.test(name)) newest = Math.max(newest, st.mtimeMs)
  }
  return newest
}

const env = envLocal()
const expectedModel = process.env.JARVIS_MODEL ?? env.JARVIS_MODEL ?? 'claude-opus-5'

// ------------------------------------------------------------------ face
section('Face')
try {
  const r = await get(`${FACE}/`)
  const html = await r.text()
  if (r.ok && html.includes('J.A.R.V.I.S')) ok('the interface is served on :5173')
  else bad(`the interface answered ${r.status} without the JARVIS page`)
} catch {
  bad('nothing is serving the interface on :5173', 'start JARVIS: npm.cmd start')
}

// ------------------------------------------------------------------ bridge
section('Bridge')
let diag = null
try {
  const h = await (await get(`${BRIDGE}/health`)).json()
  if (h.ok) ok('the bridge is up on :8787')
  else bad('the bridge answered /health without ok')
} catch {
  bad('the bridge is not reachable on :8787', 'start JARVIS: npm.cmd start')
}
try {
  diag = await (await get(`${BRIDGE}/diag`)).json()
} catch {
  bad('the bridge has no /diag — it is running code from before this preflight existed', 'restart JARVIS')
}

if (diag) {
  const newestCode = Math.max(
    newestMtime(join(ROOT, 'bridge'), /\.(mjs|ps1)$/),
    (() => {
      try {
        return statSync(join(ROOT, '.env.local')).mtimeMs
      } catch {
        return 0
      }
    })(),
  )
  if (diag.bootedAt >= newestCode) ok('the running bridge is newer than every bridge file and .env.local')
  else
    bad(
      `the bridge started ${new Date(diag.bootedAt).toLocaleTimeString()} but files changed at ` +
        `${new Date(newestCode).toLocaleTimeString()} — it is running old code or old settings`,
      'restart it from anywhere — press D in JARVIS → Restart JARVIS, or text "restart" to the Telegram bot; or at the PC: Ctrl+C, then npm.cmd start',
    )

  if (diag.configuredModel === expectedModel) ok(`configured model is ${diag.configuredModel}`)
  else bad(`the bridge is configured for ${diag.configuredModel}, .env.local says ${expectedModel}`, 'restart JARVIS')

  ok(`speech out: ${diag.tts} · speech in: ${diag.stt} · writes ${diag.writes ? 'ON' : 'off'} · effort ${diag.effort}`)
  if (diag.personality) ok(`personality: ${diag.personality === 'film' ? 'film JARVIS (dry wit, pushes back) — say "classic mode" to go back' : 'classic JARVIS — say "film mode" for the wit'}`)
  if (diag.knowledge) {
    const k = diag.knowledge
    ok(`knowledge: ${k.outcomes} outcome(s), ${k.approved} lesson(s) approved, ${k.pending} awaiting your yes/no on Telegram · ${k.jobsDone} job(s) caught up · $${k.spent.toFixed(2)} spent`)
  } else if (diag.knowledge === null) {
    meh('knowledge: the store could not be read (the KNOWLEDGE folder)')
  }
  if (diag.specline) {
    if (!diag.specline.configured) meh('Specline: not connected — generate a key in Specline → Admin → Settings → Your desk assistant, add it to .env.local as SPECLINE_AGENT_KEY')
    else {
      try {
        const r = await get(`${BRIDGE}/specline`)
        const o = await r.json()
        if (r.ok) ok(`Specline connected — ${o.counts.accounts} account(s), ${o.counts.practices} practice(s), ${o.counts.messages_new} new message(s); press P for the dashboard`)
        else bad(`Specline: ${o.error}`, 'check the key in .env.local against Specline → Admin → Settings')
      } catch (err) {
        bad(`Specline could not be read: ${err.message}`)
      }
    }
  }
}

// ------------------------------------------------------------------ voice
section('Voice')
try {
  const r = await get(`${BRIDGE}/tts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN },
    body: JSON.stringify({ text: 'Preflight.' }),
    timeout: 30000,
  })
  const buf = Buffer.from(await r.arrayBuffer())
  if (r.ok && (r.headers.get('content-type') ?? '').includes('audio') && buf.length > 1000) {
    ok(`/tts returns real audio (${buf.length} bytes)`)
  } else if (r.status === 503) {
    meh('no cloud voice configured — JARVIS speaks with the browser voice')
  } else {
    bad(`/tts answered ${r.status}: ${buf.toString('utf8').slice(0, 140)}`)
  }
} catch (err) {
  bad(`/tts failed: ${err.message}`)
}

// ------------------------------------------------------------------ brain
section('Brain')
if (FREE) {
  meh('skipped the live turn (--free)')
} else {
  await new Promise((done) => {
    const ws = new WebSocket(WS, { headers: { origin: ORIGIN } })
    let text = ''
    const t = setTimeout(() => {
      bad('no answer from the brain within 150 s')
      ws.terminate()
      done()
    }, 150_000)
    ws.on('open', () => ws.send(JSON.stringify({ type: 'ask', id: 'preflight', text: 'Reply with the single word: ready.' })))
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString())
      if (m.ask && m.ask !== 'preflight') return
      if (m.type === 'text') text += m.delta
      if (m.type === 'error') {
        clearTimeout(t)
        bad(`the turn failed: ${m.message}`, /log(ged)? in|login/i.test(m.message) ? 'run claude.cmd and log in' : undefined)
        ws.close()
        done()
      }
      if (m.type === 'done') {
        clearTimeout(t)
        const said = (text || m.text || '').trim()
        if (/ready/i.test(said)) ok(`a real turn answered "${said.slice(0, 40)}"${m.costUsd ? ` ($${m.costUsd.toFixed(3)})` : ''}`)
        else bad(`the turn answered "${said.slice(0, 120)}" instead of "ready"`)
        if (m.model === expectedModel) ok(`the answer came from ${m.model}`)
        else if (m.model) bad(`the answer came from ${m.model}, expected ${expectedModel}`, 'restart JARVIS so it reads .env.local')
        else meh('the bridge did not report which model answered')
        ws.close()
        done()
      }
    })
    ws.on('error', (e) => {
      clearTimeout(t)
      bad(`could not open the agent socket: ${e.message}`)
      done()
    })
  })
}

// ------------------------------------------------------------------ security
section('Secrets and boundaries')
const secret = env.FISH_AUDIO_API_KEY || env.ELEVENLABS_API_KEY || 'FISH_AUDIO_API_KEY'
const envPath = join(ROOT, '.env.local').replace(/\\/g, '/')
for (const [label, url] of [
  ['/.env.local', `${FACE}/.env.local`],
  ['/@fs path', `${FACE}/@fs/${envPath}`],
  ['bridge /file', `${BRIDGE}/file?path=${encodeURIComponent(join(ROOT, '.env.local'))}`],
]) {
  try {
    const body = await (await get(url)).text()
    if (body.includes(secret) || body.includes('FISH_AUDIO_API_KEY')) bad(`.env.local is readable through ${label}`, 'this is a leak — stop JARVIS and report it')
    else ok(`.env.local is not readable through ${label}`)
  } catch {
    ok(`.env.local is not readable through ${label}`)
  }
}
await new Promise((done) => {
  const ws = new WebSocket(WS, { headers: { origin: 'https://evil.example' } })
  const t = setTimeout(() => {
    bad('a foreign-origin socket was neither accepted nor refused')
    ws.terminate()
    done()
  }, 5000)
  ws.on('open', () => {
    clearTimeout(t)
    bad('a page on another origin could open the agent socket')
    ws.close()
    done()
  })
  ws.on('error', () => {
    clearTimeout(t)
    ok('a page on another origin is refused the agent socket')
    done()
  })
})

// ------------------------------------------------------------------ organs
section('Organs')
try {
  const fd = await (await get(`${BRIDGE}/focus/diag`)).json()
  ok(`focus timer reachable (session ${fd.sessionOn ? 'running' : 'off'})`)
} catch {
  bad('the bridge has no focus endpoint', 'restart JARVIS')
}

// The foreground reader, for real, for three seconds — PowerShell, so the PC only.
if (process.platform === 'win32') await new Promise((done) => {
  const script = readFileSync(join(ROOT, 'bridge', 'focus', 'foreground.ps1'), 'utf8')
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'ignore'],
  })
  let lines = 0
  let good = 0
  child.stdout.on('data', (d) => {
    for (const l of d.toString().split(/\r?\n/)) {
      if (!l.startsWith('{')) continue
      lines++
      try {
        const r = JSON.parse(l)
        if (r.ok && r.app) good++
      } catch {
        /* torn */
      }
    }
  })
  setTimeout(() => {
    child.kill()
    if (good > 0) ok(`the Windows window reader works (${good}/${lines} readings)`)
    else bad('the Windows window reader produced no readings', 'focus sessions cannot see which window you are on')
    done()
  }, 4500)
})

try {
  accessSync(JOBS_FILE, constants.W_OK)
  ok('JOBS.md is writable for "remember that"')
} catch {
  bad('JOBS.md is missing or read-only — "remember that" would fail')
}

// Calls and voice notes are heard on this PC: speak a known sentence with
// Windows' own voice and make sure the local transcriber hears it back.
{
  const { mkdtempSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const dir = mkdtempSync(join(tmpdir(), 'jarvis-preflight-'))
  const wav = join(dir, 'check.wav')
  const said = 'Site visit on Tuesday at ten.'
  const ps = spawnSync(
    'powershell',
    ['-NoProfile', '-Command', `Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.SetOutputToWaveFile('${wav}'); $s.Speak('${said}'); $s.Dispose()`],
    { windowsHide: true, timeout: 60_000 },
  )
  if (ps.status !== 0) meh('could not make a test recording for the call transcriber (Windows speech unavailable)')
  else {
    const t0 = Date.now()
    const r = spawnSync(process.env.JARVIS_PYTHON ?? 'py', [join(ROOT, 'bridge', 'calls', 'transcribe.py'), wav], {
      windowsHide: true,
      timeout: 10 * 60_000,
      encoding: 'utf8',
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    })
    let data = {}
    try {
      data = JSON.parse(String(r.stdout).trim().split('\n').pop())
    } catch {}
    if (/tuesday/i.test(data.text ?? '') && /visit/i.test(data.text ?? '')) {
      ok(`calls and voice notes are transcribed on this PC (${data.model} on ${data.device === 'cuda' ? 'the graphics card' : 'the CPU'}, ${((Date.now() - t0) / 1000).toFixed(1)} s)`)
      if (data.device !== 'cuda') meh('the transcriber fell back to the CPU — slower; check the NVIDIA libraries (pip nvidia-cublas-cu12 nvidia-cudnn-cu12)')
    } else {
      bad(`the local call transcriber did not hear the test sentence (${data.error ?? (data.text || 'no output')})`, 'py -m pip install --user faster-whisper nvidia-cublas-cu12 "nvidia-cudnn-cu12>=9,<10"')
    }
  }
  rmSync(dir, { recursive: true, force: true })
}

// Project memory reads the NAS job folders.
{
  const { listJobs, nasReachable, JOB_ROOTS } = await import('../bridge/memory/jobs.mjs')
  if (!nasReachable()) bad(`the NAS job folders are not reachable (${JOB_ROOTS[0]})`, 'is the NAS on and the PC on the office network?')
  else ok(`NAS job folders reachable — ${listJobs({ fresh: true }).length} jobs (read-only for JARVIS)`)
}

// JARVIS's own Chrome: is it installed, and is the window already up?
{
  const { browserStatus } = await import('../bridge/browser.mjs')
  const b = await browserStatus()
  if (!b.chrome) bad('Chrome is not installed where the browser tools expect it', 'set JARVIS_CHROME_EXE in .env.local to the Chrome executable')
  else ok(`browser: Chrome ${b.running ? `window up on 127.0.0.1:${b.port}` : 'installed — the JARVIS window opens on first use'} (profile ${b.profile})`)
}

// The iPhone calendar (iCloud CalDAV) — connect and list calendars; nothing is written.
{
  const cal = await import('../bridge/calendar.mjs')
  const calEnv = { ...process.env, ...env }
  if (!cal.calendarConfigured(calEnv)) meh('iPhone calendar not connected — add ICLOUD_USER and ICLOUD_APP_PASSWORD (an Apple app-specific password) to .env.local')
  else {
    try {
      const cals = await cal.listCalendars(calEnv)
      const target = await cal.targetCalendar(calEnv)
      const names = cals.map((c) => (typeof c.displayName === 'string' ? c.displayName : '?'))
      ok(`iPhone calendar connected — ${cals.length} calendar(s): ${names.join(', ')}; new events go in "${typeof target?.displayName === 'string' ? target.displayName : '?'}"`)
    } catch (err) {
      bad(`iPhone calendar did not connect: ${err.message}`, 'check ICLOUD_USER is your Apple ID email and ICLOUD_APP_PASSWORD is an app-specific password (xxxx-xxxx-xxxx-xxxx)')
    }
  }
}

meh('screen share cannot be tested headless — press S in JARVIS and ask "what am I looking at"')

// ------------------------------------------------------------------ beyond the desk
section('Telegram, inbox, phone')
const s = diag?.surfaces
if (diag?.satellite) {
  ok('satellite: the PC owns Telegram polling, the inbox watchers and the background sweeps; this JARVIS reads mail and messages you when asked')
  if (s?.telegram?.configured && s.telegram.ok) ok(`Telegram bot @${s.telegram.username} can be messaged from here`)
  const boxes = Array.isArray(s?.mail) ? s.mail : []
  if (boxes.length) ok(`${boxes.length} inbox${boxes.length === 1 ? '' : 'es'} readable on request: ${boxes.map((m) => m.user).join(', ')}`)
} else if (!s) {
  meh('the running bridge reports no surfaces — restart JARVIS')
} else {
  if (!s.telegram.configured) meh('Telegram not configured (TELEGRAM_BOT_TOKEN)')
  else if (!s.telegram.ok) bad('the Telegram token was rejected', 'check TELEGRAM_BOT_TOKEN from @BotFather')
  else if (!s.telegram.chatId) bad(`Telegram bot @${s.telegram.username} is live but has no chat id`, 'send the bot a message, then put the id it replies with in TELEGRAM_CHAT_ID')
  else ok(`Telegram bot @${s.telegram.username} is live and knows your chat (voice in: ${s.telegram.voiceIn ? 'yes' : 'no'}, voice out: ${s.telegram.voiceOut ? 'yes' : 'no'})`)

  const boxes = Array.isArray(s.mail) ? s.mail : s.mail?.configured ? [s.mail] : []
  if (!boxes.length) meh('inbox watching not configured (GMAIL_USER / GMAIL_APP_PASSWORD, or MAIL_1_USER…)')
  for (const m of boxes) {
    if (!m.at) meh(`inbox ${m.user}: first check has not run yet`)
    else if (!m.ok) bad(`inbox ${m.user}: last check failed — ${m.error}`, /auth|login|credential/i.test(m.error) ? 'the password is wrong, or IMAP is off for that account' : undefined)
    else ok(`inbox ${m.user} checked ${Math.round(m.lastCheckAgeMs / 60000)} min ago (${m.important} important of ${m.seen} new)`)
  }

  if (!s.phone.configured) meh('phone alerts not configured (RETELL_API_KEY, RETELL_FROM_NUMBER, JARVIS_MY_NUMBER)')
  else ok(`phone alerts configured${s.phone.agent ? ', Retell agent created' : ' (agent will be created on first call)'}${s.phone.inCallHours ? '' : ' — outside call hours now'}`)

  if (NOTIFY && s.telegram.configured) {
    try {
      const r = await (await get(`${BRIDGE}/surfaces/test`, { method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN }, body: JSON.stringify({ call: CALL }), timeout: 5 * 60_000 })).json()
      if (r.telegram) ok('a real Telegram message was delivered')
      else bad('the Telegram test message was not delivered')
      if (CALL) {
        if (r.call?.ok) ok(`a real test call was answered (${r.call.seconds}s)${r.call.reply ? ` — you said "${r.call.reply}"` : ''}`)
        else bad(`the test call did not go through: ${r.call?.why ?? 'unknown'}`)
      }
    } catch (err) {
      bad(`surface test failed: ${err.message}`)
    }
  } else if (s.telegram.configured) {
    meh('add --notify to send a real Telegram test message, --call to ring you')
  }
}

// ------------------------------------------------------------------ logic
section('Logic')
for (const file of ['test-focus.mjs', 'test-units.mjs', 'test-surfaces.mjs', 'test-research.mjs']) {
  const r = spawnSync(process.execPath, [join(ROOT, 'scripts', file)], { encoding: 'utf8' })
  const summary = (r.stdout.trim().split('\n').pop() ?? '').trim()
  if (r.status === 0) ok(summary)
  else bad(`${file}: ${summary}`, `node scripts/${file} for details`)
}

console.log(`\n${pass} pass, ${fail} fail, ${warn} warn`)
process.exit(fail ? 1 : 0)
