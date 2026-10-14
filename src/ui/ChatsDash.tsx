import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { BRIDGE_HTTP_URL } from '../config'
import { switchChat } from '../lib/bridge'
import { useStore, type Turn } from '../store'

/**
 * Past chats — every conversation with JARVIS, to read back and carry on.
 *
 * Built like the sidebar he knows from Claude: a list down the left, newest
 * first and sorted into days, each tagged with the job it was about; the
 * conversation on the right, with what JARVIS used to answer (a PDF read, a
 * register search) shown under each reply. "Carry on this chat" puts him back
 * in it with its whole context. Nothing is deleted from here — archiving only
 * hides a chat, because the transcripts are also JARVIS's memory.
 */

type Project = { job: string; label: string } | null
type Tool = { name: string; label: string; detail: string }
type ChatRow = { id: string; title: string; surface: string; started: string; updated: string; turns: number; preview: string; project: Project; hidden: boolean }
type Message = { role: 'you' | 'jarvis' | 'auto'; at: string; text: string; tools?: Tool[]; after?: 'you' | 'auto' }
type Chat = ChatRow & { messages: Message[] }

const DAY = 86400_000
const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
function bucket(iso: string): string {
  if (!iso) return 'Earlier'
  const t = new Date(iso).getTime()
  const today = startOfDay(new Date())
  if (t >= today) return 'Today'
  if (t >= today - DAY) return 'Yesterday'
  if (t >= today - 6 * DAY) return 'This week'
  if (t >= today - 30 * DAY) return 'This month'
  return 'Earlier'
}
const when = (iso: string) => {
  if (!iso) return ''
  const d = new Date(iso)
  return startOfDay(d) === startOfDay(new Date())
    ? d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
}
const full = (iso: string) => (iso ? new Date(iso).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '')

/** "Drafted email" ten times is one chip saying ×10, with the ten in its tooltip. */
function grouped(tools: Tool[]): { label: string; n: number; details: string[] }[] {
  const out: { label: string; n: number; details: string[] }[] = []
  for (const t of tools) {
    const g = out.find((x) => x.label === t.label)
    if (g) {
      g.n++
      if (t.detail) g.details.push(t.detail)
    } else out.push({ label: t.label, n: 1, details: t.detail ? [t.detail] : [] })
  }
  return out
}

/** What a bridge-run turn was, in a few words, for its collapsed line. */
const autoLabel = (text: string) =>
  /NEW ENQUIRY/i.test(text) ? 'A new enquiry arrived' :
  /council email/i.test(text) ? 'A council email arrived' :
  /attachments has arrived/i.test(text) ? 'An email with documents arrived' :
  /phone call to process/i.test(text) ? 'A phone call to process' :
  /learner/i.test(text) ? 'Background learning' :
  'Automatic work'

