/**
 * Unit tests for the brain swap resolver and the JOBS.md capture.
 * `node scripts/test-units.mjs`; exits non-zero on failure.
 */
import assert from 'node:assert/strict'
import { resolveBrain, prettyModel, brainLine } from '../bridge/brain.mjs'
import { withCapture } from '../bridge/notes.mjs'
import { redact, parseTranscript, searchSessions } from '../bridge/history.mjs'
import { normalise, renderHtml, money, initialsRef } from '../bridge/proposals/render.mjs'
import { fileName } from '../bridge/proposals/index.mjs'
import { ELLERMAN } from './sample-proposal.mjs'

const tests = []
const test = (name, fn) => tests.push({ name, fn })
const DEFAULT = 'claude-sonnet-5'

test('exact names resolve', () => {
  assert.equal(resolveBrain('opus 5.5', DEFAULT).id, 'claude-opus-5-5')
  assert.equal(resolveBrain('Opus five point five', DEFAULT).id, 'claude-opus-5-5')
  assert.equal(resolveBrain('try on Claude Fable 5.1', DEFAULT).id, 'claude-fable-5-1')
  assert.equal(resolveBrain('sonnet 5', DEFAULT).id, 'claude-sonnet-5')
})

test('a family alone resolves when it has one version', () => {
  assert.equal(resolveBrain('switch to opus', DEFAULT).id, 'claude-opus-5-5')
  assert.equal(resolveBrain('fable', DEFAULT).id, 'claude-fable-5-1')
})

test('THE RULE: a wrong version is refused, never rounded', () => {
  assert.ok(resolveBrain('opus 5', DEFAULT).refuse)
  assert.ok(resolveBrain('opus 4', DEFAULT).refuse)
  assert.ok(resolveBrain('sonnet 4.5', DEFAULT).refuse)
  assert.ok(resolveBrain('fable 5', DEFAULT).refuse)
})

test('unknown and unlisted models are refused', () => {
  assert.ok(resolveBrain('gpt 6 astra', DEFAULT).refuse)
  assert.ok(resolveBrain('haiku', DEFAULT).refuse)
  assert.ok(resolveBrain('', DEFAULT).refuse)
})

test('"normal brain" returns to the configured model', () => {
  assert.equal(resolveBrain('go back to your normal brain', DEFAULT).id, DEFAULT)
  assert.equal(resolveBrain('default', 'claude-opus-5-5').id, 'claude-opus-5-5')
})

test('model ids read aloud properly', () => {
  assert.equal(prettyModel('claude-opus-5-5'), 'Opus 5.5')
  assert.equal(prettyModel('claude-fable-5-1'), 'Fable 5.1')
  assert.equal(prettyModel('claude-sonnet-5'), 'Sonnet 5')
})

test('swap lines rotate', () => {
  const a = brainLine('claude-opus-5-5')
  const b = brainLine('claude-opus-5-5')
  assert.notEqual(a, b)
})

const JOBS = '# Jobs\n\n## In progress\n\n| a | b |\n\n## Diary\n\n- Tue: tour.\n'

test('first capture creates the Captured section at the end', () => {
  const out = withCapture(JOBS, 'the finish window should be 900 ms', '27 Sep 2026')
  assert.ok(out.endsWith('## Captured\n\n- 27 Sep 2026: the finish window should be 900 ms\n'))
  assert.ok(out.includes('## Diary\n\n- Tue: tour.'), 'nothing else moves')
})

test('later captures append under the section, before any heading after it', () => {
  const mid = `# Jobs\n\n## Captured\n\n- 27 Sep 2026: first\n\n## Diary\n\n- Tue\n`
  const two = withCapture(mid, 'second', '28 Sep 2026')
  assert.ok(two.includes('- 27 Sep 2026: first\n- 28 Sep 2026: second\n\n## Diary'))
})

