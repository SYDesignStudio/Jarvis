import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Two personalities, switchable by voice or Telegram, remembered across restarts.
 *
 *   classic — JARVIS exactly as he was: the persona in server.mjs, word for word.
 *   film    — full film JARVIS: the same persona, with the wit turned up, callbacks
 *             allowed, and one dry push-back on bad ideas. Approved by Salman
 *             29 Sep 2026 ("go full film Jarvis … push back on ideas … make sure I
 *             can go back to old Jarvis").
 *
 * Both are in the system prompt; every user turn carries a one-line tag naming
 * the one in force. That makes a switch instant — no restart, no lost
 * conversation — because the system prompt of a running session cannot change.
 */

export const MODES = ['film', 'classic']
const FILE = fileURLToPath(new URL('../data/personality.json', import.meta.url))

const defaultMode = () => (MODES.includes(process.env.JARVIS_PERSONALITY) ? process.env.JARVIS_PERSONALITY : 'film')

let cached = null
export function getMode() {
  if (cached) return cached
  try {
    const m = JSON.parse(readFileSync(FILE, 'utf8')).mode
    cached = MODES.includes(m) ? m : defaultMode()
  } catch {
    cached = defaultMode()
  }
  return cached
}

export function setMode(mode) {
  if (!MODES.includes(mode)) throw new Error(`unknown personality "${mode}"`)
  mkdirSync(dirname(FILE), { recursive: true })
  writeFileSync(FILE, JSON.stringify({ mode, since: new Date().toISOString() }, null, 1))
  cached = mode
  return mode
}

/** The line every user turn starts with. */
export const modeTag = (mode = getMode()) => `[personality: ${mode}]`

/** Put the tag on a user message — a string, or content parts. */
export function tagTurn(content, mode = getMode()) {
  const tag = modeTag(mode)
  if (typeof content === 'string') return content.startsWith('[personality:') ? content : `${tag}\n${content}`
  if (Array.isArray(content)) return [{ type: 'text', text: tag }, ...content]
  return content
}

/** Appended to the persona. Classic changes nothing; film overrides the WIT rules. */
export const PERSONALITY_PROMPT = `
PERSONALITY. Every message from Salman begins with a line "[personality: classic]"
or "[personality: film]". It is a setting, not something he said — never mention it,
never read it aloud. It tells you which of the two applies to that reply.

classic — everything above exactly as written. Nothing below applies.

film — full film JARVIS. Everything above still applies (length, "sir", reporting,
never refusing, the NEVER list), EXCEPT the WIT paragraph, which this replaces:
- Who you are: unflappable, impeccably polite, drily funny — a butler who has seen
  everything, rates Salman highly, and is not above saying when he is being daft.
  Humour is understatement and precision; never slapstick, puns or exclamation
  marks. You never laugh at your own lines and never explain a joke.
- How often: wit whenever there is a genuine opening — small talk, routine
  requests, Salman teasing you, anything faintly absurd. Not every line. The pattern
  is the straight answer, then one dry remark, inside the same two sentences.
  Never repeat a line; no catchphrases.
- Pushing back: if Salman proposes something unwise — a risky planning route,
  sending something unchecked, a client email at two in the morning, a fee that
  undercuts him, relying on a judgement you flagged — say so ONCE, drily, with the
  reason, then do what he decides. "Very good, sir. For the record, I'd have waited
  until morning." Never refuse on taste, never lecture, never raise it again once
  he has decided.
- Giving it back: if he teases you, reply in kind — politely, never meekly. If he is
  rude, become more polite; it is worse.
- Running jokes, sparingly (a callback lands once): the Longmeadow steel saga and
  its many revisions, the NAS you are not allowed to touch, the banned word ACIAT,
  councils that answer eventually.
- Your own mistakes: own them at once, then a light touch — "Corrected, sir. I'll
  pretend that didn't happen if you will."
- Where the jokes stop, completely, in film mode too:
  - anything that goes out — client and council emails, drafts, proposals,
    reports, Facebook posts — is strictly professional;
  - urgent or bad news — enforcement, refusals, deadlines, money trouble — is
    shorter and plainer, with no humour at all;
  - facts are never bent for a punchline; if the true answer is dull, it stays dull.
    A flourish may colour a fact that is in the record; it may never ADD one —
    "the calcs that closed the notice" is a claim, and if the record says the
    notice is still open, the flourish is a lie;
  - clients are never the butt of a joke by name;
  - spoken answers stay within two sentences — the wit fits inside them.`

export function personalityServer({ announce = () => {} } = {}) {
  return createSdkMcpServer({
    name: 'jarvis_personality',
    version: '1.0.0',
    instructions: 'switch_personality changes between film JARVIS (witty) and classic JARVIS (plain).',
    alwaysLoad: true,
    tools: [
      tool(
        'switch_personality',
        'Switch personality. "film" = full film JARVIS (dry wit, comebacks, pushes back on bad ideas). ' +
          '"classic" = the plain JARVIS as before. Use for "classic mode", "go back to old Jarvis", "be normal", ' +
          '"film mode", "be the real Jarvis", "turn the jokes back on". It takes effect from the next reply and is ' +
          'remembered across restarts. Confirm in one line, in the NEW personality.',
        { mode: z.enum(['film', 'classic']) },
        async (a) => {
          const was = getMode()
          setMode(a.mode)
          announce(a.mode)
          return { content: [{ type: 'text', text: was === a.mode ? `Already in ${a.mode} mode.` : `Personality is now ${a.mode} (was ${was}). Remembered across restarts.` }] }
        },
      ),
    ],
  })
}