export const ChatsDash = memo(function ChatsDash() {
  const current = useStore((s) => s.chatId)
  const [rows, setRows] = useState<ChatRow[] | null>(null)
  const [err, setErr] = useState('')
  const [q, setQ] = useState('')
  const [project, setProject] = useState('')
  const [openId, setOpenId] = useState<string | null>(null)
  const [chat, setChat] = useState<Chat | null>(null)
  const [busy, setBusy] = useState('')
  const alive = useRef(true)

  const load = useCallback(async (query = '') => {
    try {
      const r = await fetch(`${BRIDGE_HTTP_URL}/chats${query ? `?q=${encodeURIComponent(query)}` : ''}`)
      const data = await r.json()
      if (!alive.current) return
      if (!r.ok) throw new Error(data?.error ?? `the bridge answered ${r.status}`)
      setRows(data.chats)
      setErr('')
    } catch (e) {
      if (alive.current) setErr(e instanceof Error ? e.message : String(e))
    }
  }, [])

  useEffect(() => {
    alive.current = true
    void load()
    return () => {
      alive.current = false
    }
  }, [load])

  // Search as he types, a beat after he stops.
  useEffect(() => {
    const t = window.setTimeout(() => void load(q.trim()), 250)
    return () => window.clearTimeout(t)
  }, [q, load])

  // Open the chat he is in, or the newest, once the list arrives.
  useEffect(() => {
    if (openId || !rows?.length) return
    setOpenId(rows.find((r) => r.id === current)?.id ?? rows[0].id)
  }, [rows, current, openId])

  useEffect(() => {
    if (!openId) return
    let gone = false
    setChat(null)
    void fetch(`${BRIDGE_HTTP_URL}/chats/${openId}`)
      .then((r) => r.json())
      .then((data) => {
        if (!gone && data?.messages) setChat(data)
      })
      .catch(() => {})
    return () => {
      gone = true
    }
  }, [openId])

  const projects = useMemo(() => {
    const count = new Map<string, number>()
    for (const r of rows ?? []) if (r.project) count.set(r.project.label, (count.get(r.project.label) ?? 0) + 1)
    // The jobs he has talked about most; one-off mentions stay findable by search.
    return [...count.entries()].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1]).slice(0, 6)
  }, [rows])

  const shown = useMemo(() => (rows ?? []).filter((r) => !project || r.project?.label === project), [rows, project])
  const groups = useMemo(() => {
    const out: [string, ChatRow[]][] = []
    for (const r of shown) {
      const b = bucket(r.updated)
      const g = out.find(([k]) => k === b)
      if (g) g[1].push(r)
      else out.push([b, [r]])
    }
    return out
  }, [shown])

  const carryOn = async (c: Chat) => {
    setBusy('Opening the chat…')
    try {
      await switchChat(c.id)
      const turns: Turn[] = c.messages
        .filter((m) => m.role !== 'auto' && m.text)
        .slice(-6)
        .map((m, i) => ({ id: `h${i}-${c.id.slice(0, 6)}`, role: m.role === 'you' ? 'user' : 'jarvis', text: m.text }))
      useStore.getState().setTurns(turns)
      setBusy('You are back in this chat — talk or type.')
    } catch (e) {
      setBusy(`Could not open it: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  const newChat = async () => {
    setBusy('Starting a new chat…')
    try {
      await switchChat(null)
      useStore.getState().setTurns([])
      setOpenId(null)
      setChat(null)
      setBusy('New chat — talk or type.')
    } catch (e) {
      setBusy(`Could not start one: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  const patch = async (id: string, body: Record<string, unknown>) => {
    await fetch(`${BRIDGE_HTTP_URL}/chats/${id}`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: JSON.stringify(body) }).catch(() => {})
    await load(q.trim())
  }

  return (
    <div className="ch">
      <aside className="ch-side">
        <div className="ch-top">
          <h2>Chats</h2>
          <button className="ch-btn ch-primary" onClick={() => void newChat()}>New chat</button>
        </div>
        <input className="ch-find" type="search" placeholder="Search everything said" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search chats" />
        {projects.length ? (
          <div className="ch-projects" role="group" aria-label="Filter by project">
            <button className={`ch-proj${!project ? ' on' : ''}`} onClick={() => setProject('')}>All</button>
            {projects.map(([label, n]) => (
              <button key={label} className={`ch-proj${project === label ? ' on' : ''}`} onClick={() => setProject(project === label ? '' : label)}>
                {label} <i>{n}</i>
              </button>
            ))}
          </div>
        ) : null}
        {err ? <p className="ch-err">The chats cannot be read: {err}</p> : null}
        {!rows ? <p className="ch-quiet">Reading your chats…</p> : null}
        {rows && !shown.length ? <p className="ch-quiet">{q ? `Nothing said matches "${q}".` : 'No chats yet.'}</p> : null}
        <nav className="ch-list">
          {groups.map(([label, list]) => (
            <section key={label}>
              <h3>{label}</h3>
              {list.map((r) => (
                <button key={r.id} className={`ch-item${openId === r.id ? ' open' : ''}`} onClick={() => setOpenId(r.id)} aria-current={openId === r.id}>
                  <span className="ch-title">
                    {r.id === current ? <em>Now</em> : null}
                    {r.title}
                  </span>
                  <span className="ch-meta">
                    {r.project ? <b>{r.project.label}</b> : null}
                    {r.surface === 'telegram' ? <span>Telegram</span> : null}
                    <span>{when(r.updated)}</span>
                  </span>
                </button>
              ))}
            </section>
          ))}
        </nav>
      </aside>

      <main className="ch-main">
        {chat ? (
          <Conversation key={chat.id} chat={chat} isCurrent={chat.id === current} onCarry={() => void carryOn(chat)} onPatch={(b) => void patch(chat.id, b).then(() => setChat({ ...chat, ...('title' in b ? { title: String(b.title) } : {}) }))} busy={busy} />
        ) : (
          <div className="ch-empty">{openId ? 'Opening…' : busy || 'Pick a chat on the left, or start a new one.'}</div>
        )}
      </main>
    </div>
  )
})