test('Windows line endings are kept', () => {
  const out = withCapture('# Jobs\r\n\r\n## Captured\r\n\r\n- a\r\n', 'b', '1 Oct 2026')
  assert.ok(out.includes('- a\r\n- 1 Oct 2026: b'))
  assert.ok(!/[^\r]\n/.test(out), 'no bare LF introduced')
})

// ---------------------------------------------------------------- history
test('PRIVACY: keys and tokens are scrubbed from anything history returns', () => {
  const fish = 'sk-fish-' + 'Ab3dEf6hIj9kLm2nOp5qRs8t'
  const tg = '8761458720:' + 'AAEY8Ni_uS_EDyaRbjdSaZs0bYCbP5r3FUs'
  const retell = 'key_' + 'a1b2c3d4e5f6a7b8c9d0e1f2'
  const out = redact(`use ${fish} and ${tg}; RETELL_API_KEY=${retell}; app password abcd efgh ijkl mnop; Bearer abcdefghijklmnopqrstuvwxyz0123`)
  for (const secret of [fish, tg, retell, 'abcd efgh ijkl mnop', 'abcdefghijklmnopqrstuvwxyz0123']) {
    assert.ok(!out.includes(secret), `leaked: ${secret.slice(0, 12)}…`)
  }
  assert.ok(out.includes('[redacted]'))
  assert.equal(redact('The fee for 57 The Grove is £2,450.'), 'The fee for 57 The Grove is £2,450.', 'ordinary text is untouched')
})

const L = (o) => JSON.stringify(o)
const transcript = [
  L({ type: 'user', entrypoint: 'claude-desktop', timestamp: '2026-09-20T10:00:00Z', message: { content: 'Draft a fee proposal for 57 The Grove, Isleworth <system-reminder>secret stuff</system-reminder>' } }),
  L({ type: 'assistant', timestamp: '2026-09-20T10:01:00Z', message: { content: [{ type: 'thinking', thinking: 'hmm' }, { type: 'text', text: 'Proposed fee £1,850 for pre-app plus planning.' }, { type: 'tool_use', name: 'Write', input: { x: 1 } }] } }),
  L({ type: 'user', timestamp: '2026-09-20T10:02:00Z', message: { content: [{ type: 'tool_result', content: 'huge tool output' }] } }),
  L({ type: 'custom-title', customTitle: 'Grove fee proposal' }),
]

test('transcripts keep only what was said, not tools, thinking or reminders', () => {
  const t = parseTranscript(transcript, 'abc.jsonl', 'BUILDING REGULATIONS')
  assert.equal(t.meta.title, 'Grove fee proposal')
  assert.equal(t.meta.jarvis, false)
  assert.equal(t.messages.length, 2)
  assert.ok(!t.messages[0].text.includes('secret stuff'))
  assert.equal(t.messages[1].text, 'Proposed fee £1,850 for pre-app plus planning.')
})

