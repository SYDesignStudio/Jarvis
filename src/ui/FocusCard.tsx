import { useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { useStore } from '../store'
import { clock, postFocus } from '../lib/focus'

/**
 * The desk card: the reactor, following you onto the desktop.
 *
 * A focus session is spent in other windows, so its face cannot live only in
 * the JARVIS tab. Chrome's Document Picture-in-Picture gives a small window
 * that stays on top of every app, which on Windows is the honest equivalent of
 * a card pinned over the menu bar. The ring depletes as the session runs, holds
 * cyan while you are on target, and turns amber and breathes while you drift.
 *
 * Opening it needs a click or key press, so it rides on the FOCUS action.
 */

export const DESK_CSS = `
@import url('https://fonts.googleapis.com/css2?family=Chakra+Petch:wght@400;600&family=JetBrains+Mono:wght@300;400&display=swap');
:root { color-scheme: dark; }
* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; background: #01060c; }
body {
  font-family: 'Chakra Petch', system-ui, sans-serif;
  color: var(--tint);
  display: grid; place-items: center;
  text-transform: uppercase;
  letter-spacing: 0.16em;
  transition: color 500ms ease;
  --tint: #00e5ff;
}
body[data-mood='adrift'] { --tint: #ffb547; }
body[data-mood='idle'] { --tint: rgba(0, 229, 255, 0.5); }
.card { display: grid; justify-items: center; gap: 10px; padding: 12px 10px; width: 100%; }
.ring { position: relative; width: 150px; height: 150px; }
.ring svg { width: 100%; height: 100%; transform: rotate(-90deg); overflow: visible; }
.ticks line { stroke: var(--tint); stroke-width: 1; opacity: 0.28; }
.track { fill: none; stroke: var(--tint); stroke-width: 2; opacity: 0.12; }
.arc {
  fill: none; stroke: var(--tint); stroke-width: 3; stroke-linecap: butt;
  filter: drop-shadow(0 0 5px var(--tint));
  transition: stroke-dashoffset 900ms linear, stroke 500ms ease;
}
body[data-mood='adrift'] .arc { animation: breathe 2.4s ease-in-out infinite; }
@keyframes breathe { 0%, 100% { opacity: 1 } 50% { opacity: 0.45 } }
.face {
  position: absolute; inset: 0; display: grid; place-content: center; text-align: center; gap: 4px;
}
.time { font-family: 'JetBrains Mono', ui-monospace, monospace; font-weight: 300; font-size: 30px; letter-spacing: 0.04em; }
.state { font-size: 9px; letter-spacing: 0.24em; opacity: 0.75; }
.drifts { font-family: 'JetBrains Mono', ui-monospace, monospace; font-size: 9px; opacity: 0.5; letter-spacing: 0.1em; }
.row { display: flex; gap: 6px; width: 100%; }
button {
  flex: 1; font: 600 9px/1 'Chakra Petch', system-ui, sans-serif; letter-spacing: 0.13em; text-transform: uppercase;
  white-space: nowrap;
  color: var(--tint); background: color-mix(in srgb, var(--tint) 8%, transparent);
  border: 1px solid color-mix(in srgb, var(--tint) 35%, transparent);
  padding: 9px 4px; cursor: pointer;
}
button:hover { background: color-mix(in srgb, var(--tint) 18%, transparent); }
button:focus-visible { outline: 1px solid var(--tint); outline-offset: 2px; }
button.flash { background: var(--tint); color: #01060c; }
@media (prefers-reduced-motion: reduce) {
  .arc { transition: none; }
  body[data-mood='adrift'] .arc { animation: none; }
}
`

const R = 64
const C = 2 * Math.PI * R
const TICKS = Array.from({ length: 60 }, (_, i) => i)

function stateLabel(f: ReturnType<typeof useStore.getState>['focus']): string {
  if (f.paused) return 'Paused'
  if (f.deferred) return 'Go to your work'
  if (f.adrift) return f.excused ? 'Excused' : 'Adrift'
  return 'On target'
}

export function DeskCard() {
  const f = useStore((s) => s.focus)
  const planned = f.plannedMs || 1
  const left = f.remainingMs ?? 0
  const offset = C * (1 - Math.min(1, left / planned))
  const mood = f.paused || f.deferred ? 'idle' : f.adrift && !f.excused ? 'adrift' : 'on'
  // The card renders from this window's scripts, so the bare `document` would
  // be the JARVIS page. The mood belongs on the card's own document.
  useEffect(() => {
    if (pip) pip.document.body.dataset.mood = mood
  }, [mood])

  const flash = (e: React.MouseEvent<HTMLButtonElement>, label: string) => {
    const b = e.currentTarget
    const was = b.textContent
    b.textContent = label
    b.classList.add('flash')
    setTimeout(() => {
      b.textContent = was
      b.classList.remove('flash')
    }, 1000)
  }

  return (
    <div className="card" role="timer" aria-label={`Focus session, ${clock(left)} left, ${stateLabel(f)}`}>
      <div className="ring">
        <svg viewBox="-75 -75 150 150" aria-hidden="true">
          <g className="ticks">
            {TICKS.map((i) => {
              const a = (i / 60) * 2 * Math.PI
              const long = i % 5 === 0
              return (
                <line
                  key={i}
                  x1={Math.cos(a) * 71}
                  y1={Math.sin(a) * 71}
                  x2={Math.cos(a) * (long ? 66 : 68.5)}
                  y2={Math.sin(a) * (long ? 66 : 68.5)}
                />
              )
            })}
          </g>
          <circle className="track" r={R} />
          <circle className="arc" r={R} strokeDasharray={C} strokeDashoffset={offset} />
        </svg>
        <div className="face">
          <span className="time">{clock(left)}</span>
          <span className="state">{stateLabel(f)}</span>
          <span className="drifts">
            {f.drifts ?? 0} drift{f.drifts === 1 ? '' : 's'}
          </span>
        </div>
      </div>
      <div className="row">
        <button
          onClick={(e) => {
            flash(e, 'Locked')
            void postFocus('lock_here', { fromCard: true })
          }}
        >
          Lock this tab
        </button>
      </div>
      <div className="row">
        <button onClick={() => void postFocus(f.paused ? 'resume' : 'pause')}>
          {f.paused ? 'Resume' : 'Pause'}
        </button>
        <button onClick={() => void postFocus('abort')}>End session</button>
      </div>
    </div>
  )
}

let pip: Window | null = null
let root: Root | null = null

type DocPip = { requestWindow: (o: { width: number; height: number }) => Promise<Window> }

export const deskCardSupported = () => 'documentPictureInPicture' in window

/** Open the card. Call from a click or key press. Safe to call twice. */
export async function openDeskCard(): Promise<boolean> {
  if (pip && !pip.closed) return true
  const api = (window as unknown as { documentPictureInPicture?: DocPip }).documentPictureInPicture
  if (!api) return false
  pip = await api.requestWindow({ width: 230, height: 300 })
  pip.document.title = 'J.A.R.V.I.S. focus'
  const style = pip.document.createElement('style')
  style.textContent = DESK_CSS
  pip.document.head.append(style)
  const mount = pip.document.createElement('div')
  pip.document.body.append(mount)
  root = createRoot(mount)
  root.render(<DeskCard />)
  pip.addEventListener('pagehide', () => {
    root?.unmount()
    root = null
    pip = null
  })
  return true
}

export function closeDeskCard(): void {
  pip?.close()
  pip = null
}
