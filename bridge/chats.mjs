import { createReadStream, existsSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync, renameSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { basename, dirname, join } from 'node:path'
import { PROJECTS_DIR, isInjected, redact } from './history.mjs'

/**
 * Chat history: every conversation Salman has had with JARVIS, to look back
 * over and pick up again — the way past chats sit down the side in Claude.
 *
 * Nothing new is stored to make this work. The Agent SDK already writes each
 * session to ~/.claude/projects/D--BUILDING-REGULATIONS/<id>.jsonl, which is
 * what jarvis_history searches; this reads the same files as conversations —
 * his words, JARVIS's answers, and what JARVIS used to get there (a PDF read, a
 * mail search, a register look-up) — and the SDK's `resume` carries one on
 * with its full context. A small index beside the bridge's data holds only
 * what the transcripts cannot: where a chat happened (desk or Telegram), a
 * title he gave it, and whether he has archived it.
 *
 * Read-only on the transcripts. A chat is never deleted, only hidden: they are
 * the memory jarvis_history searches.
 */

export const CHATS_DIR = process.env.JARVIS_CHATS_DIR ?? join(PROJECTS_DIR, 'D--BUILDING-REGULATIONS')
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** What a wake-word recogniser leaves at the front of a sentence. */
const WAKE_LEAD = /^\W*(?:(?:hey|ok|okay|operate|right|so)\W+)*jarvis\b[\s,.!?]*/i
const TAGS = /^\s*(?:\[[^\]]{1,40}\]\s*)+/

/** His words as he would want to read them back. */
export function cleanUserText(text) {
  return String(text ?? '')
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/^\s*\[personality: \w+\]\s*/i, '')
    .replace(TAGS, (m) => (/attached/i.test(m) ? m : ''))
    .replace(WAKE_LEAD, '')
    .trim()
}

/** A tool call as a chip: what was used, and on what. */
export function describeTool(name, input = {}) {
  const short = String(name).replace(/^mcp__[^_]+(?:_[^_]+)*?__/, '').replace(/^mcp__/, '')
  const LABELS = {
    read_planning_document: 'Read document', Read: 'Read file', Glob: 'Looked for files', Grep: 'Searched files',
    WebSearch: 'Searched the web', WebFetch: 'Read web page', search_mail: 'Searched mail', list_mail: 'Checked inbox',
    read_mail: 'Read email', save_attachments: 'Opened attachments', project_search: 'Project history', project_note: 'Noted on project',
    find_job: 'Found job', drawing_pack: 'Drawing pack', planning_history: 'Planning history', planning_application: 'Read application',
    find_precedents: 'Precedents', site_lookup: 'Site constraints', tracker_list: 'Planning tracker', tracker_update: 'Updated tracker',
    tracker_action: 'Added action', browser_open: 'Browsed', browser_read: 'Read page', search_conversations: 'Searched past chats',
    calendar_events: 'Calendar', add_calendar_event: 'Added to calendar', remember: 'Remembered', add_reminder: 'Reminder',
    create_fee_proposal: 'Fee proposal', create_feasibility_report: 'Feasibility report', specline_status: 'Specline',
    draft_email_with_attachments: 'Drafted email', send_email: 'Held email', record_outcome: 'Recorded outcome', playbook: 'Playbook',
  }
  const label = LABELS[short] ?? short.replace(/_/g, ' ')
  const raw = input.path ?? input.file_path ?? input.url ?? input.query ?? input.q ?? input.address ?? input.project ?? input.find ?? input.pattern ?? input.text ?? ''
  let detail = String(raw ?? '')
  if (/[\\/]/.test(detail) && !/^https?:/i.test(detail)) detail = basename(detail.replace(/\\/g, '/'))
  detail = detail.replace(/^https?:\/\/(www\.)?/i, '').replace(/\s+/g, ' ').trim().slice(0, 70)
  return { name: short, label, detail: redact(detail) }
}