test('chat history: his words cleaned, tools as chips, automatic work set apart, the job worked out', async () => {
  const { parseChat, projectOf, jobMatchers, cleanUserText, describeTool } = await import('../bridge/chats.mjs')
  const lines = [
    L({ type: 'user', entrypoint: 'sdk-ts', timestamp: '2026-10-06T16:28:31Z', message: { content: '[personality: film]\noperate hey Jarvis where are we on 17 Saxon Avenue' } }),
    L({ type: 'assistant', timestamp: '2026-10-06T16:28:33Z', message: { content: [{ type: 'tool_use', name: 'mcp__jarvis_research__read_planning_document', input: { path: 'D:\\APP DEVLOPMENT\\INBOX\\Mail\\P_2026_2674.pdf' } }] } }),
    L({ type: 'user', timestamp: '2026-10-06T16:28:34Z', message: { content: [{ type: 'tool_result', content: 'pages' }] } }),
    L({ type: 'assistant', timestamp: '2026-10-06T16:28:40Z', message: { content: [{ type: 'text', text: 'Valid on 22 September, sir; Hounslow will decide by 17 November.' }] } }),
    L({ type: 'user', timestamp: '2026-10-06T16:29:00Z', message: { content: [{ type: 'text', text: '[Request interrupted by user]' }] } }),
    L({ type: 'user', timestamp: '2026-10-06T17:00:00Z', message: { content: '[personality: film]\nA COUNCIL EMAIL has arrived in info@sydesignstudio.co.uk about 76 Longmeadow. <<<EMAIL x EMAIL>>>' } }),
    L({ type: 'assistant', timestamp: '2026-10-06T17:00:20Z', message: { content: [{ type: 'text', text: 'Filed against 76 Longmeadow, Longmeadow, Longmeadow.' }] } }),
  ]
  const chat = parseChat(lines)
  assert.equal(chat.jarvis, true)
  assert.deepEqual(chat.messages.map((m) => m.role), ['you', 'jarvis', 'auto', 'jarvis'], 'tool results and barge-in markers are not messages')
  assert.equal(chat.messages[0].text, 'where are we on 17 Saxon Avenue', 'the tag and the wake word are gone')
  assert.deepEqual(chat.messages[1].tools, [{ name: 'read_planning_document', label: 'Read document', detail: 'P_2026_2674.pdf' }])
  assert.ok(chat.messages[1].text.startsWith('Valid on 22 September'), 'a reply split over several lines is one message')
  assert.equal(chat.messages[3].after, 'auto')
  const jobs = jobMatchers([{ number: '1110', address: '76 Longmeadow Frimley GU16 8RJ' }, { number: '1139', address: '17 Saxon Avenue, Feltham TW13 5JJ' }])
  assert.equal(projectOf(chat.messages, jobs)?.job, '1139', 'the job he asked about, not the one the automatic email was about')
  assert.equal(cleanUserText('[personality: classic]\nHey Jarvis, show me the tracker'), 'show me the tracker')
  assert.equal(describeTool('WebFetch', { url: 'https://www.hounslow.gov.uk/planning' }).detail, 'hounslow.gov.uk/planning')
})

test('search needs every word and finds the answer', () => {
  const t = parseTranscript(transcript, 'abc.jsonl', 'BUILDING REGULATIONS')
  const jarvis = parseTranscript(
    [
      L({ type: 'user', entrypoint: 'sdk-ts', timestamp: '2026-10-01T21:16:00Z', message: { content: '[personality: film]\nTHIS IS THE 76 LONGMEADOW ROOF CALCS' } }),
      L({ type: 'assistant', timestamp: '2026-10-01T21:16:30Z', message: { content: [{ type: 'text', text: 'Filed against 1110, sir.' }] } }),
      L({ type: 'user', timestamp: '2026-10-01T21:20:00Z', message: { content: "[personality: film]\nYou are JARVIS's learner, working through one job in the background. Job 1110 — 76 Longmeadow." } }),
      L({ type: 'user', timestamp: '2026-10-01T21:21:00Z', message: { content: '[personality: film]\nReply with the single word: ready.' } }),
    ],
    'j.jsonl',
  )
  assert.equal(jarvis.meta.jarvis, true, "JARVIS's own sessions are marked")
  assert.equal(jarvis.messages[0].text, 'THIS IS THE 76 LONGMEADOW ROOF CALCS', 'the personality tag is not speech')
  assert.equal(jarvis.messages[2].injected, true, 'bridge work is marked')
  assert.equal(jarvis.messages[3].injected, true)
  const own = searchSessions([jarvis], 'Longmeadow')
  assert.equal(own.length, 1, 'what Salman told JARVIS is found; the learner job is not')
  assert.equal(own[0].message.role, 'you')
  assert.equal(searchSessions([jarvis], 'ready').length, 0, 'preflight checks never surface')
  const hits = searchSessions([t], 'fee Grove')
  assert.equal(hits.length, 1)
  assert.equal(searchSessions([t], 'proposed fee').length, 1)
  assert.equal(searchSessions([t], 'Wolsey fee').length, 0)
})

