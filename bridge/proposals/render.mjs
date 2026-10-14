/**
 * Fee proposal → HTML, in the SY Design Studio house style.
 *
 * Taken from the proposals Salman issued in September 2026 (Ellerman Avenue,
 * UB7 8HW loft, 171 Hatton Road): logo and contact block over an orange
 * rule, a key-facts table, numbered sections with letter-spaced headings, orange
 * bullets, charcoal-headed tables, and the company footer on every page.
 *
 * Pure: data in, a complete HTML document out. Every string is escaped; the
 * only markup a caller can use is **bold**. Totals are computed here from the
 * stage amounts — the arithmetic is never taken from the model.
 */

export const PRACTICE = {
  name: 'SY Design Studio Ltd',
  tagline: 'Architectural Design · Planning · Building Regulations',
  phone: '07859 431227',
  email: 'info@sydesignstudio.co.uk',
  web: 'www.sydesignstudio.co.uk',
  companyNo: '14020779',
  office: '49 Durham Avenue, Hounslow TW5 0HG',
  signatory: 'Salman Yousaf',
  role: 'Architectural Technologist — Director, SY Design Studio Ltd',
}

const ORANGE = '#E2711D'
const CHARCOAL = '#2F3336'
const GREY = '#6B7075'

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
export const longDate = (d) => `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`

const esc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')

/** Escaped, with **bold** as the only markup. */
const fmt = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')

/** "£1,850" — pence only when there are some. */
export function money(n) {
  const v = Number(n)
  if (!Number.isFinite(v)) return esc(n)
  const [whole, pence] = Math.abs(v).toFixed(2).split('.')
  return `${v < 0 ? '−' : ''}£${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${pence === '00' ? '' : `.${pence}`}`
}

/** Amounts arrive as 980, "980", "£980" or "£1,250.00". Anything else is text. */
export function toAmount(x) {
  if (typeof x === 'number') return x
  const s = String(x ?? '').replace(/[£,\s]/g, '')
  return /^-?\d+(\.\d+)?$/.test(s) ? Number(s) : null
}

/** "Ellerman Avenue, Twickenham" → "EA". Two to four capitals. */
export function initialsRef(address) {
  const words = String(address ?? '')
    .split(',')[0]
    .replace(/^\d+[a-z]?\s+/i, '')
    .split(/\s+/)
    .filter((w) => /^[A-Za-z]/.test(w))
  return (words.map((w) => w[0].toUpperCase()).join('') || 'SY').slice(0, 4)
}

const bullets = (items, cls = '') =>
  items?.length ? `<ul class="${cls}">${items.map((b) => `<li>${fmt(b)}</li>`).join('')}</ul>` : ''

const paras = (items) => (items ?? []).map((p) => `<p>${fmt(p)}</p>`).join('')

function table(head, rows, { total, align = [] } = {}) {
  const cell = (tag, v, i) => `<${tag}${align[i] === 'r' ? ' class="r"' : ''}>${v}</${tag}>`
  return (
    `<table class="data"><thead><tr>${head.map((h, i) => cell('th', esc(h), i)).join('')}</tr></thead><tbody>` +
    rows.map((r) => `<tr>${r.map((v, i) => cell('td', v, i)).join('')}</tr>`).join('') +
    (total ? `<tr class="total">${total.map((v, i) => cell('td', v, i)).join('')}</tr>` : '') +
    '</tbody></table>'
  )
}

/**
 * Validate and normalise. Throws with a sentence the model can act on.
 * Returns the proposal with computed totals and dates filled in.
 */
