import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { normalise, renderHtml, money } from './render.mjs'
import { htmlToPdf } from './pdf.mjs'
import { PATHS, LOGO_FILE, STYLE_GUIDE_FILE } from '../paths.mjs'

/**
 * Fee proposals, drafted by JARVIS in the house style.
 *
 * The model writes the words; this module owns the layout, the logo, the
 * totals and the file. Everything is a DRAFT until Salman says to issue it,
 * and the PDF goes to his Telegram so he can read it on his phone. Nothing is
 * ever sent to a client from here.
 */

export const OUT_DIR = PATHS.proposals
export const LOGO = LOGO_FILE
export const STYLE_GUIDE = STYLE_GUIDE_FILE

/** "94 Ellerman Avenue, Twickenham" → "SY_Fee_Proposal_Ellerman_Avenue" — the names already in use. */
export function fileName(p) {
  const street = String(p.address).split(',')[0].replace(/^\d+[a-z]?\s+/i, '').trim()
  const slug = street.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'Proposal'
  return `SY_Fee_Proposal_${slug}${p.revision ? `_Rev${p.revision}` : ''}${p.draft ? '_DRAFT' : ''}.pdf`
}

const text = z.string()
const list = z.array(z.string()).optional()

const SCHEMA = {
  draft: z.boolean().optional().describe('true (default) marks it DRAFT FOR REVIEW. Only false when Salman says to issue it.'),
  client: z.object({ name: text }),
  salutation: z.string().optional().describe('e.g. "Dear Mr Mir," — used on letter-style proposals.'),
  address: text,
  lpa: z.string().optional(),
  propertyType: z.string().optional(),
  reference: z.string().optional().describe('e.g. "EA / FP-01"; derived from the street if omitted.'),
  revision: z.string().optional().describe('"A", "B"… for a revised proposal.'),
  issued: z.string().optional().describe('ISO date of first issue; today if omitted.'),
  revisedOn: z.string().optional(),
  validDays: z.number().optional(),
  subtitle: text.describe('Application type and works, one line.'),
  headline: z.string().optional().describe('Optional one-sentence summary with the fixed fee, shown above the introduction.'),
  intro: list,
  understandingTitle: z.string().optional(),
  understanding: list,
  understandingAfter: list,
  scopeTitle: z.string().optional(),
  scope: z.array(z.object({ heading: z.string().optional(), paragraphs: list, bullets: list })).optional(),
  fees: z.object({
    title: z.string().optional(),
    totalLabel: z.string().optional(),
    stages: z.array(z.object({ stage: text, when: z.string().optional(), amount: z.union([z.number(), z.string()]) })),
    statedTotal: z.union([z.number(), z.string()]).optional().describe('If given, must equal the sum of the stages or the proposal is refused.'),
    note: z.string().optional(),
    optional: z.array(z.object({ item: text, amount: z.union([z.number(), z.string()]) })).optional(),
  }),
  indicative: z.object({ title: z.string().optional(), paragraphs: list, bullets: list, after: list }).optional(),
  extraSections: z.array(z.object({ title: text, paragraphs: list, bullets: list, after: list })).optional(),
  thirdParty: z.array(z.object({ item: text, cost: z.union([z.number(), z.string()]) })).optional(),
  thirdPartyNote: z.string().optional(),
  programme: z.array(z.object({ stage: text, timing: text })).optional(),
  programmeNote: z.string().optional(),
  exclusions: list,
  notesTitle: z.string().optional(),
  notesIntro: z.string().optional(),
  notes: z.array(z.object({ title: z.string().optional(), text })).optional(),
  nextSteps: list,
  acceptance: z.object({ options: list }).optional().describe('Include for a signature block; options like ["LDC route","Planning route"].'),
  send_to_telegram: z.boolean().optional().describe('Send the PDF to Salman on Telegram. Default true.'),
}

/**
 * @param {object} io
 * @param {(path: string, caption: string) => Promise<boolean>} io.sendDocument
 */
export function proposalsServer({ sendDocument = async () => false } = {}) {
  return createSdkMcpServer({
    name: 'jarvis_proposals',
    version: '1.0.0',
    instructions:
      `Fee proposals in the SY Design Studio house style. Before drafting, read the house style guide at ${STYLE_GUIDE} ` +
      '— it has the structure, practice facts, standard exclusions, fee reference points and tone.',
    alwaysLoad: true,
    tools: [
      tool(
        'create_fee_proposal',
        'Produce a fee proposal PDF in the house style, with the logo, and (by default) send it to Salman on ' +
          `Telegram. FIRST read ${STYLE_GUIDE} and follow it. Write every section in full, specific to this ` +
          'job — the property, the council, the policy, the risks. Never invent the fee: use Salman\'s figure; ' +
          'if he has not given one, propose one from the reference points in the guide and past conversations, ' +
          'say what it is based on, and keep draft=true. Totals are computed from the stages. It stays a DRAFT ' +
          'until Salman says "issue it" — then call again with draft=false (and a revision letter if it changed). ' +
          'This never sends anything to a client.',
        SCHEMA,
        async (input) => {
          const data = { ...input, draft: input.draft !== false }
          let p
          try {
            p = normalise(data)
          } catch (err) {
            return { isError: true, content: [{ type: 'text', text: `Proposal not produced: ${err.message}.` }] }
          }
          if (!existsSync(LOGO)) {
            return { isError: true, content: [{ type: 'text', text: `The logo is missing from ${LOGO}; not producing an unbranded proposal.` }] }
          }
          const logo = `data:image/png;base64,${readFileSync(LOGO).toString('base64')}`
          mkdirSync(OUT_DIR, { recursive: true })
          const out = join(OUT_DIR, fileName(p))
          let result
          try {
            result = await htmlToPdf(renderHtml(p, { logo }), out)
          } catch (err) {
            return { isError: true, content: [{ type: 'text', text: `The PDF could not be produced: ${err.message}.` }] }
          }
          let sent = false
          if (input.send_to_telegram !== false) {
            sent = await sendDocument(out, `${p.draft ? 'DRAFT — ' : ''}Fee proposal, ${p.address} · ${p.reference} · ${money(p.fees.total)}`)
          }
          return {
            content: [
              {
                type: 'text',
                text:
                  `${p.draft ? 'Draft' : 'Issued'} fee proposal saved: ${out} (${result.pages} pages). Total ${money(p.fees.total)}.` +
                  (input.send_to_telegram !== false ? (sent ? ' Sent to Telegram.' : ' Could NOT be sent to Telegram — say so.') : '') +
                  ' Tell Salman in one or two lines; do not read the proposal out.',
              },
            ],
          }
        },
      ),
    ],
  })
}
