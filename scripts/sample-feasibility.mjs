/**
 * A layout sample of the feasibility report, using the facts the research
 * tools found for 36 Village Way (Brent) on 28 Sep 2026. The analysis text is
 * placeholder — it is a sample of the document, not advice on the job.
 * `node scripts/sample-feasibility.mjs out.pdf`
 */
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { normaliseReport, renderReport } from '../bridge/research/report.mjs'
import { htmlToPdf } from '../bridge/proposals/pdf.mjs'
import { LOGO } from '../bridge/proposals/index.mjs'

const SAMPLE = {
  draft: true,
  address: '36 Village Way, London NW10 0LL',
  subtitle: 'Layout sample — conversion of a house into two flats',
  lpa: 'London Borough of Brent',
  ward: 'Welsh Harp',
  client: 'Sample',
  proposal: 'Conversion of a single-family dwellinghouse into two self-contained flats',
  reference: 'VW / FR-01',
  recommendation: {
    route: 'Sample recommended route',
    prospects: 'fair',
    summary: 'This is a layout sample. In a real report this paragraph states the recommended route in two or three sentences and the main reason for it, drawn from the officer reports, the history and the comparable decisions below.',
    keyPoints: ['The deciding factor, in one line.', 'What would improve the prospects.', 'What the client should decide next.'],
  },
  site: ['A description of the property and street from the survey, photographs and the register.'],
  constraints: [
    { item: 'Conservation area', finding: 'None found', implication: 'Permitted development rights are not restricted on this ground.' },
    { item: 'Article 4 direction', finding: 'Article 4 for HMOs', implication: 'Houses in multiple occupation need planning permission; not relevant to self-contained flats.' },
    { item: 'Listed buildings', finding: 'None on or within 70 m', implication: 'No heritage setting to consider.' },
    { item: 'Flood risk', finding: 'None found (Flood Zone 1)', implication: 'No flood risk assessment needed.' },
  ],
  constraintsNote: 'Checked at the postcode centre on 28 September 2026 against planning.data.gov.uk.',
  history: [
    { reference: '26/2022', proposal: 'Conversion of dwellinghouse into two self-contained flats', decision: 'Registered (undecided)', date: 'Aug 2026' },
    { reference: '25/2314', proposal: 'Conversion into two 3-bedroom flats, refuse and cycle storage, sub-division of garden', decision: 'Permission refused', date: '19 Nov 2025' },
    { reference: '25/1202', proposal: 'Certificate of lawfulness — ground floor rear extension', decision: 'Decided', date: 'Apr 2025' },
    { reference: '25/0540', proposal: 'Prior approval — single-storey rear extension', decision: 'Decided', date: '2025' },
    { reference: '24/2949', proposal: 'Certificate of lawfulness — rear dormer and loft conversion', decision: 'Decided', date: '2024' },
  ],
  historyNotes: ['In a real report: what the history shows, and whether any condition removed permitted development rights.'],
  officerFindings: [{ application: '25/2314 — delegated report', point: 'The officer’s reasons for refusal would be set out here, quoted accurately, with what they mean for a new scheme. (Brent’s documents are behind a CAPTCHA; the report is read once forwarded.)' }],
  policy: [{ name: 'Brent Local Plan — housing and conversion policies', says: 'the tests the officer applies, in one line each' }, { name: 'London Plan', says: 'space standards and Policy D12 fire safety' }],
  precedents: [{ reference: 'xx/xxxx', address: 'A nearby street', proposal: 'A comparable conversion', decision: 'Approved', relevance: 'Why it matters' }],
  permittedDevelopment: ['A conversion to flats is not permitted development, so planning permission is required.'],
  options: [
    { route: 'Option A', pros: 'Advantages', cons: 'Drawbacks', timeCost: '8 weeks' },
    { route: 'Option B', pros: 'Advantages', cons: 'Drawbacks', timeCost: '12–16 weeks' },
  ],
  designParameters: ['The dimensions, layouts and standards the scheme has to meet.'],
  risks: [{ title: 'The main risk.', text: 'And how it is managed.' }],
  nextSteps: ['What happens next, and the fee proposal that follows.'],
  sources: ['Brent planning register, 36 Village Way — pa.brent.gov.uk/online-applications', 'planning.data.gov.uk — designations at NW10 0LL', 'postcodes.io — NW10 0LL'],
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const out = process.argv[2] ?? 'sample-feasibility.pdf'
  const logo = `data:image/png;base64,${readFileSync(LOGO).toString('base64')}`
  const r = await htmlToPdf(renderReport(normaliseReport(SAMPLE), { logo }), out)
  console.log(`${r.path}: ${r.pages} pages`)
}
