import { memo, useCallback, useEffect, useState } from 'react'
import { BRIDGE_HTTP_URL } from '../config'
import { useStore } from '../store'

/**
 * The apps JARVIS has built — a shelf to open them from.
 *
 * Building and changing them is JARVIS's job, by voice or text; this panel
 * only opens and removes. A removed app goes to the apps folder's _trash, so
 * a slip is not a loss.
 */
type AppRow = { slug: string; name: string; description: string; updated: string; version: number }

const when = (iso: string) => {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const today = new Date()
  const sameDay = d.toDateString() === today.toDateString()
  return sameDay ? d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
}

export const AppsDash = memo(function AppsDash() {
  const [apps, setApps] = useState<AppRow[] | null>(null)
  const [error, setError] = useState('')
  const [confirm, setConfirm] = useState<string | null>(null)
  const touched = useStore((s) => s.appUpdates)

  const load = useCallback(async () => {
    try {
      const r = await fetch(`${BRIDGE_HTTP_URL}/apps`)
      if (!r.ok) throw new Error(`the bridge answered ${r.status}`)
      setApps(((await r.json()) as { apps: AppRow[] }).apps)
      setError('')
    } catch (err) {
      setError(`Could not read the apps: ${(err as Error).message}`)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load, touched])

  const open = (a: AppRow) => useStore.getState().pushBlade({ id: `app:${a.slug}`, title: a.name.toUpperCase(), kind: 'app', slug: a.slug, size: 'full', hold: 'sticky' })

  const remove = async (slug: string) => {
    setConfirm(null)
    try {
      await fetch(`${BRIDGE_HTTP_URL}/apps/${slug}/delete`, { method: 'POST' })
      useStore.getState().closeBlade(`app:${slug}`)
    } finally {
      void load()
    }
  }

  return (
    <div className="ap-root">
      <header className="ap-head">
        <h2 className="ap-title">Apps</h2>
        <p className="ap-sub">Built by JARVIS, kept here. Ask for a new one: “build me a dashboard of my live applications”.</p>
      </header>
      {error && <p className="ap-error">{error}</p>}
      {apps && !apps.length && !error && (
        <p className="ap-none">
          Nothing built yet. Say what you want on screen — a fees dashboard, a chase list, a site-visit checklist — and JARVIS will make it and put it here.
        </p>
      )}
      <ul className="ap-list">
        {(apps ?? []).map((a) => (
          <li key={a.slug} className="ap-item">
            <button type="button" className="ap-open" onClick={() => open(a)} title="Open">
              <span className="ap-name">{a.name}</span>
              <span className="ap-desc">{a.description || 'No description'}</span>
              <span className="ap-meta">
                v{a.version} · {when(a.updated)}
              </span>
            </button>
            {confirm === a.slug ? (
              <span className="ap-confirm">
                <span>Remove?</span>
                <button type="button" className="ap-mini danger" onClick={() => void remove(a.slug)}>
                  Yes
                </button>
                <button type="button" className="ap-mini" onClick={() => setConfirm(null)}>
                  No
                </button>
              </span>
            ) : (
              <button type="button" className="ap-mini" onClick={() => setConfirm(a.slug)} title="Remove this app">
                Remove
              </button>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
})
