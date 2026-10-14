import { HOUSE_CSS, PRACTICE, letterhead, longDate, esc, fmt, bullets, paras, table } from '../proposals/render.mjs'

/**
 * The feasibility report: everything found about a property and the route
 * recommended, in the same house style as the fee proposals.
 *
 * Structure follows the research method in 00 - PRACTICE TEMPLATES:
 * recommendation first, then the evidence behind it, then the risks, then
 * what happens next. Every planning reference cited should be one that was
 * actually found; the Sources section lists where each fact came from.
 */

const RAG = {
  good: { label: 'Good prospects', colour: '#2e7d4f' },
  fair: { label: 'Reasonable prospects', colour: '#E2711D' },
  poor: { label: 'Difficult', colour: '#b3261e' },
}

export function normaliseReport(input, today = new Date()) {
  const r = structuredClone(input ?? {})
  if (!r.address) throw new Error('the report needs the property address')
  if (!r.recommendation?.route) throw new Error('the report needs a recommended route (recommendation.route)')
  if (!r.recommendation?.summary) throw new Error('the report needs a recommendation summary (recommendation.summary)')
  r.issued = r.issued ? new Date(r.issued) : today
  if (Number.isNaN(r.issued.getTime())) throw new Error('issued is not a date')
  r.prospects = RAG[r.recommendation.prospects] ? r.recommendation.prospects : 'fair'
  r.reference = r.reference || 'Feasibility'
  return r
}

const EXTRA_CSS = `
.verdict { display: flex; gap: 5mm; align-items: stretch; margin: 0 0 6mm; break-inside: avoid; }
.verdict .route { flex: 1; border-left: 2.5pt solid #E2711D; background: #fbf4ee; padding: 3.5mm 4.5mm; }
.verdict .route .k { font-size: 8pt; letter-spacing: 0.14em; text-transform: uppercase; color: #6B7075; }
.verdict .route .v { font-size: 13pt; font-weight: 700; margin-top: 1mm; }
.verdict .rag { width: 44mm; color: #fff; padding: 3.5mm 4mm; display: flex; flex-direction: column; justify-content: center; }
.verdict .rag .k { font-size: 8pt; letter-spacing: 0.14em; text-transform: uppercase; opacity: 0.85; }
.verdict .rag .v { font-size: 11.5pt; font-weight: 700; margin-top: 1mm; }
.quote { border-left: 1.5pt solid #d4d7da; padding: 0.5mm 0 0.5mm 3.5mm; margin: 1.5mm 0 3mm; color: #3d4246; font-style: italic; }
.src { font-size: 8.5pt; color: #6B7075; word-break: break-all; }
table.data td.tight { white-space: nowrap; }
`

export function renderReport(r, { logo }) {
  let n = 0
  const section = (title, body) => (body ? `<h2>${++n}.&nbsp; ${esc(title)}</h2>${body}` : '')
  const rag = RAG[r.prospects]

  const facts = [
    ['Property', r.address],
    ['Local planning authority', r.lpa],
    ['Ward', r.ward],
    ['Prepared for', r.client],
    ['Proposed works', r.proposal],
    ['Reference', r.reference],
    ['Date', longDate(r.issued)],
    ['Prepared by', `${PRACTICE.signatory}, ${PRACTICE.role}`],
  ].filter(([, v]) => v)

  const summary =
    `<div class="verdict"><div class="route"><div class="k">Recommended route</div><div class="v">${fmt(r.recommendation.route)}</div></div>` +
    `<div class="rag" style="background:${rag.colour}"><div class="k">Prospects</div><div class="v">${rag.label}</div></div></div>` +
    paras([r.recommendation.summary]) +
    bullets(r.recommendation.keyPoints)

  const constraintRows = (r.constraints ?? []).map((c) => [fmt(c.item), fmt(c.finding), fmt(c.implication ?? '')])
  const constraintsBody = constraintRows.length
    ? table(['Constraint', 'Finding', 'What it means'], constraintRows) + (r.constraintsNote ? `<p class="small">${fmt(r.constraintsNote)}</p>` : '')
    : ''

  const history = (r.history ?? []).length
    ? table(
        ['Reference', 'Proposal', 'Decision', 'Date'],
        r.history.map((h) => [`<span class="tight">${esc(h.reference)}</span>`, fmt(h.proposal), fmt(h.decision ?? ''), esc(h.date ?? '')]),
      ) + paras(r.historyNotes)
    : paras(r.historyNotes)

  const officer = (r.officerFindings ?? [])
    .map((f) => `<h3>${fmt(f.application ?? '')}</h3>${f.quote ? `<div class="quote">${fmt(f.quote)}</div>` : ''}${paras([f.point])}`)
    .join('')

  const policy = (r.policy ?? []).length
    ? `<ul>${r.policy.map((p) => `<li><strong>${esc(p.name)}</strong>${p.says ? ` — ${fmt(p.says)}` : ''}</li>`).join('')}</ul>`
    : ''

  const precedents = (r.precedents ?? []).length
    ? table(
        ['Reference', 'Address', 'Proposal', 'Decision', 'Relevance'],
        r.precedents.map((p) => [`<span class="tight">${esc(p.reference)}</span>`, fmt(p.address), fmt(p.proposal), fmt(p.decision ?? ''), fmt(p.relevance ?? '')]),
      ) + paras(r.precedentNotes)
    : paras(r.precedentNotes)

  const options = (r.options ?? []).length
    ? table(
        ['Route', 'For', 'Against', 'Time and cost'],
        r.options.map((o) => [`<strong>${fmt(o.route)}</strong>`, fmt(o.pros ?? ''), fmt(o.cons ?? ''), fmt(o.timeCost ?? '')]),
      )
    : ''

  const risks = (r.risks ?? []).length
    ? `<ol class="items">${r.risks.map((x) => `<li>${x.title ? `<strong>${esc(x.title)}</strong> ` : ''}${fmt(x.text)}</li>`).join('')}</ol>`
    : ''

  const sources = (r.sources ?? []).length
    ? `<ul>${r.sources.map((s) => `<li class="src">${fmt(s)}</li>`).join('')}</ul>`
    : ''

  return `<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><title>Feasibility Report — ${esc(r.address)}</title><style>${HOUSE_CSS}${EXTRA_CSS}</style></head><body>
${letterhead({ logo, draft: r.draft })}
<h1>Planning Feasibility Report</h1>
<p class="sub">${fmt(r.subtitle ?? r.proposal ?? r.address)}</p>
<table class="facts">${facts.map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`).join('')}</table>
${section('Summary and recommendation', summary)}
${section('The site', paras(r.site))}
${section('Designations and constraints', constraintsBody)}
${section('Planning history of the property', history)}
${section('What the officers said', officer)}
${section('Policy that will be applied', policy + paras(r.policyNotes))}
${section('Comparable applications nearby', precedents)}
${section('Permitted development position', paras(r.permittedDevelopment))}
${section('Options', options + paras(r.optionNotes))}
${section('Design parameters to work within', bullets(r.designParameters))}
${section('Risks and how to manage them', risks)}
${section('Next steps', paras(r.nextSteps))}
${section('Sources', sources)}
<p class="small" style="margin-top:6mm">${fmt(r.disclaimer ?? 'This report is based on the council’s published register, policies and open government data at the date above. Designations are checked at the postcode and should be confirmed on the council’s own map. It is an assessment of prospects, not a guarantee of any decision.')}</p>
</body></html>`
}
