import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'

/**
 * "Jarvis, call me."
 *
 * Outbound only, and only ever to the owner's own number: the destination is
 * fixed in the environment, not chosen by the model, so this tool cannot be
 * turned into a way of ringing anyone else. The voice on the call is a hosted
 * agent that knows nothing but the message it is given; it reads it, answers
 * questions about it, takes a reply, and hangs up. The reply comes back here.
 */
export function phoneServer({ callMe, configured }) {
  return createSdkMcpServer({
    name: 'jarvis_phone',
    version: '1.0.0',
    instructions:
      'Ring the user on their mobile with one message. Outbound only; the number is fixed. ' +
      'Use when they ask to be called, or to have something read to them by phone.',
    alwaysLoad: true,
    tools: [
      tool(
        'call_me',
        'Telephone the user (their own mobile, fixed) with a BRIEFING. Use for "call me", "ring me", ' +
          '"read that to me by phone". Before calling, gather everything they might ask about on the call — ' +
          'the emails in question with their full text, the jobs list, the diary, the answer to what they asked — ' +
          'and put all of it in `message` as plain prose, up to about 8,000 characters, headline first. The voice ' +
          'on the call knows only this text, answers questions from it, takes instructions, and asks "anything ' +
          'else?" before ending. The call is placed immediately, even outside quiet hours, because they asked. ' +
          'Wait for the result: it says whether they answered and everything they said, which you then act on.',
        { message: z.string() },
        async ({ message }) => {
          if (!configured()) {
            return { isError: true, content: [{ type: 'text', text: 'The phone line is not configured (RETELL_API_KEY, RETELL_FROM_NUMBER, JARVIS_MY_NUMBER). Say so plainly.' }] }
          }
          const r = await callMe(message, { force: true })
          if (!r.ok) {
            return { isError: true, content: [{ type: 'text', text: `The call did not go through: ${r.why}. Tell the user in one sentence.` }] }
          }
          return {
            content: [
              {
                type: 'text',
                text:
                  `Call answered, ${r.seconds} seconds.` +
                  (r.reply ? ` They said on the call: "${r.reply}". Act on that if it was an instruction, and confirm in one line.` : ' Confirm in one line.'),
              },
            ],
          }
        },
      ),
    ],
  })
}
