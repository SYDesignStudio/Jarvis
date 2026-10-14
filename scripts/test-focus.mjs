/**
 * Focus engine tests. Pure logic with a fake clock — no Windows reader, no
 * bridge, no waiting. `node scripts/test-focus.mjs`; exits non-zero on failure.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFocusEngine, GRACE_MS, NAG_EVERY_MS, APP_ONLY_AFTER_MS, streakOf } from '../bridge/focus/engine.mjs'
import { appendLedger, LEDGER_KEYS } from '../bridge/focus/index.mjs'

/** Nobody would ever write this in canned text, so finding it means it leaked. */
const SECRET_HOST = 'zorblax-quintessa.test'
const SECRET_APP = 'quibbleframe'

const home = { ok: true, app: 'chrome', host: 'localhost', title: 'J.A.R.V.I.S. - Google Chrome' }
const work = { ok: true, app: 'chrome', host: 'planningportal.co.uk', title: 'Planning Portal' }
const cad = { ok: true, app: 'acad', host: '', title: 'Drawing1.dwg' }
const secretSite = { ok: true, app: 'chrome', host: SECRET_HOST, title: 'Zorblax' }
const secretApp = { ok: true, app: SECRET_APP, host: '', title: 'Quibbleframe' }

function rig() {
  let t = 1_000_000
  const said = []
  const ended = []
  const e = createFocusEngine({
    now: () => t,
    onSay: (x) => said.push(x.text),
    onEnd: (r) => ended.push(r),
  })
  const run = (reading, ms) => {
    for (let i = 0; i < ms; i += 1000) {
      t += 1000
      e.tick(reading)
    }
  }
  return { e, said, ended, run, advance: (ms) => (t += ms), clock: () => t }
}

const tests = []
const test = (name, fn) => tests.push({ name, fn })

test('voice start from a work tab locks that tab at once', () => {
  const { e } = rig()
  const r = e.start({ minutes: 30, reading: work })
  assert.equal(r.deferred, false)
  assert.equal(e.snapshot().locked, true)
})

test('FOCUS button defers, asks for intent, then settles on the first real surface', () => {
  const { e, said, run } = rig()
  const r = e.start({ minutes: 30, fromButton: true, reading: home })
  assert.equal(r.deferred, true)
  assert.equal(r.listen, true)
  assert.equal(e.snapshot().awaitingIntent, true)
  assert.equal(e.takeIntent('the thumbnail sprint'), true)
  run(home, 5000)
  assert.equal(e.snapshot().deferred, true, 'home base never settles a lock')
  run(work, 1000)
  assert.equal(e.snapshot().deferred, true, 'one tick is not settled')
  run(work, 1000)
  assert.equal(e.snapshot().locked, true)
  assert.ok(said.includes('Locked on, sir.'), 'the lock is audible')
})

test('never leaving the JARVIS tab falls back to an app-only lock', () => {
  const { e, said, run } = rig()
  e.start({ minutes: 30, fromButton: true, intent: 'x' })
  run(home, APP_ONLY_AFTER_MS + 1000)
  const s = e.snapshot()
  assert.equal(s.locked, true)
  assert.equal(s.appOnly, true)
  assert.equal(said.length, 1)
})

test('a glance under the grace period is not a drift', () => {
  const { e, said, run } = rig()
  e.start({ minutes: 30, reading: work })
  run(secretSite, GRACE_MS - 2000)
  run(work, 2000)
  assert.equal(e.snapshot().drifts, 0)
  assert.equal(said.length, 0)
})

test('a real drift is called out, nagged, and escalates by tier', () => {
  const { e, said, run } = rig()
  e.start({ minutes: 60, reading: work })
  run(secretSite, GRACE_MS + 1000)
  assert.equal(e.snapshot().drifts, 1)
  assert.equal(e.snapshot().adrift, true)
  assert.equal(said.length, 1)
  assert.ok(said[0].includes(SECRET_HOST), 'the distraction is named out loud')
  run(secretSite, NAG_EVERY_MS)
  assert.equal(said.length, 2, 'nagged once per cadence while the drift persists')
  run(work, 3000)
  assert.equal(e.snapshot().adrift, false)
  run(secretSite, GRACE_MS + 1000)
  assert.equal(e.snapshot().drifts, 2)
})

test('coming back to JARVIS mid-drift is home base, not a drift', () => {
  const { e, run } = rig()
  e.start({ minutes: 30, reading: work })
  run(home, 60_000)
  assert.equal(e.snapshot().drifts, 0)
})

test('an excuse refunds the drift and stays quiet until back on target', () => {
  const { e, said, run } = rig()
  e.start({ minutes: 60, reading: work })
  run(secretSite, GRACE_MS + 1000)
  assert.equal(e.snapshot().drifts, 1)
  e.control('excuse')
  assert.equal(e.snapshot().drifts, 0)
  const before = said.length
  run(secretSite, NAG_EVERY_MS * 3)
  assert.equal(said.length, before, 'silent while excused')
  run(work, 2000)
  run(secretSite, GRACE_MS + 1000)
  assert.equal(said.length, before + 1, 'the excuse ends when they come back')
})