export function normalise(input, today = new Date()) {
  const p = structuredClone(input ?? {})
  const need = (v, what) => {
    if (!v || (Array.isArray(v) && !v.length)) throw new Error(`the proposal needs ${what}`)
  }
  need(p.client?.name, 'the client name (client.name)')
  need(p.address, 'the project address')
  need(p.subtitle, 'a one-line description of the proposal (subtitle)')
  need(p.fees?.stages, 'at least one fee stage (fees.stages)')

  p.issued = p.issued ? new Date(p.issued) : today
  if (Number.isNaN(p.issued.getTime())) throw new Error('issued is not a date')
  p.validDays = Number(p.validDays) > 0 ? Number(p.validDays) : 30
  // A revision restarts the clock: validity runs from the latest issue.
  const from = p.revisedOn ? new Date(p.revisedOn) : p.issued
  if (Number.isNaN(from.getTime())) throw new Error('revisedOn is not a date')
  p.validUntil = new Date(from.getTime() + p.validDays * 86_400_000)
  p.reference = p.reference || `${initialsRef(p.address)} / FP-01`

  let total = 0
  p.fees.stages = p.fees.stages.map((s, i) => {
    const amount = toAmount(s.amount)
    if (amount == null) throw new Error(`fee stage ${i + 1} ("${s.stage}") has no amount a number can be read from`)
    total += amount
    return { ...s, amount }
  })
  p.fees.total = Math.round(total * 100) / 100
  // A stated total that disagrees with the stages is a mistake somewhere, and
  // a client-facing document is the wrong place to discover it.
  if (p.fees.statedTotal != null) {
    const stated = toAmount(p.fees.statedTotal)
    if (stated != null && Math.abs(stated - p.fees.total) > 0.005) {
      throw new Error(`the stages add up to ${money(p.fees.total)} but the stated total is ${money(stated)}; fix one of them`)
    }
  }
  return p
}

const CSS = `
@page {
  size: A4;
  margin: 18mm 17mm 20mm 17mm;
  @bottom-left { content: "${PRACTICE.name}  ·  Company No. ${PRACTICE.companyNo}  ·  Registered office: ${PRACTICE.office}"; font: 7.5pt Calibri, Carlito, Arial, sans-serif; color: ${GREY}; vertical-align: top; padding-top: 3mm; border-top: 0.5pt solid #d9dcdf; }
  @bottom-right { content: "Page " counter(page) " of " counter(pages); font: 7.5pt Calibri, Carlito, Arial, sans-serif; color: ${GREY}; vertical-align: top; padding-top: 3mm; border-top: 0.5pt solid #d9dcdf; }
}
* { box-sizing: border-box; }
html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
body { margin: 0; font: 10.5pt/1.45 Calibri, Carlito, "Segoe UI", Arial, sans-serif; color: ${CHARCOAL}; }
.head { display: flex; justify-content: space-between; align-items: flex-end; padding-bottom: 4mm; border-bottom: 1.5pt solid ${ORANGE}; margin-bottom: 7mm; }
.head img { width: 32mm; height: auto; display: block; }
.contact { text-align: right; font-size: 9pt; line-height: 1.5; }
.contact .tag { color: ${GREY}; letter-spacing: 0.06em; margin-bottom: 1.5mm; }
.draft { display: inline-block; background: ${ORANGE}; color: #fff; font-weight: 700; font-size: 8pt; letter-spacing: 0.14em; padding: 1mm 2.5mm; margin-bottom: 2mm; }
h1 { font-size: 22pt; margin: 0 0 1mm; font-weight: 700; }
.sub { color: ${GREY}; font-size: 11.5pt; margin: 0 0 5mm; }
table { border-collapse: collapse; width: 100%; }
table.facts { margin-bottom: 7mm; font-size: 10pt; }
table.facts td { border: 0.6pt solid #d4d7da; padding: 2mm 2.6mm; vertical-align: top; }
table.facts td:first-child { width: 33%; background: #f3f4f5; font-weight: 700; }
h2 { font-size: 11pt; font-weight: 700; letter-spacing: 0.13em; text-transform: uppercase; margin: 7mm 0 2.5mm; padding-bottom: 1.4mm; border-bottom: 0.9pt solid ${ORANGE}; break-after: avoid; }
h3 { color: ${ORANGE}; font-size: 10.5pt; margin: 4mm 0 1.2mm; break-after: avoid; }
p { margin: 0 0 2.4mm; }
ul, ol { margin: 0 0 2.6mm; padding-left: 6mm; }
li { margin-bottom: 1.2mm; }
ul li::marker { color: ${ORANGE}; }
ol.items li::marker { color: ${ORANGE}; font-weight: 700; }
table.data { margin: 1.5mm 0 3mm; font-size: 10pt; break-inside: auto; }
table.data th { background: ${CHARCOAL}; color: #fff; text-align: left; padding: 2.2mm 2.6mm; font-weight: 700; }
table.data td { border: 0.6pt solid #d4d7da; padding: 2mm 2.6mm; vertical-align: top; }
table.data tr { break-inside: avoid; }
table.data .r { text-align: right; white-space: nowrap; }
table.data tr.total td { font-weight: 700; background: #f3f4f5; }
.small { color: ${GREY}; font-size: 9pt; }
.headline { font-size: 11pt; margin: 0 0 5mm; }
.note { margin-bottom: 2.4mm; }
.sign { margin-top: 9mm; break-inside: avoid; }
.sign b { display: block; }
.sign .who { color: ${GREY}; font-size: 9.5pt; }
.accept { margin-top: 9mm; padding-top: 4mm; border-top: 0.6pt solid #d4d7da; break-inside: avoid; }
.accept .line { display: flex; gap: 8mm; margin-top: 6mm; }
.accept .line span { flex: 1; border-bottom: 0.6pt solid ${CHARCOAL}; padding-bottom: 1mm; color: ${GREY}; font-size: 9pt; }
.box { font-family: "Segoe UI Symbol", Arial, sans-serif; }
`

