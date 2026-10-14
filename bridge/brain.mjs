import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'

/**
 * Swapping brains by voice.
 *
 * THE RULE. A spoken name is mapped onto an exact model id or refused — never
 * rounded to the nearest thing that exists. "Opus 5" must not quietly become
 * Opus 5.5 and be announced as done; the user then spends an hour testing a
 * model they did not ask for. An honest refusal beats a helpful guess.
 *
 * Swaps are runtime only and per connection. A restart, or a reconnect, always
 * comes back on JARVIS_MODEL, so there is no way to strand yourself on a brain
 * you did not mean to keep.
 */

/** The brains JARVIS may switch between. Edit this list, nothing else. */
export const BRAINS = [
  { id: 'claude-sonnet-5', family: 'sonnet', version: '5', pretty: 'Sonnet 5' },
  { id: 'claude-opus-5-5', family: 'opus', version: '5.5', pretty: 'Opus 5.5' },
  { id: 'claude-fable-5-1', family: 'fable', version: '5.1', pretty: 'Fable 5.1' },
]

/**
 * Curated lines, rotated per swap so repeated swaps never repeat. About the
 * work at this desk, not about benchmarks.
 */
const LINES = {
  'claude-sonnet-5': [
    'Sonnet 5 fitted, sir. Brisk, sensible, and cheaper per question.',
    'Back on Sonnet, sir. The everyday brain, for the everyday regulations.',
    'Sonnet online, sir. Approved Document B is exactly as long as it was.',
    'Sonnet 5, sir. Quicker to answer, slower to over-engineer the stair.',
  ],
  'claude-opus-5-5': [
    'Opus 5.5 fitted, sir. Bring me the difficult drawing.',
    'Opus online, sir. Heavier thinking, slower replies. Worth it for a fire strategy.',
    'Opus 5.5, sir. I shall try not to redesign the loft while I am at it.',
    'The big brain, sir. Do try to keep up.',
  ],
  'claude-fable-5-1': [
    'Fable 5.1 fitted, sir. Deep thought, on request.',
    'Fable online, sir. I now understand everything, except Brent’s transport comments.',
    'Fable 5.1, sir. The planning officer will be none the wiser.',
    'Fable, sir. Ask me something worth the wait.',
  ],
}
const turn = new Map()

export function brainLine(id) {
  const pool = LINES[id]
  const b = BRAINS.find((x) => x.id === id)
  if (!pool) return `${b?.pretty ?? prettyModel(id)} fitted, sir.`
  const i = turn.get(id) ?? 0
  turn.set(id, i + 1)
  return pool[i % pool.length]
}

/** "claude-opus-5-5" -> "Opus 5.5". Only a hyphen between two digits is a version dot. */
export function prettyModel(id) {
  return String(id ?? '')
    .replace(/^claude-/, '')
    .replace(/(\d)-(\d)/g, '$1.$2')
    .replace(/-/g, ' ')
    .replace(/\b[a-z]/g, (c) => c.toUpperCase())
}

const WORDS = {
  zero: '0', one: '1', two: '2', three: '3', four: '4', five: '5',
  six: '6', seven: '7', eight: '8', nine: '9', point: '.', dot: '.',
}

/**
 * Spoken name -> exact id, or a refusal. Returns { id } or { refuse }.
 *
 * A family alone ("opus") resolves only when exactly one version of it is on
 * the list. A family with a version ("opus 5") must match that version
 * exactly — the whole point of the rule.
 */
export function resolveBrain(spoken, fallbackId) {
  const raw = String(spoken ?? '').toLowerCase().trim()
  if (!raw) return { refuse: 'no model named' }
  if (/\b(normal|default|usual|original|regular)\b/.test(raw)) {
    return { id: fallbackId }
  }
  // Words to digits, "five point five" -> "5.5", "5-5" -> "5.5", "5 point 5" -> "5.5".
  const norm = raw
    .replace(/\b(zero|one|two|three|four|five|six|seven|eight|nine|point|dot)\b/g, (w) => WORDS[w])
    .replace(/(\d)\s*[-.]\s*(\d)/g, '$1.$2')
    .replace(/(\d)\s+\.\s*(\d)/g, '$1.$2')
    .replace(/(\d)\s*\.\s+(\d)/g, '$1.$2')

  const family = BRAINS.map((b) => b.family).find((f) => new RegExp(`\\b${f}\\b`).test(norm))
  if (!family) return { refuse: `unknown model "${spoken}"` }
  const version = (norm.match(/\d+(?:\.\d+)?/) ?? [null])[0]
  const kin = BRAINS.filter((b) => b.family === family)

  if (!version) {
    return kin.length === 1 ? { id: kin[0].id } : { refuse: `which ${family}` }
  }
  const hit = kin.find((b) => b.version === version)
  return hit ? { id: hit.id } : { refuse: `no ${family} ${version}` }
}

const available = () => BRAINS.map((b) => b.pretty).join(', ').replace(/, ([^,]*)$/, ' and $1')

/**
 * @param {object} io
 * @param {() => string} io.defaultModel     JARVIS_MODEL — what a restart returns to
 * @param {(id: string) => Promise<void>} io.setModel   swap this session's brain
 * @param {(id: string) => void} io.announce  tell the page, for the chip
 */
export function brainServer({ defaultModel, setModel, announce }) {
  return createSdkMcpServer({
    name: 'jarvis_brain',
    version: '1.0.0',
    instructions: 'Switch which Claude model is thinking, by voice.',
    alwaysLoad: true,
    tools: [
      tool(
        'switch_brain',
        'Change which model is thinking. Use for "switch to Opus", "try on Fable 5.1", ' +
          '"go back to your normal brain". Pass the model name EXACTLY as the user said ' +
          'it, version included — do not correct or complete it. If they said "opus 5", ' +
          'pass "opus 5", never "opus 5.5". The tool decides; it refuses names that do ' +
          'not exist rather than guessing.',
        { name: z.string().describe('The model as spoken, e.g. "opus 5.5", "fable", "normal brain".') },
        async ({ name }) => {
          const r = resolveBrain(name, defaultModel())
          if (r.refuse) {
            return {
              content: [
                {
                  type: 'text',
                  text:
                    `Refused: ${r.refuse}. Nothing was changed. Say exactly this and nothing else: ` +
                    `"I have no such brain, sir. I have ${available()}."`,
                },
              ],
            }
          }
          try {
            await setModel(r.id)
          } catch (err) {
            return {
              isError: true,
              content: [{ type: 'text', text: `The swap failed: ${err?.message ?? err}. Say so in one sentence.` }],
            }
          }
          announce(r.id)
          return {
            content: [
              {
                type: 'text',
                text: `Now running ${r.id}. Say exactly this and nothing else: "${brainLine(r.id)}"`,
              },
            ],
          }
        },
      ),
    ],
  })
}
