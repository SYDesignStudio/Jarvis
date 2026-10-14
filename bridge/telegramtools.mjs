import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { vetAttachments } from './maildraft.mjs'

/**
 * Files to Salman on Telegram — a drawing, a proposal, a report, a site photo —
 * from the desk or from Telegram itself ("send me the BR drawings"). The same
 * folder rules as email attachments: his work folders and the NAS, nothing
 * else, and only the file types a practice sends.
 */
export function telegramFilesServer({ sendFile }) {
  return createSdkMcpServer({
    name: 'jarvis_telegram',
    version: '1.0.0',
    instructions: 'send_file puts a file from this PC or the NAS in Salman\'s Telegram chat.',
    alwaysLoad: true,
    tools: [
      tool(
        'send_file',
        "Send a file to Salman's Telegram — drawings, fee proposals, reports, calcs, site photos, Word/Excel — up to 50 MB. " +
          'path = the full path exactly as a tool gave it (drawing_pack, project files, FEE PROPOSALS, the NAS). ' +
          'Sent as the original file; as_photo shows an image inline instead. For drawings send only the CURRENT revision. ' +
          'Say what you sent.',
        {
          path: z.string().min(3),
          caption: z.string().optional().catch(undefined),
          as_photo: z.boolean().optional().catch(undefined),
        },
        async (a) => {
          const v = await vetAttachments([a.path], undefined, { maxTotal: 50 * 1024 * 1024, limitName: 'Telegram allows 50 MB' })
          if (v.error) return { isError: true, content: [{ type: 'text', text: `Not sent: ${v.error}.` }] }
          const f = v.files[0]
          const r = await sendFile(f.path, a.caption ?? '', { asPhoto: Boolean(a.as_photo) })
          return r.ok
            ? { content: [{ type: 'text', text: `Sent ${f.name} (${(f.size / 1048576).toFixed(1)} MB) to Salman's Telegram.` }] }
            : { isError: true, content: [{ type: 'text', text: `Not sent: ${r.why}. Say so.` }] }
        },
      ),
    ],
  })
}