/** The house letterhead: logo, contact block, orange rule. Shared with the feasibility report. */
export const letterhead = ({ logo, draft }) => `<div class="head">
  <img src="${logo}" alt="SY Design Studio">
  <div class="contact">
    ${draft ? '<div class="draft">DRAFT — FOR REVIEW</div>' : ''}
    <div class="tag">${esc(PRACTICE.tagline)}</div>
    ${esc(PRACTICE.phone)}<br>${esc(PRACTICE.email)}<br>${esc(PRACTICE.web)}
  </div>
</div>`

export { CSS as HOUSE_CSS, esc, fmt, bullets, paras, table }

/** @param {ReturnType<typeof normalise>} p  @param {{ logo: string }} assets  logo as a data: URI */
export function renderHtml(p, { logo }) {
  let n = 0
  const section = (title, body) => (body ? `<h2>${++n}.&nbsp; ${esc(title)}</h2>${body}` : '')

  const facts = [
    ['Prepared for', p.client.name],
    ['Project address', p.address],
    ['Local planning authority', p.lpa],
    ['Property type', p.propertyType],
    ['Proposal reference', p.reference + (p.revision ? `  (Revision ${p.revision})` : '')],
    ['Date of issue', longDate(p.issued) + (p.revisedOn ? `  ·  revised ${longDate(new Date(p.revisedOn))}` : '')],
    ['Valid until', longDate(p.validUntil)],
    ['Prepared by', `${PRACTICE.signatory}, ${PRACTICE.role}`],
  ].filter(([, v]) => v)

  const scope = (p.scope ?? [])
    .map((g) => `${g.heading ? `<h3>${fmt(g.heading)}</h3>` : ''}${paras(g.paragraphs)}${bullets(g.bullets)}`)
    .join('')

  const feeTable = table(
    ['Stage', 'When payable', 'Amount'],
    p.fees.stages.map((s, i) => [`${i + 1}.&nbsp; ${fmt(s.stage)}`, fmt(s.when ?? ''), money(s.amount)]),
    { total: [`<b>Total — ${fmt(p.fees.totalLabel ?? 'fixed fee')}</b>`, '', `<b>${money(p.fees.total)}</b>`], align: ['', '', 'r'] },
  )
  const optional = (p.fees.optional ?? []).length
    ? `<h3>Optional</h3>${table(['Item', 'Amount'], p.fees.optional.map((o) => [fmt(o.item), toAmount(o.amount) != null ? money(toAmount(o.amount)) : fmt(o.amount)]), { align: ['', 'r'] })}`
    : ''
  const feeBody =
    feeTable +
    `<p class="small">${fmt(p.fees.vatNote ?? `${PRACTICE.name} is not VAT registered, so no VAT is chargeable on these fees.`)}${p.fees.note ? ' ' + fmt(p.fees.note) : ''}</p>` +
    optional

  const indicative = p.indicative
    ? `${paras(p.indicative.paragraphs)}${bullets(p.indicative.bullets)}${paras(p.indicative.after)}`
    : ''

  const third = (p.thirdParty ?? []).length
    ? table(['Item', 'Cost'], p.thirdParty.map((t) => [fmt(t.item), toAmount(t.cost) != null ? money(toAmount(t.cost)) : fmt(t.cost)]), { align: ['', 'r'] }) +
      (p.thirdPartyNote ? `<p class="small">${fmt(p.thirdPartyNote)}</p>` : '')
    : ''

  const programme = (p.programme ?? []).length
    ? table(['Stage', 'Indicative timing'], p.programme.map((r) => [fmt(r.stage), fmt(r.timing)])) +
      `<p class="small">${fmt(p.programmeNote ?? 'Determination periods are set by the council and are outside our control. We keep the application moving and chase the case officer where progress stalls.')}</p>`
    : ''

  const notes = (p.notes ?? []).length
    ? `${paras(p.notesIntro ? [p.notesIntro] : [])}<ol class="items">${p.notes.map((x) => `<li class="note">${x.title ? `<strong>${esc(x.title)}</strong> ` : ''}${fmt(x.text)}</li>`).join('')}</ol>`
    : ''

  const acceptance = p.acceptance
    ? `<div class="accept"><b>Client acceptance</b>
         <p>I accept this fee proposal and instruct ${PRACTICE.name} to proceed${
           (p.acceptance.options ?? []).length
             ? ` on the: ${p.acceptance.options.map((o) => `<span class="box">☐</span> ${esc(o)}`).join('&nbsp;&nbsp;&nbsp;')}`
             : '.'
         }</p>
         <div class="line"><span>Signed</span><span>Date</span></div>
         <div class="line"><span>Name</span></div></div>`
    : ''

  return `<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><title>Fee Proposal — ${esc(p.address)}</title><style>${CSS}</style></head><body>
<div class="head">
  <img src="${logo}" alt="SY Design Studio">
  <div class="contact">
    ${p.draft ? '<div class="draft">DRAFT — FOR REVIEW</div>' : ''}
    <div class="tag">${esc(PRACTICE.tagline)}</div>
    ${esc(PRACTICE.phone)}<br>${esc(PRACTICE.email)}<br>${esc(PRACTICE.web)}
  </div>
</div>
<h1>Fee Proposal</h1>
<p class="sub">${fmt(p.subtitle)}</p>
<table class="facts">${facts.map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`).join('')}</table>
${p.headline ? `<p class="headline">${fmt(p.headline)}</p>` : ''}
${section('Introduction', (p.salutation ? `<p>${fmt(p.salutation)}</p>` : '') + paras(p.intro))}
${section(p.understandingTitle ?? 'Our understanding of the proposals', (p.understanding ?? []).length ? `<ol class="items">${p.understanding.map((u) => `<li>${fmt(u)}</li>`).join('')}</ol>${paras(p.understandingAfter)}` : '')}
${section(p.scopeTitle ?? 'Scope of works', scope)}
${section(p.fees.title ?? 'Fee and payment stages', feeBody)}
${section(p.indicative?.title ?? 'Building Regulations (indicative)', indicative)}
${(p.extraSections ?? []).map((s) => section(s.title, paras(s.paragraphs) + bullets(s.bullets) + paras(s.after))).join('')}
${section('Third-party and statutory costs (paid directly by you)', third)}
${section('Programme', programme)}
${section('Exclusions', (p.exclusions ?? []).length ? `<p>The following are not included in the fee:</p>${bullets(p.exclusions)}` : '')}
${section(p.notesTitle ?? 'Planning and technical notes', notes)}
${section('Next steps', paras(p.nextSteps))}
<div class="sign">
  <p>${esc(p.signOff ?? 'Kind regards,')}</p>
  <b>${esc(PRACTICE.signatory)}</b>
  <div class="who">Architectural Technologist  |  Director, SY Design Studio Ltd<br>${esc(PRACTICE.phone)}  ·  ${esc(PRACTICE.email)}  ·  ${esc(PRACTICE.web)}</div>
</div>
${acceptance}
</body></html>`
}