/** One transcript → the conversation in it. Pure over the lines, for tests. */
export function parseChat(lines) {
  const messages = []
  let jarvis = false
  let current = null // the JARVIS message being assembled across several lines
  let lastAsker = 'you' // whose turn JARVIS is answering: Salman's, or the bridge's automatic work
  for (const line of lines) {
    let m
    try {
      m = JSON.parse(line)
    } catch {
      continue
    }
    if (m.entrypoint === 'sdk-ts') jarvis = true
    if (m.isSidechain || m.isMeta) continue
    if (m.type === 'user') {
      const c = m.message?.content
      const text = typeof c === 'string' ? c : Array.isArray(c) ? c.filter((b) => b?.type === 'text').map((b) => b.text).join('\n') : ''
      if (!text.trim() || /^\[Request interrupted/.test(text.trim())) continue // a tool result, or a barge-in marker
      current = null
      const auto = isInjected(cleanUserText(text) || text)
      const said = auto ? text.replace(/^\s*\[personality: \w+\]\s*/i, '').trim() : cleanUserText(text)
      if (!said) continue
      lastAsker = auto ? 'auto' : 'you'
      messages.push({ role: auto ? 'auto' : 'you', at: m.timestamp ?? '', text: redact(said) })
    } else if (m.type === 'assistant') {
      const blocks = Array.isArray(m.message?.content) ? m.message.content : []
      if (!current) {
        current = { role: 'jarvis', at: m.timestamp ?? '', text: '', tools: [], after: lastAsker }
        messages.push(current)
      }
      for (const b of blocks) {
        if (b?.type === 'text' && b.text?.trim()) current.text = `${current.text}${current.text ? '\n\n' : ''}${redact(b.text.trim())}`
        if (b?.type === 'tool_use') current.tools.push(describeTool(b.name, b.input ?? {}))
      }
    }
  }
  // A JARVIS message that only ever called tools and said nothing is noise in a transcript.
  return { jarvis, messages: messages.filter((x) => x.role !== 'jarvis' || x.text || x.tools.length) }
}

/** The jobs a chat is about: job numbers and street names counted across what was said. Pure. */
export function projectOf(messages, jobs) {
  if (!jobs.length) return null
  // What Salman asked about, and what JARVIS answered him — not the automatic
  // email work a long Telegram session is full of, which would tag his chat
  // with whichever job last had a council letter.
  const text = messages.filter((m) => m.role === 'you' || (m.role === 'jarvis' && m.after !== 'auto')).map((m) => `${m.text} ${(m.tools ?? []).map((t) => t.detail).join(' ')}`).join(' ').toLowerCase()
  if (!text) return null
  let best = null
  for (const j of jobs) {
    let hits = 0
    if (j.number && new RegExp(`\\b${j.number}\\b`).test(text)) hits += 3
    // The street said in full ("saxon avenue") is as good as the job number.
    if (j.street && text.includes(j.street)) hits += 2
    for (const w of j.words) {
      const n = text.split(w).length - 1
      hits += n
    }
    if (hits && (!best || hits > best.hits)) best = { hits, job: j.number, label: j.label }
  }
  return best && best.hits >= 2 ? { job: best.job, label: best.label } : null
}

const STREET_WORD = /^(road|rd|avenue|ave|street|st|lane|ln|close|cl|drive|dr|way|gardens|gdns|crescent|cres|place|pl|court|ct|grove|terrace|hill|rise|walk|green|park|square|row|mews|knoll|vale|parade|broadway|parkway)$/i

/** Jobs from the NAS list → the words that identify each one in conversation. */
export function jobMatchers(list) {
  const GENERIC = /^(road|rd|avenue|ave|street|st|lane|close|drive|way|gardens|crescent|place|court|grove|terrace|hill|rise|walk|green|park|square|row|mews|london|the|house|flat|unit|south|north|east|west|upper|lower|great|little|high|middle)$/i
  return list
    .filter((j) => j.number && j.address)
    .map((j) => {
      // NAS folder names rarely have commas ("76 Longmeadow Frimely Camberley GU16 8RJ"),
      // so the street is read as far as its road word: "14 Wolsey Close", "76 Longmeadow".
      const tokens = String(j.address).split(',')[0].trim().split(/\s+/)
      const house = /^\d+[a-z]?$/i.test(tokens[0] ?? '') ? tokens.shift() : ''
      const roadAt = tokens.slice(0, 4).findIndex((w) => STREET_WORD.test(w))
      const streetTokens = tokens.slice(0, roadAt >= 0 ? roadAt + 1 : 1)
      const proper = (w) => (w === w.toUpperCase() ? w[0] + w.slice(1).toLowerCase() : w)
      const short = [house, ...streetTokens.map(proper)].filter(Boolean).join(' ')
      const street = streetTokens.join(' ').toLowerCase()
      const words = streetTokens.map((w) => w.toLowerCase()).filter((w) => w.length >= 5 && !GENERIC.test(w)).slice(0, 2)
      return { number: String(j.number), words, street: street.includes(' ') ? street : '', label: `${j.number} · ${short}` }
    })
    .filter((j) => j.words.length || j.number)
}

export function createChats({ dir = CHATS_DIR, indexFile, jobs = () => [] } = {}) {
  const cache = new Map() // file → { mtime, size, data }
  let jobCache = { at: 0, list: [] }

  const loadIndex = () => {
    try {
      return JSON.parse(readFileSync(indexFile, 'utf8'))
    } catch {
      return {}
    }
  }
  const saveIndex = (ix) => {
    mkdirSync(dirname(indexFile), { recursive: true })
    writeFileSync(`${indexFile}.tmp`, JSON.stringify(ix, null, 1))
    renameSync(`${indexFile}.tmp`, indexFile)
  }

  const matchers = () => {
    if (Date.now() - jobCache.at > 10 * 60_000) {
      try {
        jobCache = { at: Date.now(), list: jobMatchers(jobs()) }
      } catch {
        jobCache = { at: Date.now(), list: [] }
      }
    }
    return jobCache.list
  }

  async function read(file) {
    const st = statSync(file)
    const hit = cache.get(file)
    if (hit && hit.mtime === st.mtimeMs && hit.size === st.size) return hit.data
    const lines = []
    const rl = createInterface({ input: createReadStream(file), crlfDelay: Infinity })
    for await (const line of rl) if (line.includes('"type":"user"') || line.includes('"type":"assistant"')) lines.push(line)
    const parsed = parseChat(lines)
    const data = { ...parsed, project: projectOf(parsed.messages, matchers()) }
    cache.set(file, { mtime: st.mtimeMs, size: st.size, data })
    return data
  }

  const fileOf = (id) => (ID.test(String(id)) ? join(dir, `${id}.jsonl`) : null)
  const exists = (id) => {
    const f = fileOf(id)
    return Boolean(f && existsSync(f))
  }

  /** A conversation is one where Salman actually said something. */
  const summary = (id, data, ix) => {
    const said = data.messages.filter((m) => m.role === 'you')
    if (!data.jarvis || !said.length) return null
    const meta = ix[id] ?? {}
    const lastJarvis = [...data.messages].reverse().find((m) => m.role === 'jarvis' && m.text)
    return {
      id,
      title: meta.title || said[0].text.replace(/\s+/g, ' ').slice(0, 80),
      surface: meta.surface ?? '',
      started: data.messages[0]?.at ?? '',
      updated: data.messages[data.messages.length - 1]?.at ?? '',
      turns: said.length,
      preview: (lastJarvis?.text ?? '').replace(/\s+/g, ' ').slice(0, 140),
      project: data.project,
      hidden: Boolean(meta.hidden),
    }
  }

  /** Every conversation, newest first. `q` searches everything said in it. */
  async function list({ q = '', hidden = false, limit = 300 } = {}) {
    let files = []
    try {
      files = readdirSync(dir).filter((f) => f.endsWith('.jsonl'))
    } catch {
      return []
    }
    // Newest files first, so the cost of a long history lands on the old ones.
    files.sort((a, b) => statSync(join(dir, b)).mtimeMs - statSync(join(dir, a)).mtimeMs)
    const ix = loadIndex()
    const needle = String(q).toLowerCase().trim()
    const out = []
    for (const f of files.slice(0, 400)) {
      const id = f.replace(/\.jsonl$/, '')
      let data
      try {
        data = await read(join(dir, f))
      } catch {
        continue
      }
      const s = summary(id, data, ix)
      if (!s || (s.hidden && !hidden)) continue
      if (needle && !`${s.title} ${s.project?.label ?? ''} ${data.messages.map((m) => m.text).join(' ')}`.toLowerCase().includes(needle)) continue
      out.push(s)
      if (out.length >= limit) break
    }
    return out.sort((a, b) => String(b.updated).localeCompare(String(a.updated)))
  }

  async function get(id) {
    const f = fileOf(id)
    if (!f || !existsSync(f)) return null
    const data = await read(f)
    const s = summary(id, data, loadIndex())
    return s ? { ...s, messages: data.messages } : null
  }

  /** Remember where a chat happened, what he called it, whether it is archived. */
  function note(id, patch) {
    if (!ID.test(String(id))) return false
    const ix = loadIndex()
    const cur = ix[id] ?? {}
    const next = { ...cur }
    if (patch.surface && !cur.surface) next.surface = patch.surface
    if (patch.resumedFrom) next.resumedFrom = patch.resumedFrom
    if (typeof patch.title === 'string') next.title = patch.title.replace(/\s+/g, ' ').trim().slice(0, 100)
    if (typeof patch.hidden === 'boolean') next.hidden = patch.hidden
    ix[id] = next
    saveIndex(ix)
    return true
  }

  return { list, get, note, exists }
}
