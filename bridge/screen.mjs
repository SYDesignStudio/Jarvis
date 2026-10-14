import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'

/**
 * Eyes on the user's screen.
 *
 * The share itself can only be started by the user — a browser will not open
 * a screen picker without a click or a key press — so this tool never starts
 * anything. It asks the page for ONE frame of a share that is already live,
 * captured at the moment of asking and never cached from earlier.
 */

const DESCRIPTION = `See the user's screen, as it is right now.

Use for "what do you think of this", "what am I looking at", "read this error",
"check this drawing", "does this spreadsheet add up" — anything about what is on
their monitor rather than in front of the camera. Never use the camera for these.

Returns one frame captured at the moment you call it. If screen sharing is off it
says so: then tell the user to press S (or click SHARE SCREEN) and pick Entire
screen, and do not answer from memory of an earlier frame.

Answer specifically about what is on screen. If the frame is too small or blurry
to judge, say so plainly rather than guessing.`

export function screenServer(ask) {
  return createSdkMcpServer({
    name: 'jarvis_screen',
    version: '1.0.0',
    instructions: "The user's own screen, when they have chosen to share it.",
    alwaysLoad: true,
    tools: [
      tool(
        'look_at_screen',
        DESCRIPTION,
        { reason: z.string().optional().catch(undefined) },
        async (args) => {
          let reply
          try {
            reply = await ask('screen', { reason: String(args.reason ?? '').slice(0, 80) })
          } catch (err) {
            return {
              isError: true,
              content: [{ type: 'text', text: `Could not reach the screen: ${err?.message ?? err}.` }],
            }
          }
          if (reply?.error) {
            return { isError: true, content: [{ type: 'text', text: String(reply.error) }] }
          }
          if (typeof reply?.data !== 'string' || !reply.data) {
            return { isError: true, content: [{ type: 'text', text: 'The screen share returned nothing.' }] }
          }
          const note = reply.surface === 'browser'
            ? ' Note: they shared a single browser tab, not the entire screen, so this only shows that tab.'
            : ''
          return {
            content: [
              { type: 'text', text: `One frame of the user's screen, captured just now.${note}` },
              { type: 'image', data: reply.data, mimeType: reply.mimeType ?? 'image/jpeg' },
            ],
          }
        },
      ),
    ],
  })
}
