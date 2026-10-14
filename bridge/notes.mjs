import { readFile, writeFile, rename } from 'node:fs/promises'
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { JOBS_FILE } from './paths.mjs'

/**
 * "Remember that…" — voice capture into the user's own jobs list.
 *
 * A capture that silently fails is worse than none: the user stops writing
 * things down because they think JARVIS has them. So every failure comes back
 * as an error the persona must say out loud, and the write is read back before
 * success is claimed.
 */

export { JOBS_FILE }
const SECTION = '## Captured'

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const today = (d = new Date()) => `${String(d.getDate()).padStart(2, '0')} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`

/**
 * Insert a dated bullet under "## Captured", creating the section at the end
 * of the file if it is not there yet. Pure, so it can be tested.
 */
export function withCapture(markdown, text, date = today()) {
  const line = `- ${date}: ${text.replace(/\s+/g, ' ').trim()}`
  const eol = markdown.includes('\r\n') ? '\r\n' : '\n'
  const lines = markdown.split(/\r?\n/)
  const at = lines.findIndex((l) => l.trim() === SECTION)
  if (at === -1) {
    const body = markdown.replace(/\s+$/, '')
    return `${body}${eol}${eol}${SECTION}${eol}${eol}${line}${eol}`
  }
  // After the section's last bullet, or straight under its heading.
  let end = at + 1
  while (end < lines.length && !/^#{1,6}\s/.test(lines[end])) end++
  let insert = end
  while (insert > at + 1 && lines[insert - 1].trim() === '') insert--
  if (insert === at + 1) {
    lines.splice(at + 1, 0, '', line)
  } else {
    lines.splice(insert, 0, line)
  }
  return lines.join(eol)
}

export async function capture(text, file = JOBS_FILE) {
  const clean = String(text ?? '').trim()
  if (!clean) throw new Error('there was nothing to remember')
  const before = await readFile(file, 'utf8')
  const after = withCapture(before, clean)
  await writeFile(`${file}.tmp`, after, 'utf8')
  await rename(`${file}.tmp`, file)
  const check = await readFile(file, 'utf8')
  if (!check.includes(clean.replace(/\s+/g, ' '))) throw new Error('the note did not survive the write')
  return clean
}

export function notesServer() {
  return createSdkMcpServer({
    name: 'jarvis_notes',
    version: '1.0.0',
    instructions:
      "Captures go into the user's jobs list (JOBS.md) under Captured. When asked " +
      'what they told you to remember, read that section.',
    alwaysLoad: true,
    tools: [
      tool(
        'remember',
        'Write down something the user wants kept. Use for "remember that…", "note to ' +
          'self…", "don\'t let me forget…", "log this…", "make a note…". Pass just the ' +
          'thing to remember, in their words, without the trigger phrase. It is saved ' +
          'to JOBS.md under Captured and can be read back immediately.',
        { text: z.string() },
        async ({ text }) => {
          try {
            await capture(text)
            return {
              content: [
                { type: 'text', text: 'Saved to JOBS.md under Captured. Confirm in one short line, in character.' },
              ],
            }
          } catch (err) {
            return {
              isError: true,
              content: [
                {
                  type: 'text',
                  text:
                    `The note was NOT saved: ${err?.message ?? err}. Tell the user plainly ` +
                    'that it was not written down, so they can note it themselves.',
                },
              ],
            }
          }
        },
      ),
    ],
  })
}
