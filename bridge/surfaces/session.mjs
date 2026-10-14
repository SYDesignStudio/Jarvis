import { query } from '@anthropic-ai/claude-agent-sdk'
import { NAS_GUARD_HOOKS } from '../guard.mjs'
import { tagTurn } from '../personality.mjs'

/**
 * One brain, any surface.
 *
 * The desk page has its own, more elaborate wiring in server.mjs — HUD badges,
 * camera requests, held tool announcements. Telegram and the phone need less:
 * a conversation that takes one message at a time, streams the words back,
 * says which tools ran, and can be cut off. This is that, over the same SDK,
 * the same system prompt, the same working directory, settings and memory.
 *
 * `canUse(name)` decides tools. It is consulted per call, so a surface can
 * change its mind mid-conversation — which is exactly what saying the PIN on a
 * phone call does.
 */
export function createAgentSession({
  label,
  mcpServers = {},
  systemPrompt,
  model,
  effort,
  cwd,
  settingSources,
  tools,
  canUse,
  maxTurns = 40,
  /** A spending cap for the whole session, for background learners. */
  maxBudgetUsd = null,
  /** Told the SDK session id once it starts, so the chat history knows where it happened. */
  onSession = null,
}) {
  let deliver = null
  let closed = false
  const inbox = []

  async function* userMessages() {
    while (!closed) {
      const text =
        inbox.shift() ??
        (await new Promise((resolve) => {
          deliver = resolve
        }))
      if (closed || text == null) return
      yield { type: 'user', message: { role: 'user', content: tagTurn(text) }, parent_tool_use_id: null }
    }
  }

  const options = {
    mcpServers,
    systemPrompt,
    cwd,
    settingSources,
    model,
    effort,
    maxTurns,
    ...(maxBudgetUsd ? { maxBudgetUsd } : {}),
    permissionMode: 'default',
    includePartialMessages: true,
    hooks: NAS_GUARD_HOOKS,
    canUseTool: async (name) => {
      const ok = canUse(name)
      console.log(`[jarvis:${label}] tool ${name} -> ${ok ? 'allow' : 'deny'}`)
      return ok
        ? { behavior: 'allow' }
        : {
            behavior: 'deny',
            message:
              'Blocked: this action is not permitted on this channel right now. ' +
              'Tell the user plainly that it needs their code, or the desk.',
          }
    },
  }
  if (tools) options.tools = tools

  const session = query({ prompt: userMessages(), options })

  /** The turn in flight, if any. */
  let turn = null
  let lastModel = null

  ;(async () => {
    try {
      for await (const msg of session) {
        switch (msg.type) {
          case 'stream_event': {
            const ev = msg.event
            if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && ev.delta.text) {
              turn?.onText(ev.delta.text)
              if (turn) turn.text += ev.delta.text
            }
            if (ev?.type === 'content_block_start' && ev.content_block?.type === 'tool_use') {
              turn?.onTool(ev.content_block.name)
            }
            break
          }
          case 'system':
            if (msg.subtype === 'init' && msg.session_id) onSession?.(msg.session_id)
            break
          case 'assistant':
            if (msg.message?.model) lastModel = msg.message.model
            break
          case 'result': {
            const t = turn
            turn = null
            if (!t) break
            // A turn cut short by its turn or budget cap still did its work (a
            // learner's outcomes are already recorded), so it resolves, marked.
            if (msg.subtype === 'success' || /^error_max_(turns|budget)/.test(msg.subtype ?? '')) {
              t.resolve({ text: (t.text || msg.result || '').trim(), model: lastModel, costUsd: msg.total_cost_usd ?? null, ...(msg.subtype === 'success' ? {} : { ended: msg.subtype }) })
            } else t.reject(new Error(`the turn ended: ${msg.subtype}`))
            break
          }
        }
      }
    } catch (err) {
      console.error(`[jarvis:${label}] session error:`, err)
      turn?.reject(err instanceof Error ? err : new Error(String(err)))
      turn = null
      closed = true
    }
  })()

  return {
    /** One message in, the whole answer out. Streams via the handlers meanwhile. */
    ask(text, { onText = () => {}, onTool = () => {} } = {}) {
      if (closed) return Promise.reject(new Error('the session is closed'))
      if (turn) return Promise.reject(new Error('a turn is already in flight'))
      return new Promise((resolve, reject) => {
        turn = { text: '', onText, onTool, resolve, reject }
        if (deliver) {
          const d = deliver
          deliver = null
          d(text)
        } else {
          inbox.push(text)
        }
      })
    },
    async interrupt() {
      const t = turn
      try {
        await session.interrupt?.()
      } catch {
        /* nothing to stop */
      }
      if (t && turn === t) {
        turn = null
        t.resolve({ text: t.text.trim(), model: lastModel, interrupted: true })
      }
    },
    setModel: (id) => session.setModel(id),
    get busy() {
      return Boolean(turn)
    },
    get closed() {
      return closed
    },
    close() {
      closed = true
      deliver?.(null)
      session.close?.()
    },
  }
}
