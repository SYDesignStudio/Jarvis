/**
 * Research module tests — parsers, project memory, constraints summary and the
 * feasibility report. No network. `node scripts/test-research.mjs`
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseResults, parseSummary, parseDocuments, rankReports } from '../bridge/research/idox.mjs'
import { parseOcellaResults, parseOcellaDetail } from '../bridge/research/ocella.mjs'
import { findPostcode, summarise } from '../bridge/research/constraints.mjs'
import { projectName, withNote, openProject, addNote, findProject } from '../bridge/research/projects.mjs'
import { normaliseReport, renderReport } from '../bridge/research/report.mjs'
import { registerFor } from '../bridge/research/registers.mjs'

const tests = []
const test = (name, fn) => tests.push({ name, fn })

test('Idox search results parse into applications', () => {
  const html = `<ul id="searchresults"><li class="searchresult">
    <a href="/online-applications/applicationDetails.do?keyVal=DCAPR_174609&amp;activeTab=summary">Proposed conversion into two flats</a>
    <p class="address">36 Village Way, London, NW10 0LL</p>
    <p class="metaInfo">Ref. No: 25/2314 <span class="divider">|</span> Received: Fri 08 Aug 2025 <span class="divider">|</span> Validated: Wed 24 Sep 2025 <span class="divider">|</span> Status: Decided</p>
  </li></ul>`
  const [r] = parseResults(html, 'https://pa.brent.gov.uk/online-applications')
  assert.equal(r.keyVal, 'DCAPR_174609')
  assert.equal(r.reference, '25/2314')
  assert.equal(r.status, 'Decided')
  assert.equal(r.address, '36 Village Way, London, NW10 0LL')
  assert.ok(r.url.startsWith('https://pa.brent.gov.uk/online-applications/applicationDetails.do?keyVal=DCAPR_174609'))
})

test('Idox summary table and documents parse; the officer report ranks first', () => {
  const sum = parseSummary('<table id="simpleDetailsTable"><tr><th>Reference</th><td>25/2314</td></tr><tr><th>Decision</th><td>Permission Refused</td></tr></table>')
  assert.equal(sum.Decision, 'Permission Refused')
  const docs = parseDocuments(
    `<table><tr><td>08 Aug 2025</td><td>Drawings</td><td>Location plan</td><td><a href="/online-applications/files/A1/pdf/plan.pdf">v</a></td></tr>
     <tr><td>19 Nov 2025</td><td>Decision (Public)</td><td>Final decision notice</td><td><a href="/online-applications/files/B2/pdf/dn.pdf">v</a></td></tr>
     <tr><td>19 Nov 2025</td><td>Report</td><td>Final delegated report</td><td><a href="/online-applications/files/C3/pdf/rep.pdf">v</a></td></tr></table>`,
    'https://pa.brent.gov.uk/online-applications',
  )
  const ranked = rankReports(docs)
  assert.equal(ranked[0].kind, 'officer report')
  assert.equal(ranked[1].kind, 'decision')
  assert.equal(ranked[0].url, 'https://pa.brent.gov.uk/online-applications/files/C3/pdf/rep.pdf')
})

test('Ocella results and details parse', () => {
  const rows = parseOcellaResults(
    `<table><tr><td><a href="planningDetails?reference=2157/APP/2023/3068&amp;from=planningSearch">2157/APP/2023/3068</a></td><td>12 High St</td><td>Rear extension</td><td>Approved</td></tr></table>`,
    'https://planning.hillingdon.gov.uk/OcellaWeb',
  )
  assert.equal(rows[0].reference, '2157/APP/2023/3068')
  assert.ok(rows[0].text.includes('Rear extension'))
  const d = parseOcellaDetail('<table><tr><td>Status</td><td>Undecided</td></tr><tr><td>Case Officer</td><td>Mike Kemp</td></tr></table>')
  assert.equal(d['Case Officer'], 'Mike Kemp')
})

test('postcodes are found in addresses', () => {
  assert.equal(findPostcode('57 The Grove, Isleworth tw7 4jd'), 'TW7 4JD')
  assert.equal(findPostcode('36 Village Way NW100LL'), 'NW10 0LL')
  assert.equal(findPostcode('no postcode here'), null)
})

test('constraints summarise, with listed buildings sorted by distance', () => {
  const s = summarise(
    [
      { dataset: 'conservation-area', name: 'Isleworth Riverside' },
      { dataset: 'conservation-area', name: 'Isleworth Riverside' },
      { dataset: 'article-4-direction-area', name: 'Article 4 for HMOs' },
      { dataset: 'flood-risk-zone', 'flood-risk-level': '3' },
    ],
    [
      { name: 'Far', 'listed-building-grade': 'II', point: 'POINT (-0.3240 51.4700)' },
      { name: 'Near', 'listed-building-grade': 'II*', point: 'POINT (-0.3226 51.4705)' },
    ],
    { lat: 51.4705, lng: -0.3225 },
  )
  assert.deepEqual(s.conservationAreas, ['Isleworth Riverside'])
  assert.equal(s.article4[0].name, 'Article 4 for HMOs')
  assert.deepEqual(s.flood, ['Flood Zone 3'])
  assert.equal(s.listedNearby[0].name, 'Near')
  assert.ok(s.listedNearby[0].metres < s.listedNearby[1].metres)
})

test('project names are stable and Windows-safe', () => {
  assert.equal(projectName('57 The Grove, Isleworth TW7 4JD'), '57 The Grove TW7 4JD')
  assert.equal(projectName('Flat 2: "Top" / 9 High St, N1 1AA'), 'Flat 2 Top 9 High St N1 1AA')
})

test('project notes land under the right section, and the project is found again', () => {
  const dir = mkdtempSync(join(tmpdir(), 'proj-'))
  openProject('57 The Grove, Isleworth TW7 4JD', { dir })
  addNote('57 The Grove, Isleworth TW7 4JD', 'Planning history', 'P/2020/1 refused', { dir })
  const p = addNote('57 the grove TW7 4JD', 'Discussion and decisions', 'Go for pre-app first', { dir })
  assert.equal(findProject('57 The Grove, TW7 4JD', dir), '57 The Grove TW7 4JD')
  assert.equal(findProject('57 the grove, Isleworth', dir), '57 The Grove TW7 4JD', 'found without a postcode')
  assert.equal(findProject('5 The Grove, Isleworth', dir), null, 'a different house number is not a match')
  openProject('57 The Grove, Ealing W5 1AA', { dir })
  assert.equal(findProject('57 The Grove', dir), null, 'two matching streets: ask, never guess')
  const md = readFileSync(p.file, 'utf8')
  assert.ok(/## Planning history\n\n- \d\d \w+ \d{4}: P\/2020\/1 refused\n/.test(md))
  assert.ok(/## Discussion and decisions\n\n- .*Go for pre-app first/.test(md))
  const bare = withNote('# X\n', 'New section', 'hello', '01 Oct 2026')
  assert.ok(bare.endsWith('## New section\n\n- 01 Oct 2026: hello\n'))
  const twice = withNote('# X\n', 'Notes', '01 Oct 2026: survey booked', '01 Oct 2026')
  assert.ok(twice.includes('- 01 Oct 2026: survey booked'), 'a repeated leading date is dropped')
  const phone = withNote('# X\n', 'Notes', '01 Oct 2026, phone call: go ahead', '01 Oct 2026')
  assert.ok(phone.includes('- 01 Oct 2026: phone call: go ahead'))
  const past = withNote('# X\n', 'Notes', '12 Mar 2012: appeal allowed', '01 Oct 2026')
  assert.ok(past.includes('- 01 Oct 2026: 12 Mar 2012: appeal allowed'), 'an older event date is kept')
})

test('notes carry their source, and a later note supersedes (never deletes) an earlier one', async () => {
  const { supersede } = await import('../bridge/research/projects.mjs')
  const { parseNotes } = await import('../bridge/memory/index.mjs')
  let md = withNote('# X\n', 'Discussion and decisions', 'Fee agreed at £1,500', '01 Sep 2026', { source: 'Salman on the phone' })
  assert.ok(md.includes('- 01 Sep 2026 · Salman on the phone: Fee agreed at £1,500'))
  const r = supersede(md, 'fee agreed', '28 Sep 2026', 'by email from Nav')
  assert.ok(r.found && r.markdown.includes('- 01 Sep 2026 · Salman on the phone: [SUPERSEDED 28 Sep 2026 — by email from Nav] Fee agreed at £1,500'))
  md = withNote(r.markdown, 'Discussion and decisions', 'Fee now £1,100', '28 Sep 2026', { source: 'email from Nav' })
  const notes = parseNotes(md)
  assert.equal(notes.length, 2)
  assert.equal(notes[0].superseded, true)
  assert.equal(notes[0].source, 'Salman on the phone')
  assert.equal(notes[1].superseded, false)
  assert.equal(notes[1].date.getDate(), 28)
  assert.equal(supersede(md, 'no such thing').found, null)
  const dir = mkdtempSync(join(tmpdir(), 'proj-'))
  addNote('9 Hill Rd, N1 1AA', 'Discussion and decisions', 'Brief: single storey', { dir, source: 'client email', date: '01 Sep 2026' })
  const p = addNote('9 Hill Rd, N1 1AA', 'Discussion and decisions', 'Brief: two storey', { dir, source: 'Salman', supersedes: 'single storey', date: '02 Sep 2026' })
  assert.ok(p.replaced.includes('[SUPERSEDED 02 Sep 2026'))
})

test('a new project for a NAS job takes the full address and links the folder', () => {
  const dir = mkdtempSync(join(tmpdir(), 'proj-'))
  const job = { number: '1110', address: '76 Longmeadow Frimely Camberley GU16 8RJ', path: '\\\\nas\\1110 - 76 Longmeadow' }
  const p = openProject('76 Longmeadow', { dir, job })
  assert.equal(p.name, '76 Longmeadow Frimely Camberley GU16 8RJ')
  assert.ok(p.markdown.includes('Job: 1110 · NAS: \\\\nas\\1110 - 76 Longmeadow'))
  assert.equal(openProject('76 Longmeadow', { dir, job: null }).name, '76 Longmeadow Frimely Camberley GU16 8RJ', 'found again by street')
})

test('open and done actions for a job are found in JOBS.md', async () => {
  const { jobActionsIn } = await import('../bridge/memory/index.mjs')
  const md = [
    '# Jobs',
    '## Diary',
    '- Mon 5 Oct 2026, 9am: Follow up Navil on 76 Longmeadow roof volume',
    '## Captured',
    '- 28 Sep 2026: Job 1110 (76 Longmeadow): photos before pouring (22 Sep LBC report).',
    '- ✓ DONE 30 Sep 2026 — 28 Sep 2026: Job 1110: all trenches bottomed out',
    '- 28 Sep 2026: Job 11100 somewhere else',
    '- 28 Sep 2026: 176 Longmeadow Road is another job',
  ].join('\n')
  const a = jobActionsIn(md, ['job 1110', '1110', '76 Longmeadow', 'GU16 8RJ'])
  assert.equal(a.length, 3, 'job 11100 and 176 Longmeadow are not this job')
  assert.equal(a[0].section, 'Diary')
  assert.equal(a.filter((x) => x.done).length, 1)
  assert.equal(a[1].date.getDate(), 28)
})

test('the galaxy lays out arms by council, halo for the one-offs, the same way every time', async () => {
  const { layout, haloLayout, hash01, shortCouncil, ARM_COLOURS } = await import('../bridge/memory/galaxy.mjs')
  assert.equal(shortCouncil('London Borough of Hounslow'), 'Hounslow')
  assert.equal(shortCouncil('Surrey Heath'), 'Surrey Heath')
  assert.equal(shortCouncil(null), 'Unplaced')
  assert.equal(hash01('job:1110'), hash01('job:1110'), 'scatter is stable between builds')
  assert.notEqual(hash01('job:1110'), hash01('job:1111'))
  const stars = [
    { id: 'job:1100', arm: 'Hounslow', order: 1100 },
    { id: 'job:1122', arm: 'Hounslow', order: 1122 },
    { id: 'job:1138', arm: 'Hounslow', order: 1138 },
    { id: 'job:1116', arm: 'Hillingdon', order: 1116 },
  ]
  const a = layout(stars, ['Hounslow', 'Hillingdon'])
  const b = layout(stars, ['Hounslow', 'Hillingdon'])
  assert.deepEqual(a, b, 'deterministic')
  const h = Object.fromEntries(a.map((s) => [s.id, s]))
  const r = (s) => Math.hypot(s.x, s.z)
  assert.ok(r(h['job:1100']) < r(h['job:1122']) && r(h['job:1122']) < r(h['job:1138']), 'older jobs nearer the core, newest at the tip')
  assert.equal(h['job:1116'].armIndex, 1)
  assert.ok(a.every((s) => Math.abs(s.y) < 1 && !s.halo), 'a thin disc')
  const halo = haloLayout([{ id: 'job:1131', arm: 'Charnwood', order: 1131 }])
  assert.ok(halo[0].halo && r(halo[0]) > 20, 'halo stars sit round the outside')
  assert.ok(ARM_COLOURS[0] === '#00e5ff', 'the home arm is interface cyan')
})

test('knowledge: outcomes are facts, lessons wait for approval, playbooks cite their cases', async () => {
  const { createStore } = await import('../bridge/knowledge/store.mjs')
  const { parseApproval, applyApproval, lessonMessage } = await import('../bridge/knowledge/approvals.mjs')
  const { recentJobs, learnerPrompt } = await import('../bridge/knowledge/backfill.mjs')
  const { readFileSync } = await import('node:fs')
  const root = mkdtempSync(join(tmpdir(), 'know-'))
  const s = createStore(root)
  const r1 = s.recordOutcome({ council: 'Hounslow', reference: 'P/2011/3291', job: '1110', projectType: 'house extension', decision: 'Refused', decisionDate: '2012-04-17', reasons: ['canopy not an architectural feature of the area'], policies: ['ENV-B.1.1'], sources: ['x.pdf'] })
  assert.equal(r1.record.decision, 'refused')
  const r2 = s.recordOutcome({ council: 'Hounslow', reference: 'P/2011/3291', decision: 'appeal part allowed', appeal: 'APP/F5540/D/12/2176220 — part allowed 2012-09-10', sources: ['appeal.pdf'] })
  assert.equal(r2.updated, true)
  assert.equal(s.outcomes().length, 1, 'same council+reference is one record')
  assert.deepEqual(s.outcomes()[0].sources, ['x.pdf', 'appeal.pdf'], 'sources accumulate')
  assert.deepEqual(s.outcomes()[0].policies, ['ENV-B.1.1'], 'earlier fields survive an update')
  assert.equal(s.outcomes({ decision: 'appeal part allowed' }).length, 1)
  assert.throws(() => s.recordOutcome({ reference: 'x' }), /council/)
  const l = s.proposeLesson({ council: 'Hounslow', lesson: 'Front canopies across the full width unbalance a semi; keep porches minor.', refs: ['P/2011/3291 (appeal 2012)'], job: '1110' })
  assert.equal(l.id, 1)
  assert.equal(s.playbook('Hounslow'), '', 'not in the playbook until approved')
  assert.throws(() => s.proposeLesson({ council: 'Hounslow', lesson: 'no refs', refs: [] }), /case reference/)
  assert.ok(lessonMessage([l], { job: '1110' }).includes('#1 [Hounslow · 1 case only]'))
  assert.deepEqual(parseApproval('yes 1'), { verdict: 'yes', ids: [1] })
  assert.deepEqual(parseApproval('No 1, 2'), { verdict: 'no', ids: [1, 2] })
  assert.deepEqual(parseApproval('edit 1: Keep front porches minor on Hounslow semis.'), { verdict: 'edit', ids: [1], text: 'Keep front porches minor on Hounslow semis.' })
  assert.equal(parseApproval('yes please call me'), null, 'ordinary text is not an approval')
  assert.equal(parseApproval('what is on tomorrow'), null)
  const lines = applyApproval(s, parseApproval('edit 1: Keep front porches minor on Hounslow semis.'))
  assert.ok(lines[0].includes('#1 added to the Hounslow playbook as reworded'))
  const pb = s.playbook('Hounslow')
  assert.ok(pb.includes('[#1 · 1 case] Keep front porches minor on Hounslow semis. — refs: P/2011/3291 (appeal 2012)'))
  assert.equal(s.approvedLessons()[0].id, 1)
  assert.equal(s.pendingLessons().length, 0)
  assert.ok(applyApproval(s, parseApproval('yes 1'))[0].includes('already approved'))
  s.policyNote({ council: 'Hounslow', title: 'Residential Extension Guidelines', adopted: '2003', source: 'hounslow.gov.uk' })
  assert.ok(readFileSync(join(root, 'policy', 'Hounslow', 'INDEX.md'), 'utf8').includes('| Residential Extension Guidelines | 2003 | — |'))
  s.recordPrediction({ job: '1110', address: '76 Longmeadow', council: 'Surrey Heath', route: 'householder application', prospects: 'fair' })
  assert.equal(s.predictions().length, 1)
  const now = new Date('2026-10-01').getTime()
  const jobs = [
    { number: '1138', address: 'a', path: 'p1' },
    { number: '1050', address: 'b', path: 'p2' },
    { number: '1136', address: 'c', path: 'p3' },
  ]
  const touched = (j) => ({ p1: now - 10 * 86400_000, p2: now - 900 * 86400_000, p3: now - 400 * 86400_000 })[j.path]
  assert.deepEqual(recentJobs({ jobs, now, touchedAt: touched }).map((j) => j.number), ['1138', '1136'], 'last two years, newest first')
  assert.ok(/READ-ONLY/.test(learnerPrompt(jobs[0])) && /Never invent/.test(learnerPrompt(jobs[0])))
})

test('NAS job folders and file revisions are read correctly', async () => {
  const { parseJobFolder, findJobs, revisionOf, familyOf, kindOf, stageOf, markCurrency } = await import('../bridge/memory/jobs.mjs')
  const j = parseJobFolder('1110 - 76 Longmeadow Frimely Camberley GU16 8RJ')
  assert.deepEqual([j.number, j.postcode], ['1110', 'GU16 8RJ'])
  const jobs = [
    { ...j, path: 'x' },
    { ...parseJobFolder('1116 - 27 Dawlish Drive Ruislip HA4 9SF'), path: 'y' },
    { ...parseJobFolder('1103 - 15 Mount Pleasant HA4 9HG'), path: 'z' },
  ]
  assert.equal(findJobs('1110', jobs)[0].number, '1110')
  assert.equal(findJobs('GU16 8RJ', jobs)[0].number, '1110')
  assert.equal(findJobs('76 Longmeadow, Frimley', jobs)[0].number, '1110')
  assert.equal(findJobs('27 Dawlish Drive', jobs)[0].number, '1116')
  assert.equal(findJobs('28 Dawlish Drive', jobs).length, 0, 'wrong house number is not a match')
  assert.equal(revisionOf('very latest-REV D 1 OF 3.pdf'), 'D')
  assert.equal(revisionOf('76 long meadow REVC-Proposed Steelwork.pdf'), 'C')
  assert.equal(revisionOf('Calcs Rev_B.doc'), 'B')
  assert.equal(revisionOf('Reverse elevation.pdf'), null, '"Reverse" is not a revision')
  assert.equal(familyOf('Main Calcs REV D.doc'), familyOf('Main Calcs REV C (1).doc'))
  assert.equal(kindOf('03 Architect Hub\\Planning\\RF NEW PL 1110.pdf'), 'drawing')
  assert.equal(kindOf('x\\WhatsApp Chat - Group\\_chat.txt'), 'whatsapp chat')
  assert.equal(kindOf('x\\whatsapp\\REVA Steelwork 1 of 3.pdf'), 'drawing', 'a drawing saved from WhatsApp is still a drawing')
  assert.equal(stageOf('03 Building Regulations\\x.pdf'), 'Building Regulations')
  const d = (s) => new Date(s)
  const files = markCurrency([
    { name: 'Calcs REV C.pdf', kind: 'calculations', stage: 'Building Regulations', revision: 'C', family: familyOf('Calcs REV C.pdf'), modified: d('2026-08-20'), inSuperseded: false },
    { name: 'Calcs REV D.pdf', kind: 'calculations', stage: 'Building Regulations', revision: 'D', family: familyOf('Calcs REV D.pdf'), modified: d('2026-09-02'), inSuperseded: false },
    { name: 'Plan.pdf', kind: 'drawing', stage: 'Planning', revision: null, family: 'plan', modified: d('2026-09-01'), inSuperseded: true },
    { name: 'REVA Details 1 of 3.pdf', kind: 'drawing', stage: 'Building Regulations', revision: 'A', family: familyOf('REVA Details 1 of 3.pdf'), modified: d('2026-07-01'), inSuperseded: false },
    { name: 'latest-REV D 1 OF 3.pdf', kind: 'drawing', stage: 'Building Regulations', revision: 'D', family: familyOf('latest-REV D 1 OF 3.pdf'), modified: d('2026-09-12'), inSuperseded: false },
  ])
  const by = Object.fromEntries(files.map((f) => [f.name, f.status]))
  assert.equal(by['Calcs REV D.pdf'], 'current')
  assert.equal(by['Calcs REV C.pdf'], 'superseded')
  assert.equal(by['Plan.pdf'], 'superseded', 'a Superseded folder always wins')
  assert.equal(by['REVA Details 1 of 3.pdf'], 'superseded', 'renamed sheet with a higher revision supersedes')
  assert.equal(by['latest-REV D 1 OF 3.pdf'], 'current')
})

test('the feasibility report needs a route, rates prospects, and escapes content', () => {
  assert.throws(() => normaliseReport({ address: 'x' }), /recommended route/)
  const r = normaliseReport({ address: '36 Village Way NW10 0LL', draft: true, recommendation: { route: 'Pre-app <b>first</b>', prospects: 'fair', summary: 'Because **reasons**.' } })
  const html = renderReport(r, { logo: 'data:image/png;base64,AAAA' })
  assert.ok(html.includes('Planning Feasibility Report'))
  assert.ok(html.includes('Reasonable prospects'))
  assert.ok(html.includes('Pre-app &lt;b&gt;first&lt;/b&gt;'))
  assert.ok(html.includes('Because <strong>reasons</strong>.'))
  assert.ok(html.includes('DRAFT — FOR REVIEW'))
  assert.ok(html.includes('Company No. 14020779'))
})

test('councils map to the right register', () => {
  assert.equal(registerFor('Brent').kind, 'idox')
  assert.equal(registerFor('Hillingdon').kind, 'ocella')
  assert.equal(registerFor('Richmond').kind, 'browser')
  assert.equal(registerFor('Hounslow').kind, 'browser')
  assert.equal(registerFor('Nowhere Council'), null)
  assert.equal(registerFor('X', { override: 'https://pam.ealing.gov.uk/online-applications/' }).kind, 'idox')
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
console.log(`\nresearch: ${tests.length - failed} pass, ${failed} fail`)
process.exit(failed ? 1 : 0)
