import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, basename, extname } from 'node:path'
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { locate, constraints } from './constraints.mjs'
import { registerFor } from './registers.mjs'
import { pdfText } from './pdftext.mjs'
import { session } from './http.mjs'
import { openProject, addNote, listProjects, PROJECTS_DIR, SECTIONS } from './projects.mjs'
import { normaliseReport, renderReport } from './report.mjs'
import { htmlToPdf } from '../proposals/pdf.mjs'
import { LOGO } from '../proposals/index.mjs'
import { RESEARCH_METHOD_FILE } from '../paths.mjs'

/**
 * Property research: constraints, the planning register, officer reports,
 * precedents, and a project file that remembers all of it, ending in a
 * feasibility report. The method is written down for Salman to edit:
 */
export const METHOD = RESEARCH_METHOD_FILE

const MAX_TEXT = 24_000
const ok = (text) => ({ content: [{ type: 'text', text }] })
const fail = (text) => ({ isError: true, content: [{ type: 'text', text }] })

const browserHelp = (reg, what) =>
  `${reg.council} runs a JavaScript planning portal that cannot be searched by script: ${reg.base}\n` +
  `Use the browser_* tools to ${what} in the JARVIS Chrome window: browser_open that page, browser_type the address and submit, ` +
  'browser_click the application, read its Documents tab, and browser_save the officer report or decision notice (then read_planning_document). ' +
  'If a CAPTCHA or "are you human" check appears, stop and ask Salman to complete it in the window — never try to get past it. ' +
  'If the browser cannot be opened, say so and give him the link.'

async function registerForAddress(address, council, override) {
  if (council || override) return { reg: registerFor(council, { override }), place: null }
  const place = await locate(address)
  return { reg: registerFor(place.lpa), place }
}

const rowLine = (r) =>
  r.keyVal
    ? `[${r.keyVal}] ${r.reference} · ${r.status}${r.decision ? ` · ${r.decision}` : ''} · ${r.received ?? ''} — ${r.proposal} (${r.address})`
    : `[${r.reference}] ${r.text}`

/**
 * @param {object} io
 * @param {(path: string, caption: string) => Promise<boolean>} io.sendDocument
 */
