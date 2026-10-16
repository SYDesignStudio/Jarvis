import { memo, useEffect, useRef, useState } from 'react'
import { BRIDGE_HTTP_URL } from '../config'
import { askFromApp } from '../lib/appbus'
import { useStore } from '../store'

/**
 * One app JARVIS built, running in its blade.
 *
 * The iframe is sandboxed with an opaque origin and the document is served
 * under a CSP that forbids connections, so the app cannot reach the agent
 * socket or the internet. What it may do is ask this component — through
 * postMessage — for live data, its own files, its saved state, to open another
 * app, or to hand JARVIS a request. Each of those is fetched or acted on here,
 * from the face's own origin, and the answer posted back.
 *
 * The blade refreshes itself when JARVIS changes the app (the bridge says so
 * on the socket) and, for a change made from the other machine, by checking
 * the manifest every so often.
 */
type Call = { jarvis: 'call'; id: number; op: string; source?: string; file?: string; value?: unknown; text?: string; slug?: string }

async function serve(slug: string, m: Call): Promise<unknown> {
  const base = `${BRIDGE_HTTP_URL}/apps`
  switch (m.op) {
    case 'data': {
      const r = await fetch(`${base}/data/${encodeURIComponent(String(m.source ?? ''))}`)
      if (!r.ok) throw new Error((await r.json().catch(() => ({})))?.error ?? `no data source "${m.source}"`)
      return r.json()
    }
    case 'file': {
      const name = String(m.file ?? '')
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,60}$/.test(name)) throw new Error('bad file name')
      const r = await fetch(`${base}/${slug}/${encodeURIComponent(name)}`)
      if (!r.ok) throw new Error(`no file "${name}"`)
      const text = await r.text()
      if (/\.json$/i.test(name)) {
        try {
          return JSON.parse(text)
        } catch {
          throw new Error(`${name} is not valid JSON`)
        }
      }
      return text
    }
    case 'state.get': {
      const r = await fetch(`${base}/${slug}/state`)
      return ((await r.json()) as { state: unknown }).state
    }
    case 'state.set': {
      const r = await fetch(`${base}/${slug}/state`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: JSON.stringify(m.value ?? null) })
      if (!r.ok) throw new Error('state not saved')
      return true
    }
    case 'ask': {
      const text = String(m.text ?? '').trim()
      if (!text) throw new Error('nothing to ask')
      if (!askFromApp(text)) throw new Error('JARVIS is not listening right now')
      return true
    }
    case 'open': {
      const target = String(m.slug ?? '')
      if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(target)) throw new Error('bad app slug')
      const r = await fetch(`${base}/${target}/manifest`)
      if (!r.ok) throw new Error(`no app "${target}"`)
      const man = (await r.json()) as { name: string }
      useStore.getState().pushBlade({ id: `app:${target}`, title: man.name.toUpperCase(), kind: 'app', slug: target, size: 'full', hold: 'sticky' })
      return true
    }
    default:
      throw new Error(`unknown call "${m.op}"`)
  }
}

const themeFrame = () => {
  const css = getComputedStyle(document.documentElement)
  return { jarvis: 'theme', interface: css.getPropertyValue('--interface').trim(), bg: css.getPropertyValue('--bg').trim() }
}

export const AppView = memo(function AppView({ slug }: { slug: string }) {
  const frame = useRef<HTMLIFrameElement>(null)
  const [gen, setGen] = useState(0)
  const touched = useStore((s) => s.appUpdates[slug] ?? 0)
  const accent = useStore((s) => s.ui.accent)
  const background = useStore((s) => s.ui.background)

  // JARVIS changed it on this machine: reload.
  useEffect(() => {
    if (touched) setGen((g) => g + 1)
  }, [touched])

  // Changed from the other machine: the manifest's updated stamp moves.
  useEffect(() => {
    let last = ''
    let alive = true
    const check = async () => {
      try {
        const r = await fetch(`${BRIDGE_HTTP_URL}/apps/${slug}/manifest`)
        if (!r.ok) return
        const m = (await r.json()) as { updated?: string }
        if (!alive || !m.updated) return
        if (last && m.updated !== last) setGen((g) => g + 1)
        last = m.updated
      } catch {
        /* the bridge is away; try again next time */
      }
    }
    void check()
    const t = setInterval(check, 20_000)
    return () => {
      alive = false
      clearInterval(t)
    }
  }, [slug])

  // The app's one channel out.
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      const win = frame.current?.contentWindow
      if (!win || e.source !== win) return
      const m = e.data as Call
      if (!m || typeof m !== 'object' || m.jarvis !== 'call' || typeof m.id !== 'number') return
      const reply = (payload: Record<string, unknown>) => win.postMessage({ jarvis: 'reply', id: m.id, ...payload }, '*')
      serve(slug, m)
        .then((result) => reply({ result }))
        .catch((err: unknown) => reply({ error: String((err as Error)?.message ?? err) }))
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [slug])

  // Its colours follow the HUD's.
  useEffect(() => {
    frame.current?.contentWindow?.postMessage(themeFrame(), '*')
  }, [accent, background, gen])

  return (
    <iframe
      key={gen}
      ref={frame}
      className="bl-frame ap-frame"
      // Framed through the face's own origin (the dev server proxies /bridge to
      // the bridge) rather than the bridge's: the same path works at the desk and
      // over Tailscale, and nothing has to allow a second origin in a frame.
      src={`${location.origin}/bridge/apps/${slug}/`}
      // allow-scripts without allow-same-origin: the app runs in an opaque
      // origin and can reach nothing of ours. Links may open a real tab.
      sandbox="allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox"
      referrerPolicy="no-referrer"
      onLoad={() => frame.current?.contentWindow?.postMessage(themeFrame(), '*')}
      title={slug}
    />
  )
})
