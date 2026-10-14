import { memo, useCallback, useEffect, useRef, useState } from 'react'
import { useStore } from '../store'
import { BRIDGE_HTTP_URL } from '../config'

/**
 * The command line: type to JARVIS, hand him files.
 *
 * Voice is the front door and this is the side door — for a reference you
 * would rather paste than say, and for the document that is the whole point
 * of the question. A file dropped anywhere on the page, pasted, or picked
 * with the clip is sent to the bridge, lands in INBOX\Desk, and rides along
 * in the message as a path JARVIS reads with the same tools as any other
 * document. The transcript shows what you typed and the file names, not the
 * instructions that travel with them.
 *
 * It stays out of the way: a hairline with a prompt glyph until it has focus
 * (`/` gives it focus), and the HUD's letter shortcuts are ignored while you
 * are typing in it, because the App's key handler already skips inputs.
 */

type Attached = { file: File; id: string }
type Sent = { name: string; size: number; path: string }

const ACCEPT = '.pdf,.png,.jpg,.jpeg,.webp,.heic,.gif,.docx,.doc,.xlsx,.xls,.csv,.txt,.md,.msg,.eml,.dwg,.dxf,.zip,.rtf'
const fmtSize = (n: number) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`)

/** Must say the same as bridge/upload.mjs attachmentLines — JARVIS reads one or the other. */
function attachmentLines(files: Sent[]): string {
  if (!files.length) return ''
  return [
    '',
    ...files.map((f) => `[Attached: "${f.name}" (${fmtSize(f.size)}) saved at ${f.path}]`),
    'Read every attached file before answering — read_planning_document for PDFs, Read for images and text; never judge one by its name. ' +
      "If it belongs to a job, copy it into that project's documents folder under PROJECTS and note it with project_note (source: \"sent by Salman at the desk\").",
  ].join('\n')
}

async function upload(file: File): Promise<Sent> {
  const r = await fetch(`${BRIDGE_HTTP_URL}/upload?name=${encodeURIComponent(file.name)}`, {
    method: 'POST',
    headers: { 'content-type': file.type || 'application/octet-stream' },
    body: file,
  })
  const data = (await r.json().catch(() => ({}))) as { path?: string; name?: string; size?: number; error?: string }
  if (!r.ok || !data.path) throw new Error(data.error ?? `upload failed (${r.status})`)
  return { name: data.name ?? file.name, size: data.size ?? file.size, path: data.path }
}

export const Console = memo(function Console({ onSubmit }: { onSubmit: (text: string, opts: { display: string }) => Promise<void> }) {
  const phase = useStore((s) => s.phase)
  const [text, text_] = useState('')
  const [files, files_] = useState<Attached[]>([])
  const [busy, busy_] = useState<string | null>(null)
  const [error, error_] = useState<string | null>(null)
  const [focused, focused_] = useState(false)
  const [dragging, dragging_] = useState(false)
  const box = useRef<HTMLTextAreaElement>(null)
  const pick = useRef<HTMLInputElement>(null)
  const dragDepth = useRef(0)

  const add = useCallback((list: FileList | File[] | null) => {
    if (!list) return
    const next = [...list].map((file) => ({ file, id: `${file.name}-${file.size}-${Math.random().toString(36).slice(2, 7)}` }))
    if (next.length) {
      files_((f) => [...f, ...next].slice(0, 10))
      error_(null)
      box.current?.focus()
    }
  }, [])

  // Drop anywhere on the page — the whole window is the target, with a frame
  // that says so while a file is over it.
  useEffect(() => {
    const over = (e: DragEvent) => {
      if (!e.dataTransfer?.types.includes('Files')) return
      e.preventDefault()
    }
    const enter = (e: DragEvent) => {
      if (!e.dataTransfer?.types.includes('Files')) return
      dragDepth.current++
      dragging_(true)
    }
    const leave = () => {
      dragDepth.current = Math.max(0, dragDepth.current - 1)
      if (dragDepth.current === 0) dragging_(false)
    }
    const drop = (e: DragEvent) => {
      if (!e.dataTransfer?.types.includes('Files')) return
      e.preventDefault()
      dragDepth.current = 0
      dragging_(false)
      add(e.dataTransfer.files)
    }
    const key = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName
      if (e.key === '/' && tag !== 'INPUT' && tag !== 'TEXTAREA' && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault()
        box.current?.focus()
      }
    }
    const paste = (e: ClipboardEvent) => {
      const items = [...(e.clipboardData?.files ?? [])]
      if (items.length) {
        e.preventDefault()
        add(items)
      }
    }
    window.addEventListener('dragover', over)
    window.addEventListener('dragenter', enter)
    window.addEventListener('dragleave', leave)
    window.addEventListener('drop', drop)
    window.addEventListener('keydown', key)
    window.addEventListener('paste', paste)
    return () => {
      window.removeEventListener('dragover', over)
      window.removeEventListener('dragenter', enter)
      window.removeEventListener('dragleave', leave)
      window.removeEventListener('drop', drop)
      window.removeEventListener('keydown', key)
      window.removeEventListener('paste', paste)
    }
  }, [add])

  // Grow with the text, up to a few lines; never a scrollbar for one line.
  useEffect(() => {
    const el = box.current
    if (!el) return
    el.style.height = '0px'
    el.style.height = `${Math.min(el.scrollHeight, 5 * 22 + 12)}px`
  }, [text])

  const send = async () => {
    const typed = text.trim()
    if (!typed && !files.length) return
    if (phase === 'offline') {
      error_('Press Initialise first.')
      return
    }
    error_(null)
    const sent: Sent[] = []
    try {
      for (const a of files) {
        busy_(`sending ${a.file.name}…`)
        sent.push(await upload(a.file))
      }
    } catch (err) {
      busy_(null)
      error_(err instanceof Error ? err.message : String(err))
      return
    }
    busy_(null)
    const names = sent.map((f) => f.name).join(', ')
    const display = typed ? (names ? `${typed}  · attached: ${names}` : typed) : `attached: ${names}`
    const message = (typed || 'Here is a file.') + attachmentLines(sent)
    text_('')
    files_([])
    // Hand the keyboard back to the HUD: a line sent is a line done, and the
    // letter shortcuts (S, G, K, D, Space to talk) must work again at once.
    // `/` brings the box back.
    box.current?.blur()
    void onSubmit(message, { display })
  }

  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void send()
    } else if (e.key === 'Escape') {
      box.current?.blur()
    }
  }

  const live = focused || text.length > 0 || files.length > 0 || Boolean(busy)
  return (
    <>
      {dragging && (
        <div className="con-drop" aria-hidden>
          <div className="con-drop-frame">
            <span>DROP FOR JARVIS</span>
            <small>PDF · images · Word · Excel · CAD</small>
          </div>
        </div>
      )}
      <form
        className={`con${live ? ' live' : ''}`}
        onSubmit={(e) => {
          e.preventDefault()
          void send()
        }}
      >
        {files.length > 0 && (
          <div className="con-chips">
            {files.map((a) => (
              <span key={a.id} className="con-chip" title={a.file.name}>
                {a.file.name.length > 34 ? `${a.file.name.slice(0, 31)}…` : a.file.name}
                <i>{fmtSize(a.file.size)}</i>
                <button type="button" aria-label={`Remove ${a.file.name}`} onClick={() => files_((f) => f.filter((x) => x.id !== a.id))}>
                  ×
                </button>
              </span>
            ))}
          </div>
        )}
        <div className="con-row">
          <span className="con-prompt" aria-hidden>
            ›
          </span>
          <textarea
            ref={box}
            className="con-input"
            rows={1}
            value={text}
            placeholder={live ? 'Type to JARVIS — Enter to send, Shift+Enter for a new line' : 'type to jarvis · / to focus · drop a PDF anywhere'}
            onChange={(e) => text_(e.target.value)}
            onKeyDown={onKey}
            onFocus={() => focused_(true)}
            onBlur={() => focused_(false)}
            spellCheck={false}
          />
          <button type="button" className="con-clip" title="Past chats (H)" aria-label="Past chats" onClick={() => {
            const s = useStore.getState()
            if (s.blades.some((b) => b.kind === 'chats')) s.closeBlade('chats')
            else s.pushBlade({ id: 'chats', title: 'CHATS', kind: 'chats', size: 'full', hold: 'sticky' })
          }}>
            ◷
          </button>
          <button type="button" className="con-clip" title="Attach a file" aria-label="Attach a file" onClick={() => pick.current?.click()}>
            ⊕
          </button>
          <input
            ref={pick}
            type="file"
            multiple
            accept={ACCEPT}
            hidden
            onChange={(e) => {
              add(e.target.files)
              e.target.value = ''
            }}
          />
          <button type="submit" className="con-send" disabled={Boolean(busy) || (!text.trim() && !files.length)}>
            {busy ? 'SENDING' : 'SEND'}
          </button>
        </div>
        {(busy || error) && <div className={`con-status${error ? ' err' : ''}`}>{error ?? busy}</div>}
      </form>
    </>
  )
})
