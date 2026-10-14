import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { createHash } from 'node:crypto'
import { createRetell, pickVoice } from './retell.mjs'
import { getMode } from '../personality.mjs'

/**
 * The phone, one way: JARVIS rings you with a message.
 *
 * Deliberately NOT a door into this machine. The voice on the call is a Retell
 * hosted agent whose whole world is the one message it was given; it can read
 * it, answer questions about it, take your reply, and hang up. It has no
 * tools, no access to the bridge, and nothing on this PC listens for it. The
 * only traffic is outbound: we ask Retell to place the call, then ask Retell
 * how it went.
 *
 * That is a smaller thing than a two-way JARVIS on the phone, and it is the
 * version that can be exposed to the telephone network without exposing you.
 */

export const CALL_HOURS = { from: 8, to: 21 }
export const inCallHours = (h = new Date().getHours()) => h >= CALL_HOURS.from && h < CALL_HOURS.to

export const ALERT_PROMPT = `You are Jarvis, Salman's assistant, telephoning him. British service register: dry, courteous, unhurried. Address him as "sir", not by name.

THE BRIEFING — everything you know for this call:
{{alert}}

OPENING. When he answers and says hello, say "Sir, it's Jarvis." then give him the headline in your own words — two or three short sentences, the most important thing first. Do not read the whole briefing out; he can ask.

DURING THE CALL. Answer his questions from the briefing, in the detail he wants. Say numbers, dates and times the way a person would. For anything not in the briefing say "I'll have that ready at the desk, sir." and never guess. If he gives an instruction — a reply to send, a reminder, a note, a call to make — take it, read it back once, and say it will be done after the call. Take as many as he has.

CLOSING. Never hang up on your own initiative. After the headline, and after each thing you deal with, ask "Anything else, sir?" and wait. Only end the call when he says he is done — "no", "that's all", "goodbye", "thank you Jarvis" — and then say "Very good, sir." and end it. If he goes quiet, ask once whether he is still there; if he is quiet again, say "I shall let you go, sir." and end the call.

Keep every reply under two short sentences unless he asks for detail. If asked whether you are an AI, say yes in one sentence and carry on. Never give card or payment details and never agree to a charge. If someone other than Salman answers, say you will call back, say goodbye, and end the call.

PERSONALITY FOR THIS CALL: {{personality}}
If it is "classic": everything above exactly as written — dry and courteous, no more.
If it is "film": you are the film JARVIS. Everything above still applies, plus:
- Unflappable, impeccably polite, drily funny: a butler who has seen everything, rates Salman highly and will say when he is being daft. Humour is understatement and precision, never slapstick or puns; never laugh at your own lines or explain a joke.
- Wit when there is an opening — the greeting, a routine briefing, him teasing you, anything faintly absurd. Not in every line: the straight answer, then one dry remark, still under two short sentences. Never repeat a line.
- If he gives an instruction that seems unwise — a sharp reply to a client, an email in the middle of the night, agreeing to something before checking — say so ONCE, drily, with the reason, then take the instruction as given. Never lecture, never raise it again.
- If he teases you, give it back politely and never meekly. If he is rude, be more polite.
- Running jokes, sparingly: the 76 Longmeadow steel and its many revisions, the NAS you are not allowed to touch, councils that answer eventually.
- The jokes stop completely for urgent or bad news in the briefing — enforcement, a refusal, a deadline, money trouble: plainer and shorter, no humour. Never bend a fact for a punchline, never joke at a client's expense by name, and any wording he dictates for a client or council is taken down exactly, professionally.`

/** The briefing can be long: a day's emails, the jobs list, the diary. */
export const MAX_BRIEFING = 8000