test('snooze and cadence are honoured', () => {
  const { e, said, run } = rig()
  e.start({ minutes: 60, reading: work })
  e.control('cadence', { seconds: 20 })
  run(secretSite, GRACE_MS + 1000)
  run(secretSite, 20_000)
  assert.equal(said.length, 2)
  e.control('snooze', { seconds: 30 })
  run(secretSite, 25_000)
  assert.equal(said.length, 2, 'quiet while snoozed')
})

test('"lock on this tab" from a work tab retargets and forgives the current drift', () => {
  const { e, run } = rig()
  e.start({ minutes: 60, reading: work })
  run(cad, GRACE_MS + 1000)
  assert.equal(e.snapshot().drifts, 1)
  const r = e.control('lock_here', { reading: cad })
  assert.equal(r.line, 'Locked on, sir.')
  assert.equal(e.snapshot().drifts, 0)
  run(cad, 10_000)
  assert.equal(e.snapshot().adrift, false)
})

test('"lock on this tab" said from the JARVIS tab re-arms the deferred lock', () => {
  const { e } = rig()
  e.start({ minutes: 60, reading: work })
  const r = e.control('lock_here', { reading: home })
  assert.equal(r.deferred, true)
  assert.equal(e.snapshot().deferred, true)
})

test('the card button locks the last real surface, not the card itself', () => {
  const { e, run } = rig()
  e.start({ minutes: 60, reading: work })
  run(cad, 2000)
  // The click makes the card (a chrome window titled J.A.R.V.I.S.) frontmost.
  run(home, 1000)
  const r = e.control('lock_here', { fromCard: true })
  assert.equal(r.line, 'Locked on, sir.')
  run(cad, 20_000)
  assert.equal(e.snapshot().drifts, 0, 'CAD is now the target')
})

test('pause stops the clock; the end writes a report', () => {
  const { e, ended, run } = rig()
  e.start({ minutes: 1, reading: work })
  run(work, 20_000)
  e.control('pause')
  run(work, 300_000)
  assert.equal(ended.length, 0, 'paused sessions do not expire')
  e.control('resume')
  run(work, 45_000)
  assert.equal(ended.length, 1)
  assert.equal(ended[0].completed, true)
  assert.equal(ended[0].percent, 100)
})

test('PRIVACY: no app or site identity reaches state, snapshot, diag or ledger', () => {
  const { e, said, ended, run } = rig()
  e.start({ minutes: 2, reading: work, intent: 'the drawings' })
  run(secretSite, GRACE_MS + 1000)
  run(work, 2000)
  run(secretApp, GRACE_MS + 1000)
  const mid = JSON.stringify([e.snapshot(), e.diag()])
  run(work, 130_000)
  assert.equal(ended.length, 1)

  const dir = mkdtempSync(join(tmpdir(), 'focus-'))
  const path = join(dir, 'ledger.json')
  appendLedger({ ...ended[0], leaked: SECRET_HOST }, path)
  const ledger = readFileSync(path, 'utf8')

  // It was spoken — that is the feature...
  assert.ok(said.some((l) => l.includes(SECRET_HOST)))
  assert.ok(said.some((l) => l.toLowerCase().includes(SECRET_APP)))
  // ...and it is nowhere else. Hashes count as identities too.
  for (const [where, blob] of [['snapshot/diag', mid], ['ledger', ledger], ['record', JSON.stringify(ended[0])]]) {
    assert.ok(!blob.includes(SECRET_HOST), `${where} holds the site`)
    assert.ok(!blob.toLowerCase().includes(SECRET_APP), `${where} holds the app`)
    assert.ok(!/[0-9a-f]{32,}/.test(blob), `${where} holds a hash`)
    assert.ok(!blob.includes('the drawings'), `${where} holds the intent`)
  }
  assert.deepEqual(Object.keys(JSON.parse(ledger)[0]).sort(), [...LEDGER_KEYS].sort())
})

test('streak counts consecutive clean completed sessions', () => {
  const r = (percent, completed = true) => ({ percent, completed })
  assert.equal(streakOf([r(90), r(50), r(88), r(95)]), 2)
  assert.equal(streakOf([r(90), r(99, false)]), 0)
})

let failed = 0
for (const { name, fn } of tests) {
  try {
    await fn()
    console.log(`  ✓ ${name}`)
  } catch (err) {
    failed++
    console.log(`  ✗ ${name}\n      ${err.message}`)
  }
}
console.log(`\nfocus: ${tests.length - failed} pass, ${failed} fail`)
process.exit(failed ? 1 : 0)
