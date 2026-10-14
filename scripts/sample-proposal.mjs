/**
 * Renders the Ellerman Avenue proposal (Revision A, as issued 16 Sep 2026)
 * through the house-style generator, so the look can be compared side by side
 * with the original. `node scripts/sample-proposal.mjs [out.pdf]`
 */
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { normalise, renderHtml } from '../bridge/proposals/render.mjs'
import { htmlToPdf } from '../bridge/proposals/pdf.mjs'

import { LOGO_FILE as LOGO } from '../bridge/paths.mjs'

export const ELLERMAN = {
  draft: true,
  client: { name: 'Robin Glassup' },
  address: '94 Ellerman Avenue, Twickenham, TW2 6AQ',
  lpa: 'London Borough of Richmond upon Thames',
  propertyType: 'Semi-detached bungalow with an existing loft conversion',
  reference: 'EA / FP-01',
  revision: 'A',
  issued: '2026-09-10',
  revisedOn: '2026-09-16',
  subtitle: 'Householder Planning Application — ground floor extensions and extension of the existing loft conversion',
  intro: [
    'Thank you for your enquiry. We have set out below a fixed fee, scope of works and programme for the drawing package you described.',
    'We have understood the brief clearly: you are managing the construction yourselves and do not want administration, tendering or project management. What you need is a complete, accurate and coordinated set of drawings that will secure planning permission and that a contractor can build from. That is exactly how this proposal is structured.',
    'One point we should raise at the outset, because it affects how the fee is presented. Full planning permission and Building Regulations approval are two separate consents, assessed by two different bodies against two different sets of criteria, and they cannot be obtained through a single combined application. They do, however, come from one continuous design process, and we run them back to back so that the second package follows straight on from the first. The proposal therefore prices the planning stage firmly, and gives you an indicative figure for the Building Regulations stage so you can see the full picture before you commit.',
  ],
  understanding: [
    'Ground floor rear extension — extending the existing rear extension to a greater depth.',
    'Ground floor front extension — a new entrance zone to accommodate the relocated staircase.',
    'Extension of the existing loft conversion — a modified layout connecting to the new staircase position, to be built by a contractor at a later date directly from the completed drawings.',
  ],
  understandingAfter: [
    'The package is to include detailed cross-sections demonstrating Part K compliance for head clearance and stair pitch across all levels, street-scene elevations, and the release of the final scaled 2D drawings in editable .DWG format for your independent BRE daylight and sunlight consultant.',
  ],
  scopeTitle: 'Stage 1 — Planning: scope of works',
  scope: [
    {
      heading: 'Survey and existing drawings',
      bullets: [
        'Full measured building survey of the property, internal and external, including the existing loft conversion and the existing rear extension.',
        'Site measurements of boundaries, and recording of neighbouring window positions that are visible from within your own boundary and from the public highway, for the use of your daylight and sunlight consultant.',
        'Existing drawings to scale: ground floor plan, loft floor plan, roof plan, all elevations, site and block plans, and a section through the property.',
      ],
    },
    {
      heading: 'Design development',
      bullets: [
        'Design of the three elements as a single coordinated scheme, tested against Richmond’s adopted policy and design guidance.',
        'A preliminary staircase study, carried out before the layouts are fixed, to confirm that the relocated stair can achieve a compliant rise, going, pitch and headroom within the available ridge height.',
        'Two rounds of design revisions included.',
      ],
    },
    {
      heading: 'Planning submission',
      bullets: [
        'Proposed drawings to scale: floor plans, all elevations, street-scene elevation, site and block plans, and sections.',
        'Design and Access / planning statement, and any supporting notes the council requires for validation.',
        'Preparation, validation and submission of the householder planning application on your behalf via the Planning Portal.',
        'Liaison with the case officer throughout determination, including one round of minor amendments requested by the officer.',
      ],
    },
  ],
  fees: {
    title: 'Stage 1 fee and payment stages',
    totalLabel: 'Stage 1 planning package (fixed)',
    stages: [
      { stage: 'Instruction and measured survey', when: 'On instruction', amount: 980 },
      { stage: 'Proposed design drawings issued', when: 'On issue of the proposed drawings', amount: 735 },
      { stage: 'Planning submission', when: 'Before submission to the council', amount: 735 },
    ],
    statedTotal: 2450,
    note: 'The council’s own application fee is separate and is set out under Exclusions.',
  },
  indicative: {
    title: 'Stage 2 — Building Regulations (indicative)',
    paragraphs: [
      'We can only price this stage firmly once the planning design is settled, because the extent of structural intervention and the fire strategy both depend on the final layout. On a scheme of this type we would expect the Building Regulations package to be in the region of **£1,950**, and we will confirm a fixed figure at the end of Stage 1 before you commit to it.',
    ],
    bullets: [
      'Construction plans, sections and elevations at an appropriate scale.',
      'Detailed cross-sections through the relocated staircase across all levels, demonstrating head clearance and stair pitch to Approved Document K.',
      'Fire safety and means of escape strategy to Approved Document B.',
      'Thermal, ventilation, drainage and sound resistance notes to Approved Documents L, F, H and E as applicable.',
      'Preparation and submission of a full plans application to Richmond Building Control or to a Registered Building Control Approver of your choice.',
    ],
    after: [
      'A structural engineer will be required for the beam and foundation design. This is normally in the region of £900 to £1,400. We can instruct and coordinate an engineer on your behalf, or you are welcome to appoint your own.',
    ],
  },
  programme: [
    { stage: 'Measured survey', timing: 'Currently 5 to 10 working days from instruction' },
    { stage: 'Existing drawings issued', timing: 'Within 1 week of the survey' },
    { stage: 'Design development and revisions', timing: 'Weeks 2 to 4' },
    { stage: 'Planning submission', timing: 'Week 5, subject to your approval of the drawings' },
    { stage: 'Determination by Richmond', timing: 'Approximately 8 weeks from validation' },
    { stage: 'Building Regulations package', timing: '3 to 4 weeks from planning approval' },
  ],
  exclusions: [
    '**Council planning application fee** — currently £548 for a householder application in England. Payable by you direct to the Planning Portal on submission.',
    'Building Control or Registered Building Control Approver fees.',
    'Structural engineer’s calculations (indicative figure given above).',
    'Party Wall etc. Act 1996 notices and any surveyor’s fees.',
    'Topographical survey — specialist land-surveying work that we do not undertake; see note 3.',
    'Discharge of planning conditions, appeals, or any resubmission following a refusal.',
    'Tendering, contract administration and project management — excluded at your request.',
  ],
  notesIntro: 'So that you can make an informed decision before instructing us, these are the points we would want you to be aware of at this stage.',
  notes: [
    { title: 'The front extension is the highest-risk element.', text: 'Richmond’s House Extensions and External Alterations SPD treats changes to the front of a house as among the most sensitive a householder can make. An entrance zone is a reasonable thing to want, but it will need to be modest and clearly subordinate.' },
    { title: 'The relocated staircase is a geometry problem before it is a design one.', text: 'Approved Document K requires a private stair to have a maximum pitch of 42°, a maximum rise of 220 mm and a minimum going of 220 mm, with 2 m of headroom above the pitch line. In a bungalow the ridge height is usually the binding constraint, which is why we run the stair study first.' },
    { title: 'A topographical survey is worth considering.', text: 'Our measured building survey is included in our fee. A topographical survey is specialist land-surveying work that we do not undertake, so you would appoint a land surveyor directly — typically £600 to £900 for a plot of this size.' },
  ],
  nextSteps: [
    'If you are happy to proceed, please confirm by return. We will then send the instruction form, the CAD release waiver and the Stage 1 invoice, and book the survey.',
    'We are equally happy to have a short call first to talk through the front extension and the stair geometry before you commit — that conversation is often the one that saves the most money.',
  ],
  acceptance: {},
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const out = process.argv[2] ?? 'sample-fee-proposal.pdf'
  const logo = `data:image/png;base64,${readFileSync(LOGO).toString('base64')}`
  const p = normalise(ELLERMAN)
  const r = await htmlToPdf(renderHtml(p, { logo }), out)
  console.log(`${r.path}: ${r.pages} pages, ${Math.round(r.bytes / 1024)} KB, total ${p.fees.total}`)
}