export function researchServer({ sendDocument = async () => false } = {}) {
  return createSdkMcpServer({
    name: 'jarvis_research',
    version: '1.0.0',
    instructions:
      `Property and planning research. Follow ${METHOD}. Everything found is filed in the project's PROJECT.md ` +
      `(${PROJECTS_DIR}), which is also where to look first for anything already known about a property.`,
    alwaysLoad: true,
    tools: [
      tool(
        'site_lookup',
        'Locate a property and list its designations: council, ward, conservation area, Article 4 directions, ' +
          'listed buildings on or near the site, tree preservation zones, flood zone, green belt. Needs the postcode ' +
          'in the address. Opens the project file and records what it found.',
        { address: z.string() },
        async ({ address }) => {
          try {
            const place = await locate(address)
            const c = await constraints(place)
            const reg = registerFor(place.lpa)
            const lines = [
              `Council: ${place.lpa} · Ward: ${place.ward} · ${place.postcode} (${place.lat.toFixed(5)}, ${place.lng.toFixed(5)})`,
              `Conservation area: ${c.conservationAreas.join(', ') || 'none found'}`,
              `Article 4: ${c.article4.map((a) => a.name).join('; ') || 'none found'}`,
              `Listed building on site: ${c.listedOnSite.join(', ') || 'none found'}`,
              `Listed buildings within ~70 m: ${c.listedNearby.map((l) => `${l.name} (Grade ${l.grade}, ${l.metres} m)`).join('; ') || 'none'}`,
              `Tree preservation: ${c.treePreservation.join(', ') || 'none found'}`,
              `Flood risk: ${c.flood.join(', ') || 'none found (Flood Zone 1)'}`,
              `Green belt: ${c.greenBelt ? 'YES' : 'no'} · Other heritage: ${c.heritage.join(', ') || 'none'} · AONB: ${c.aonb.join(', ') || 'no'}`,
              `Basis: ${c.basis}.`,
              `Planning register: ${reg ? `${reg.kind === 'browser' ? 'browser only — ' : ''}${reg.base}` : 'not known — find it with WebSearch and pass register_url to planning_history'}`,
            ]
            const p = addNote(address, 'Site and constraints', lines.slice(0, 8).join(' | '))
            return ok(`${lines.join('\n')}\n\nFiled in ${p.file}.`)
          } catch (err) {
            return fail(`Site lookup failed: ${err.message}.`)
          }
        },
      ),
      tool(
        'planning_history',
        'Every application the council register holds for this address. Search with the house number, street and ' +
          'postcode as the council would write it. Returns ids to pass to planning_application. Files the list in the ' +
          'project. For councils with a browser-only portal it explains how to do it in Chrome.',
        {
          address: z.string(),
          council: z.string().optional().catch(undefined),
          register_url: z.string().optional().catch(undefined).describe('An Idox ".../online-applications" or Ocella base URL, for a council not yet known.'),
        },
        async (a) => {
          try {
            const { reg } = await registerForAddress(a.address, a.council, a.register_url)
            if (!reg) return fail('That council\u2019s register is not known. Find it with WebSearch; if it is Idox or Ocella, call again with register_url.')
            if (reg.kind === 'browser') return ok(browserHelp(reg, 'find the planning history'))
            const q = reg.kind === 'ocella' ? a.address.split(',')[0].replace(/^\d+[a-z]?\s+/i, '') : a.address.replace(/,/g, ' ')
            const rows = await reg.search(q)
            const num = /^\s*(\d+[a-z]?)\b/i.exec(a.address)?.[1]
            const mine = num ? rows.filter((r) => new RegExp(`\\b${num}\\b`).test(r.address ?? r.text ?? '')) : rows
            const list = mine.length ? mine : rows
            if (!list.length) return ok(`No applications found on the ${reg.council} register for "${q}". Try the street alone, or the address as the council spells it.`)
            addNote(a.address, 'Planning history', list.map((r) => (r.keyVal ? `${r.reference} (${r.status}) ${r.proposal}` : r.text)).join(' | ').slice(0, 2000))
            return ok(
              `${reg.council} register, ${list.length} application(s)${mine.length ? '' : ' on the street (none matched the house number)'}:\n` +
                list.map(rowLine).join('\n') +
                '\n\nOpen the decided ones with planning_application to read the officer report.',
            )
          } catch (err) {
            return fail(`The register search failed: ${err.message}.`)
          }
        },
      ),
      tool(
        'find_precedents',
        'Comparable applications nearby — the same street or area, similar works. Pass the council and a query such ' +
          'as a street name ("Worple Road"), optionally with keywords to keep ("dormer", "rear extension"). Files the ' +
          'relevant ones under Precedents in the project.',
        {
          address: z.string().describe('The subject property, for filing.'),
          query: z.string().describe('Street or area to search the register for.'),
          keywords: z.array(z.string()).optional().catch(undefined),
          council: z.string().optional().catch(undefined),
          register_url: z.string().optional().catch(undefined),
        },
        async (a) => {
          try {
            const { reg } = await registerForAddress(a.address, a.council, a.register_url)
            if (!reg) return fail('That council\u2019s register is not known. Find it with WebSearch and pass register_url.')
            if (reg.kind === 'browser') return ok(browserHelp(reg, `search "${a.query}" for comparable applications`))
            const rows = await reg.search(a.query, { max: 40 })
            const kws = (a.keywords ?? []).map((k) => k.toLowerCase())
            const hits = kws.length ? rows.filter((r) => kws.some((k) => `${r.proposal ?? ''} ${r.text ?? ''}`.toLowerCase().includes(k))) : rows
            if (!hits.length) return ok(`${rows.length} applications on "${a.query}", none matching ${kws.join(', ') || 'the query'}.`)
            addNote(a.address, 'Precedents nearby', hits.slice(0, 12).map((r) => (r.keyVal ? `${r.reference} ${r.address}: ${r.proposal} (${r.status})` : r.text)).join(' | ').slice(0, 2500))
            return ok(`${hits.length} comparable application(s):\n${hits.map(rowLine).join('\n')}\n\nOpen the relevant decided ones with planning_application for the officer's reasoning.`)
          } catch (err) {
            return fail(`The precedent search failed: ${err.message}.`)
          }
        },
      ),
      tool(
        'planning_application',
        'Open one application: its full details, the documents list with the officer report ranked first, and — where ' +
          'the council allows it — the officer report itself, read and saved to the project. Pass the id from ' +
          'planning_history / find_precedents, and the property address it is being researched for.',
        {
          id: z.string(),
          address: z.string().describe('The property this research is for (for filing).'),
          council: z.string().optional().catch(undefined),
          register_url: z.string().optional().catch(undefined),
        },
        async (a) => {
          try {
            const { reg } = await registerForAddress(a.address, a.council, a.register_url)
            if (!reg || reg.kind === 'browser') return fail('Not a searchable register for this council; use the browser_* tools as planning_history explained.')
            const d = await reg.detail(a.id)
            const s = d.summary
            const head = Object.entries({ ...s, ...(d.details ?? {}) })
              .filter(([k]) => /reference|address|location|proposal|status|decision|appeal|case officer|received|validated|decided|issued|application type|ward/i.test(k))
              .map(([k, v]) => `${k}: ${v}`)
              .join('\n')
            let out = `${head}\nLink: ${d.url}\n`
            const report = (d.documents ?? []).find((x) => x.kind === 'officer report' || x.kind === 'report') ?? (d.documents ?? []).find((x) => x.kind === 'decision')
            if (d.documents?.length) out += `\nDocuments (${d.documents.length}):\n${d.documents.slice(0, 8).map((x) => `- ${x.kind}: ${x.text} → ${x.url}`).join('\n')}\n`
            else if (reg.kind === 'ocella') out += '\nThis register keeps documents in a separate system: open the link above and use its documents button (or ask Salman to).\n'
            const ref = s.Reference ?? s.reference ?? a.id
            if (report && !d.gated && reg.fetchDocument) {
              try {
                const buf = await reg.fetchDocument(a.id, report.url)
                const p = openProject(a.address)
                const file = join(p.folder, 'documents', `${String(ref).replace(/[^\w.-]+/g, '_')} - ${basename(new URL(report.url).pathname)}`)
                writeFileSync(file, buf)
                const t = await pdfText(buf)
                addNote(a.address, 'Documents', `${ref} ${report.kind} saved: ${file}`)
                out += `\n${report.kind.toUpperCase()} (${t.pages} pages${t.scanned ? ', scanned — little text' : ''}), saved to ${file}:\n${t.text.slice(0, MAX_TEXT)}${t.text.length > MAX_TEXT ? '\n…(continues — read_planning_document with pages to read on)' : ''}`
              } catch (err) {
                out += `\nThe ${report.kind} could not be downloaded (${err.message}). Give Salman this link: ${report.url}\n`
              }
            } else if (report && d.gated) {
              out += `\nThis council puts its documents behind a CAPTCHA, so they cannot be read automatically. Give Salman the ${report.kind} link to open (${report.url}) and ask him to forward the PDF to Telegram; it will then reach you as a file to read.\n`
            }
            out += '\nFile what matters with project_note — especially the officer\u2019s reasons, in their own words.'
            return ok(out)
          } catch (err) {
            return fail(`Could not open the application: ${err.message}.`)
          }
        },
      ),
      tool(
        'read_planning_document',
        'Read a planning PDF — an officer report, decision notice, appeal decision, policy document — from a URL or a ' +
          'file on this PC (e.g. one Salman forwarded on Telegram). Use `from_page` to read on through a long document.',
        {
          source: z.string().describe('https:// URL or a local path to a .pdf'),
          address: z.string().optional().catch(undefined).describe('Property to file it under, if any.'),
          from_page: z.union([z.number(), z.string()]).optional().catch(undefined),
        },
        async (a) => {
          try {
            let buf
            if (/^https?:\/\//i.test(a.source)) {
              const f = await session().get(a.source, { binary: true })
              buf = f.buffer
              if (buf.subarray(0, 4).toString() !== '%PDF') return fail('That link returned a web page, not a PDF — it may need a CAPTCHA. Ask Salman to open it and forward the PDF.')
              if (a.address) {
                const p = openProject(a.address)
                const file = join(p.folder, 'documents', basename(new URL(a.source).pathname) || 'document.pdf')
                writeFileSync(file, buf)
              }
            } else {
              if (extname(a.source).toLowerCase() !== '.pdf' || !existsSync(a.source)) return fail('Not a PDF on this PC.')
              buf = readFileSync(a.source)
            }
            const t = await pdfText(buf)
            const from = Math.max(1, Number(a.from_page) || 1)
            const pages = t.text.split(/(?=--- page \d+ ---)/).slice(from - 1)
            const text = pages.join('\n')
            return ok(`${t.pages} pages${t.scanned ? ' (scanned — little text layer)' : ''}, from page ${from}:\n${text.slice(0, MAX_TEXT)}${text.length > MAX_TEXT ? '\n…(continues)' : ''}`)
          } catch (err) {
            return fail(`Could not read the document: ${err.message}.`)
          }
        },
      ),
      tool(
        'project_file',
        'What is already known about a property: its PROJECT.md — constraints, history, officer findings, policy, ' +
          'precedents, route, and every decision discussed. Read this FIRST whenever a property comes up. Without an ' +
          'address, lists the projects.',
        { address: z.string().optional().catch(undefined) },
        async ({ address }) => {
          if (!address) {
            const all = listProjects()
            return ok(all.length ? `Projects:\n${all.join('\n')}` : 'No project files yet.')
          }
          const p = openProject(address, { create: false })
          return p ? ok(`${p.file}\n\n${p.markdown}`) : ok(`No project file yet for ${address}. Research will create one.`)
        },
      ),
      tool(
        'project_note',
        `Record something about a property in its PROJECT.md, dated. Sections: ${SECTIONS.join(', ')}. Use it for ` +
          'what was found (with references), the officer\u2019s reasons in their words, and — always — what Salman ' +
          'decides or says about the project in conversation ("Discussion and decisions"). ' +
          'ALWAYS give `source` — where this came from, e.g. "Salman on the phone", "email from Navil Rahman (Surrey Heath)", ' +
          '"drawing BR 1110 rev D", "WhatsApp with Nav Cheema", "Hounslow register P/2008/2371". ' +
          'When this replaces something recorded earlier (a new fee, a changed brief, a revised drawing), pass `supersedes` with a ' +
          'distinctive phrase from the old note: it is marked [SUPERSEDED], not deleted.',
        {
          address: z.string(),
          section: z.string(),
          text: z.string(),
          source: z.string().optional().catch(undefined),
          supersedes: z.string().optional().catch(undefined),
        },
        async (a) => {
          try {
            const p = addNote(a.address, a.section, a.text, { source: a.source, supersedes: a.supersedes })
            const rep = a.supersedes ? (p.replaced ? ` Marked superseded: ${p.replaced}` : ` Nothing matching "${a.supersedes}" was found to supersede — say so.`) : ''
            return ok(`Noted under ${a.section} in ${p.file}.${rep}`)
          } catch (err) {
            return fail(`NOT recorded: ${err.message}. Say so.`)
          }
        },
      ),
      tool(
        'create_feasibility_report',
        `Produce the planning feasibility report PDF in the house style, saved in the project's reports folder and ` +
          `sent to Salman on Telegram. Follow the report section of ${METHOD}. Use only what was actually found, with ` +
          'references; quote officers where it matters; recommend ONE route and say why; list sources. DRAFT until ' +
          'Salman says to issue it.',
        {
          draft: z.boolean().optional(),
          address: z.string(),
          subtitle: z.string().optional(),
          lpa: z.string().optional(),
          ward: z.string().optional(),
          client: z.string().optional(),
          proposal: z.string().optional().describe('The works being considered.'),
          reference: z.string().optional(),
          recommendation: z.object({
            route: z.string().describe('e.g. "Lawful Development Certificate (permitted development)", "Pre-application advice, then householder application"'),
            prospects: z.enum(['good', 'fair', 'poor']),
            summary: z.string(),
            keyPoints: z.array(z.string()).optional(),
          }),
          site: z.array(z.string()).optional(),
          constraints: z.array(z.object({ item: z.string(), finding: z.string(), implication: z.string().optional() })).optional(),
          constraintsNote: z.string().optional(),
          history: z.array(z.object({ reference: z.string(), proposal: z.string(), decision: z.string().optional(), date: z.string().optional() })).optional(),
          historyNotes: z.array(z.string()).optional(),
          officerFindings: z.array(z.object({ application: z.string().optional(), quote: z.string().optional(), point: z.string() })).optional(),
          policy: z.array(z.object({ name: z.string(), says: z.string().optional() })).optional(),
          policyNotes: z.array(z.string()).optional(),
          precedents: z.array(z.object({ reference: z.string(), address: z.string(), proposal: z.string(), decision: z.string().optional(), relevance: z.string().optional() })).optional(),
          precedentNotes: z.array(z.string()).optional(),
          permittedDevelopment: z.array(z.string()).optional(),
          options: z.array(z.object({ route: z.string(), pros: z.string().optional(), cons: z.string().optional(), timeCost: z.string().optional() })).optional(),
          optionNotes: z.array(z.string()).optional(),
          designParameters: z.array(z.string()).optional(),
          risks: z.array(z.object({ title: z.string().optional(), text: z.string() })).optional(),
          nextSteps: z.array(z.string()).optional(),
          sources: z.array(z.string()).optional(),
          send_to_telegram: z.boolean().optional(),
        },
        async (input) => {
          let r
          try {
            r = normaliseReport({ ...input, draft: input.draft !== false })
          } catch (err) {
            return fail(`Report not produced: ${err.message}.`)
          }
          if (!existsSync(LOGO)) return fail(`The logo is missing from ${LOGO}.`)
          const logo = `data:image/png;base64,${readFileSync(LOGO).toString('base64')}`
          const p = openProject(r.address)
          mkdirSync(join(p.folder, 'reports'), { recursive: true })
          const stamp = r.issued.toISOString().slice(0, 10)
          const out = join(p.folder, 'reports', `SY_Feasibility_${p.name.replace(/[^\w]+/g, '_')}_${stamp}${r.draft ? '_DRAFT' : ''}.pdf`)
          let result
          try {
            result = await htmlToPdf(renderReport(r, { logo }), out)
          } catch (err) {
            return fail(`The PDF could not be produced: ${err.message}.`)
          }
          addNote(r.address, 'Options and route', `Feasibility report ${r.draft ? '(draft) ' : ''}recommends: ${r.recommendation.route} — ${r.recommendation.prospects} prospects. ${out}`)
          const sent = input.send_to_telegram === false ? false : await sendDocument(out, `${r.draft ? 'DRAFT — ' : ''}Feasibility report, ${r.address} · recommended: ${r.recommendation.route}`)
          return ok(`${r.draft ? 'Draft' : 'Issued'} feasibility report saved: ${out} (${result.pages} pages).${input.send_to_telegram === false ? '' : sent ? ' Sent to Telegram.' : ' Could NOT be sent to Telegram — say so.'} Tell Salman the recommendation in one or two lines.`)
        },
      ),
    ],
  })
}