// ---------------------------------------------------------------- proposals
test('proposal totals are computed, and a wrong stated total is refused', () => {
  const p = normalise(ELLERMAN)
  assert.equal(p.fees.total, 2450)
  const bad = structuredClone(ELLERMAN)
  bad.fees.statedTotal = 2500
  assert.throws(() => normalise(bad), /add up to £2,450/)
  const worded = structuredClone(ELLERMAN)
  worded.fees.stages[0].amount = '£1,000'
  assert.throws(() => normalise(worded), /stated total/) // 1000+735+735 ≠ 2450
})

test('a revision re-runs the validity from the revised date', () => {
  const p = normalise(ELLERMAN)
  assert.equal(p.validUntil.toISOString().slice(0, 10), '2026-10-16')
})

test('money, references and file names follow the practice conventions', () => {
  assert.equal(money(2450), '£2,450')
  assert.equal(money(91.5), '£91.50')
  assert.equal(initialsRef('94 Ellerman Avenue, Twickenham'), 'EA')
  assert.equal(fileName({ address: '94 Ellerman Avenue, Twickenham', revision: 'A', draft: true }), 'SY_Fee_Proposal_Ellerman_Avenue_RevA_DRAFT.pdf')
  assert.equal(fileName({ address: '171 Hatton Road, Feltham' }), 'SY_Fee_Proposal_Hatton_Road.pdf')
})

test('the HTML escapes everything but **bold**, and carries the practice details', () => {
  const p = normalise({ ...ELLERMAN, client: { name: '<script>x</script>' }, intro: ['A **bold** point & more'] })
  const html = renderHtml(p, { logo: 'data:image/png;base64,AAAA' })
  assert.ok(!html.includes('<script>x'))
  assert.ok(html.includes('A <strong>bold</strong> point &amp; more'))
  assert.ok(html.includes('Company No. 14020779'))
  assert.ok(html.includes('not VAT registered'))
  assert.ok(html.includes('DRAFT — FOR REVIEW'))
  assert.ok(!/ACIAT/.test(html), 'never ACIAT')
})

test('a proposal without a client, address or fee is refused', () => {
  assert.throws(() => normalise({}), /client name/)
  assert.throws(() => normalise({ client: { name: 'X' }, address: 'Y', subtitle: 'Z', fees: { stages: [] } }), /fee stage/)
})

test('personality: every turn is tagged, the switch is remembered, classic leaves the persona untouched', async () => {
  const p = await import('../bridge/personality.mjs')
  const before = p.getMode()
  try {
    p.setMode('classic')
    assert.equal(p.getMode(), 'classic')
    assert.equal(p.tagTurn('what is on today'), '[personality: classic]\nwhat is on today')
    assert.equal(p.tagTurn('[personality: film]\nx'), '[personality: film]\nx', 'never tagged twice')
    const parts = p.tagTurn([{ type: 'image' }])
    assert.equal(parts[0].text, '[personality: classic]', 'content parts get the tag as a first text part')
    p.setMode('film')
    const { readFileSync } = await import('node:fs')
    const { fileURLToPath } = await import('node:url')
    const saved = JSON.parse(readFileSync(fileURLToPath(new URL('../data/personality.json', import.meta.url)), 'utf8'))
    assert.equal(saved.mode, 'film', 'remembered on disk for the next start')
    assert.throws(() => p.setMode('sarcastic'))
    const t = p.PERSONALITY_PROMPT
    assert.ok(/classic — everything above exactly as written/.test(t))
    assert.ok(/strictly professional/.test(t) && /no humour at all/.test(t) && /never bent for a punchline/.test(t), 'the limits are in the film rules')
    assert.ok(/say so ONCE/.test(t), 'pushes back once, then complies')
  } finally {
    p.setMode(before)
  }
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
console.log(`\nunits: ${tests.length - failed} pass, ${failed} fail`)
process.exit(failed ? 1 : 0)