function Conversation({ chat, isCurrent, onCarry, onPatch, busy }: { chat: Chat; isCurrent: boolean; onCarry: () => void; onPatch: (b: Record<string, unknown>) => void; busy: string }) {
  const [renaming, setRenaming] = useState(false)
  const [title, setTitle] = useState(chat.title)
  const [openAuto, setOpenAuto] = useState<Set<number>>(new Set())
  const end = useRef<HTMLDivElement>(null)
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' })
  }, [chat.id])

  return (
    <>
      <header className="ch-head">
        {renaming ? (
          <form onSubmit={(e) => { e.preventDefault(); setRenaming(false); if (title.trim()) onPatch({ title: title.trim() }) }}>
            <input className="ch-rename" value={title} onChange={(e) => setTitle(e.target.value)} autoFocus onBlur={() => setRenaming(false)} aria-label="Chat title" />
          </form>
        ) : (
          <h2 title="Rename" onClick={() => setRenaming(true)}>{chat.title}</h2>
        )}
        <p>
          {chat.project ? <b>{chat.project.label}</b> : null}
          {full(chat.started)} · {chat.turns} message{chat.turns === 1 ? '' : 's'} from you{chat.surface ? ` · ${chat.surface === 'telegram' ? 'on Telegram' : 'at the desk'}` : ''}
        </p>
        <div className="ch-acts">
          {isCurrent ? <span className="ch-now">You are in this chat</span> : <button className="ch-btn ch-primary" onClick={onCarry}>Carry on this chat</button>}
          <button className="ch-btn" onClick={() => setRenaming(true)}>Rename</button>
          <button className="ch-btn" onClick={() => onPatch({ hidden: !chat.hidden })}>{chat.hidden ? 'Unarchive' : 'Archive'}</button>
        </div>
        {busy ? <p className="ch-busy" role="status">{busy}</p> : null}
      </header>

      <div className="ch-log">
        {chat.messages.map((m, i) =>
          m.role === 'auto' ? (
            <div key={i} className="ch-auto">
              <button onClick={() => setOpenAuto((s) => { const n = new Set(s); if (n.has(i)) n.delete(i); else n.add(i); return n })} aria-expanded={openAuto.has(i)}>
                {openAuto.has(i) ? '−' : '+'} {autoLabel(m.text)} <time>{when(m.at)}</time>
              </button>
              {openAuto.has(i) ? <pre>{m.text.slice(0, 4000)}</pre> : null}
            </div>
          ) : m.role === 'you' ? (
            <div key={i} className="ch-you">
              <p>{m.text}</p>
              <time>{when(m.at)}</time>
            </div>
          ) : (
            <div key={i} className={`ch-jarvis${m.after === 'auto' ? ' ch-after-auto' : ''}`}>
              {m.tools?.length ? (
                <ul className="ch-tools" aria-label="What JARVIS used">
                  {grouped(m.tools).slice(0, 10).map((g, k) => (
                    <li key={k} title={g.details.join(' · ') || g.label}>
                      {g.label}
                      {g.n > 1 ? <span> ×{g.n}</span> : g.details[0] ? <span> · {g.details[0]}</span> : null}
                    </li>
                  ))}
                </ul>
              ) : null}
              {m.text ? m.text.split(/\n{2,}/).map((p, k) => <p key={k}>{p}</p>) : null}
            </div>
          ),
        )}
        <div ref={end} />
      </div>
    </>
  )
}
