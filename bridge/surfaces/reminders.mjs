import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs'
import { dirname } from 'node:path'
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { readFile, writeFile, rename } from 'node:fs/promises'

/**
 * Diary entries and reminders.
 *
 * A diary entry is a dated line under "## Diary" in JOBS.md — the list the
 * user already keeps. A reminder is the same line plus a nudge on Telegram
 * (and the desk, if a page is open) at the moment it falls due. Both are
 * kept in a small file so a restart forgets nothing.
 */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/** "- Tue 29 Sep 2026, 1.30pm: text" — the style JOBS.md already uses. */
export const diaryLine = (when, text) => {
  const d = new Date(when)
  const h = d.getHours()
  const m = d.getMinutes()
  let time = ''
  if (h || m) {
    const h12 = h % 12 || 12
    time = `, ${h12}${m ? `.${String(m).padStart(2, '0')}` : ''}${h < 12 ? 'am' : 'pm'}`
  }
  return `- ${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}${time}: ${text.trim()}`
}

/** Insert a line under "## Diary", creating the section if it is missing. Pure. */
export function withDiary(markdown, line) {
  const eol = markdown.includes('\r\n') ? '\r\n' : '\n'
  const lines = markdown.split(/\r?\n/)
  const at = lines.findIndex((l) => l.trim() === '## Diary')
  if (at === -1) return `${markdown.replace(/\s+$/, '')}${eol}${eol}## Diary${eol}${eol}${line}${eol}`
  let end = at + 1
  while (end < lines.length && !/^#{1,6}\s/.test(lines[end])) end++
  let insert = end
  while (insert > at + 1 && lines[insert - 1].trim() === '') insert--
  if (insert === at + 1) lines.splice(at + 1, 0, '', line)
  else lines.splice(insert, 0, line)
  return lines.join(eol)
}

/**
 * "tomorrow at 3", "Friday 10.30", "in 20 minutes", "2026-10-02 14:00".
 * Returns a Date or null. Deliberately plain; the model is told to pass an
 * ISO time when it can, and this is the fallback for what it says instead.
 */
export function parseWhen(text, now = new Date()) {
  const s = String(text ?? '').trim().toLowerCase()
  if (!s) return null
  const iso = new Date(s)
  if (/^\d{4}-\d{2}-\d{2}/.test(s) && !Number.isNaN(iso)) return iso
  const d = new Date(now)
  const rel = /in\s+(\d+)\s*(minute|min|hour|hr|day)s?/.exec(s)
  if (rel) {
    const n = Number(rel[1])
    const unit = rel[2]
    d.setTime(d.getTime() + n * (unit.startsWith('min') ? 60_000 : unit.startsWith('h') ? 3_600_000 : 86_400_000))
    return d
  }
  if (/\btomorrow\b/.test(s)) d.setDate(d.getDate() + 1)
  const day = DAYS.findIndex((x) => new RegExp(`\\b${x.toLowerCase()}`).test(s))
  if (day >= 0) {
    let delta = (day - d.getDay() + 7) % 7
    if (delta === 0 && !/\btoday\b/.test(s)) delta = 7
    d.setDate(d.getDate() + delta)
  }
  const dm = /\b(\d{1,2})(?:st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/.exec(s)
  if (dm) {
    d.setMonth(MONTHS.findIndex((m) => m.toLowerCase() === dm[2]), Number(dm[1]))
    if (d < now) d.setFullYear(d.getFullYear() + 1)
  }
  const t = /\b(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm|o'clock)?\b/.exec(s.replace(/\bin\s+\d+\s*\w+/, ''))
  if (t && (t[2] || t[3] || /\bat\b/.test(s))) {
    let h = Number(t[1])
    const m = Number(t[2] ?? 0)
    if (t[3] === 'pm' && h < 12) h += 12
    if (t[3] === 'am' && h === 12) h = 0
    if (!t[3] && h < 8) h += 12
    d.setHours(h, m, 0, 0)
  } else {
    d.setHours(9, 0, 0, 0)
  }
  return d
}

function readList(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return []
  }
}
function writeList(path, list) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(`${path}.tmp`, JSON.stringify(list, null, 2))
  renameSync(`${path}.tmp`, path)
}

/**
 * @param {object} io
 * @param {string} io.jobsFile
 * @param {string} io.statePath
 * @param {(text: string) => Promise<boolean>} io.notify   Telegram
 * @param {(text: string) => void} io.announce             the desk
 */
export function createReminders({ jobsFile, statePath, notify, announce = () => {}, log = console.log }) {
  let list = readList(statePath)
  let timer = null

  async function addDiary(when, text) {
    const line = diaryLine(when, text)
    const before = await readFile(jobsFile, 'utf8')
    const after = withDiary(before, line)
    await writeFile(`${jobsFile}.tmp`, after, 'utf8')
    await rename(`${jobsFile}.tmp`, jobsFile)
    return line
  }

  async function add({ when, text, remind = true }) {
    const at = when instanceof Date ? when : parseWhen(when)
    if (!at || Number.isNaN(at)) throw new Error(`I could not make a time out of "${when}"`)
    const line = await addDiary(at, text)
    if (remind) {
      list.push({ id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, at: at.toISOString(), text: text.trim(), done: false })
      writeList(statePath, list)
    }
    return { at, line }
  }

  async function tick() {
    const now = Date.now()
    let changed = false
    for (const r of list) {
      if (r.done || new Date(r.at).getTime() > now) continue
      r.done = true
      changed = true
      const msg = `Reminder: ${r.text}`
      log(`[jarvis:reminders] due: ${r.text}`)
      await notify(msg)
      announce(`Sir, a reminder. ${r.text}`)
    }
    if (changed) {
      list = list.filter((r) => !r.done || Date.now() - new Date(r.at).getTime() < 7 * 86_400_000)
      writeList(statePath, list)
    }
  }

  const server = () =>
    createSdkMcpServer({
      name: 'jarvis_diary',
      version: '1.0.0',
      instructions: "Diary entries and reminders in the user's JOBS.md, with a Telegram nudge when a reminder falls due.",
      alwaysLoad: true,
      tools: [
        tool(
          'add_reminder',
          'Set a reminder or diary entry. Use for "remind me to…", "put in my diary…", "add to my calendar…", ' +
            '"note that on Friday…". Pass `when` as an ISO date-time if you can work one out from what they said, ' +
            'otherwise their words ("tomorrow at 3", "Friday 10.30", "in 20 minutes"). remind=false for a plain diary line.',
          {
            when: z.string(),
            text: z.string(),
            remind: z.boolean().optional().catch(undefined),
          },
          async (a) => {
            try {
              const { at, line } = await add({ when: a.when, text: a.text, remind: a.remind !== false })
              return { content: [{ type: 'text', text: `Written to JOBS.md: "${line.slice(2)}". ${a.remind === false ? '' : `A nudge will come at ${at.toLocaleString('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short' })}.`} Confirm in one line.` }] }
            } catch (err) {
              return { isError: true, content: [{ type: 'text', text: `NOT saved: ${err.message}. Tell the user plainly.` }] }
            }
          },
        ),
        tool(
          'list_reminders',
          'The reminders that have not fired yet.',
          {},
          async () => {
            const open = list.filter((r) => !r.done).sort((a, b) => a.at.localeCompare(b.at))
            if (!open.length) return { content: [{ type: 'text', text: 'No reminders pending.' }] }
            return { content: [{ type: 'text', text: open.map((r) => `${new Date(r.at).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })} — ${r.text}`).join('\n') }] }
          },
        ),
      ],
    })

  return {
    add,
    makeServer: server,
    start() {
      timer = setInterval(() => void tick(), 30_000)
      void tick()
    },
    stop() {
      if (timer) clearInterval(timer)
      timer = null
    },
    pending: () => list.filter((r) => !r.done).length,
  }
}