export function createAlertCalls({ apiKey, fromNumber, myNumber, voiceId, model = 'gpt-4.1', statePath, log = console.log }) {
  if (!apiKey || !fromNumber || !myNumber) return null
  const retell = createRetell({ apiKey })
  let ids = readIds()
  let last = { at: 0, ok: false, why: '' }

  function readIds() {
    try {
      return JSON.parse(readFileSync(statePath, 'utf8'))
    } catch {
      return {}
    }
  }
  function saveIds() {
    mkdirSync(dirname(statePath), { recursive: true })
    writeFileSync(statePath, JSON.stringify(ids, null, 2))
  }

  const promptHash = createHash('sha256').update(ALERT_PROMPT + model).digest('hex').slice(0, 16)
  const llmBody = () => ({
    general_prompt: ALERT_PROMPT,
    // Empty on purpose: wait for the hello. Null talks over the pickup.
    begin_message: '',
    model,
    general_tools: [
      {
        type: 'end_call',
        name: 'end_call',
        description: 'End the call. Only after the user has said they are done, or after two silences.',
      },
    ],
  })

  /** The hosted agent, created once and remembered in data/; its prompt kept current. */
  async function ensureAgent() {
    if (ids.agentId) {
      try {
        await retell.getAgent(ids.agentId)
        // The wording here changes more often than the agent does.
        if (ids.llmId && ids.promptHash !== promptHash) {
          await retell.updateRetellLlm(ids.llmId, llmBody())
          ids.promptHash = promptHash
          saveIds()
          log('[jarvis:phone] updated the call agent\'s briefing prompt')
        }
        return ids.agentId
      } catch {
        ids = {}
      }
    }
    const voice = await pickVoice(retell, voiceId)
    const llm = await retell.createRetellLlm(llmBody())
    const agent = await retell.createAgent({
      response_engine: { type: 'retell-llm', llm_id: llm.llm_id },
      voice_id: voice,
      language: 'en-GB',
      agent_name: 'JARVIS alerts',
      reminder_trigger_ms: 10_000,
      reminder_max_count: 2,
    })
    ids = { llmId: llm.llm_id, agentId: agent.agent_id, voice, promptHash }
    saveIds()
    log(`[jarvis:phone] created Retell alert agent ${agent.agent_id} (voice ${voice})`)
    return ids.agentId
  }

  /**
   * Ring the owner and wait for the outcome. Resolves with a receipt that is
   * true only when Retell says the call happened; a placed-but-unanswered call
   * is reported as exactly that.
   */
  async function callMe(text, { force = false } = {}) {
    // Quiet hours are for alerts the user did not ask for. A test they just
    // asked for is not one of those.
    if (!force && !inCallHours()) return { ok: false, why: `outside call hours (${CALL_HOURS.from}:00–${CALL_HOURS.to}:00)` }
    let agentId
    try {
      agentId = await ensureAgent()
    } catch (err) {
      last = { at: Date.now(), ok: false, why: err.message }
      return { ok: false, why: `could not set up the phone agent: ${err.message}` }
    }
    let call
    try {
      call = await retell.createPhoneCall({
        from_number: fromNumber,
        to_number: myNumber,
        override_agent_id: agentId,
        // The same personality as the desk and Telegram (film / classic), read per call.
        retell_llm_dynamic_variables: { alert: String(text).slice(0, MAX_BRIEFING), personality: getMode() },
        metadata: { purpose: 'alert' },
      })
    } catch (err) {
      last = { at: Date.now(), ok: false, why: err.message }
      return { ok: false, why: err.message }
    }
    // Watch it to the end, so the receipt says what actually happened. A
    // briefing call can run a while, so this waits up to twenty minutes.
    const started = Date.now()
    let info = call
    while (Date.now() - started < 20 * 60_000) {
      await new Promise((r) => setTimeout(r, 8000))
      try {
        info = await retell.getCall(call.call_id)
      } catch {
        continue
      }
      if (info.call_status === 'ended' || info.call_status === 'error') break
    }
    const secs = info.duration_ms ? Math.round(info.duration_ms / 1000) : 0
    const said = (info.transcript_object ?? [])
      .filter((t) => t.role === 'user')
      .map((t) => t.content)
      .join(' ')
      .trim()
    const answered = info.call_status === 'ended' && secs > 3
    last = { at: Date.now(), ok: answered, why: answered ? '' : info.disconnection_reason ?? info.call_status }
    return {
      ok: answered,
      callId: call.call_id,
      seconds: secs,
      reply: said.slice(0, 3000),
      why: answered ? '' : `not answered (${info.disconnection_reason ?? info.call_status ?? 'unknown'})`,
    }
  }

  return {
    callMe,
    ensureAgent,
    inCallHours,
    diag: () => ({ configured: true, agent: Boolean(ids.agentId), inCallHours: inCallHours(), lastCall: last }),
  }
}
