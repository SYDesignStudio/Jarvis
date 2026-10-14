import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { BRIDGE_HTTP_URL } from '../config'

/**
 * The planning tracker: every application, where it has got to, and what has
 * to happen next.
 *
 * It is a working list, so it is built to be used with a mouse in a hurry:
 * five piles across the top (what needs him first), one row per application,
 * and a row opens to the things he actually does — tick an action, add one,
 * say he has chased, put in the council's reference and dates, record the
 * decision. Every row carries its determination track: submitted, valid,
 * today, target, drawn to scale, so "how far through is it" is read at a
 * glance and an overdue one is visibly past its end.
 *
 * JARVIS fills it from email; this page is for looking and for correcting.
 */

type Flag = { kind: string; tone: 'hold' | 'fail'; text: string; due?: string; actionId?: number }
type Action = { id: number; text: string; due: string; done: boolean; by: string }
type App = {
  id: number; address: string; council: string; type: string; client: string; job: string
  ppRef: string; councilRef: string; officer?: string; fee?: string
  status: string; decision?: string
  submitted?: string; received?: string; validated?: string; target?: string; targetBasis?: string; decided?: string
  lastChased?: string; chaseOn?: string
  actions: Action[]; events: { at: string; what: string; source: string }[]
  flags: Flag[]; bucket: 'me' | 'chase' | 'decision' | 'validation' | 'done'
}

const PILES: { key: App['bucket'] | 'all'; label: string }[] = [
  { key: 'me', label: 'Needs you' },
  { key: 'chase', label: 'To chase' },
  { key: 'decision', label: 'Awaiting decision' },
  { key: 'validation', label: 'Awaiting validation' },
  { key: 'done', label: 'Decided' },
  { key: 'all', label: 'All' },
]
const DECISIONS = ['approved', 'refused', 'withdrawn', 'lawful', 'not lawful', 'prior approval granted', 'prior approval refused', 'prior approval not required', 'split decision']

const DAY = 86400_000
const at = (d?: string) => (d ? new Date(`${d}T12:00:00Z`).getTime() : NaN)
const fmt = (d?: string) => (d ? new Date(`${d}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: '2-digit' }) : '')
const today = () => new Date().toISOString().slice(0, 10)
const daysTo = (d?: string) => (d ? Math.round((at(d) - at(today())) / DAY) : NaN)

/** Where it stands, in a few words — the line under the address. */
function standing(a: App): { text: string; tone?: 'hold' | 'fail' | 'pass' } {
  if (a.status === 'decided') return { text: `${a.decision || 'Decided'}${a.decided ? ` · ${fmt(a.decided)}` : ''}`, tone: /refus|not lawful/i.test(a.decision ?? '') ? 'fail' : 'pass' }
  if (a.status === 'withdrawn' || a.status === 'closed') return { text: a.status === 'closed' ? 'Closed' : 'Withdrawn' }
  if (a.status === 'invalid') return { text: 'Invalid — council needs something', tone: 'fail' }
  if (a.status === 'draft') return { text: 'Not yet submitted — fee to be paid' }
  if (a.status === 'valid') {
    const left = daysTo(a.target)
    if (Number.isNaN(left)) return { text: `Valid ${fmt(a.validated)} · no decision date given` }
    if (left < 0) return { text: `Decision overdue by ${-left} day${left === -1 ? '' : 's'}`, tone: 'fail' }
    return { text: `Decision due ${a.targetBasis === 'calculated' ? 'about ' : ''}${fmt(a.target)} · ${left} day${left === 1 ? '' : 's'} left`, tone: left <= 7 ? 'hold' : undefined }
  }
  const sent = a.received || a.submitted
  const waited = sent ? -daysTo(sent) : NaN
  return { text: `${a.received ? 'With the council' : 'Submitted'}${sent ? ` ${fmt(sent)}` : ''} · waiting for validation${waited >= 0 ? ` (${waited} day${waited === 1 ? '' : 's'})` : ''}`, tone: waited >= 10 ? 'hold' : undefined }
}

/** The determination track: submitted → valid → today → target, to scale. */
const Track = memo(function Track({ a }: { a: App }) {
  const start = at(a.submitted || a.received || a.validated)
  const end = at(a.decided || a.target)
  if (Number.isNaN(start)) return <div className="tk-track tk-track-none">No dates yet</div>
  const now = at(today())
  const last = Math.max(Number.isNaN(end) ? start + 56 * DAY : end, a.decided ? 0 : now) + 4 * DAY
  const span = Math.max(last - start, 14 * DAY)
  const x = (t: number) => `${Math.max(0, Math.min(100, ((t - start) / span) * 100)).toFixed(2)}%`
  const valid = at(a.validated)
  const target = at(a.target)
  const over = !a.decided && !Number.isNaN(target) && now > target
  const reach = a.decided ? at(a.decided) : now
  return (
    <div className={`tk-track${over ? ' tk-over' : ''}`} aria-hidden="true">
      <i className="tk-rail" />
      <i className="tk-run" style={{ width: x(reach) }} />
      {over ? <i className="tk-late" style={{ left: x(target), width: `calc(${x(now)} - ${x(target)})` }} /> : null}
      <b className="tk-dot" style={{ left: 0 }} title={`Submitted ${fmt(a.submitted || a.received)}`} />
      {!Number.isNaN(valid) ? <b className="tk-dot tk-valid" style={{ left: x(valid) }} title={`Valid ${fmt(a.validated)}`} /> : null}
      {!Number.isNaN(target) ? <b className={`tk-end${a.targetBasis === 'calculated' ? ' tk-approx' : ''}`} style={{ left: x(target) }} title={`Target ${fmt(a.target)}`} /> : null}
      {!a.decided ? <b className="tk-now" style={{ left: x(now) }} /> : null}
      <span className="tk-cap" style={{ left: 0 }}>{fmt(a.submitted || a.received)}</span>
      {!Number.isNaN(target) ? (
        <span className="tk-cap tk-cap-end" style={{ left: x(target) }}>
          {a.targetBasis === 'calculated' ? '≈ ' : ''}
          {fmt(a.target)}
        </span>
      ) : null}
    </div>
  )
})

export const TrackerDash = memo(function TrackerDash() {
  const [apps, setApps] = useState<App[] | null>(null)
  const [err, setErr] = useState('')
  const [pile, setPile] = useState<App['bucket'] | 'all'>('me')
  const [picked, setPicked] = useState(false)
  const [open, setOpen] = useState<number | null>(null)
  const [find, setFind] = useState('')
  const [adding, setAdding] = useState(false)
  const alive = useRef(true)

  const load = useCallback(async () => {
    try {
      const r = await fetch(`${BRIDGE_HTTP_URL}/tracker?all=1`)
      const data = await r.json()
      if (!alive.current) return
      if (!r.ok) throw new Error(data?.error ?? `the bridge answered ${r.status}`)
      setApps(data.apps)
      setErr('')
    } catch (e) {
      if (alive.current) setErr(e instanceof Error ? e.message : String(e))
    }
  }, [])

  useEffect(() => {
    alive.current = true
    void load()
    const t = window.setInterval(() => void load(), 30_000)
    return () => {
      alive.current = false
      window.clearInterval(t)
    }
  }, [load])

  /** One change, sent to the bridge; the answer is the fresh list. */
  const act = useCallback(async (body: Record<string, unknown>) => {
    try {
      // text/plain keeps this a "simple" request: no preflight round trip.
      const r = await fetch(`${BRIDGE_HTTP_URL}/tracker/act`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: JSON.stringify(body) })
      const data = await r.json()
      if (!r.ok || !data.ok) throw new Error(data?.error ?? 'not saved')
      setErr('')
      await load()
      return true
    } catch (e) {
      setErr(`Not saved: ${e instanceof Error ? e.message : String(e)}`)
      return false
    }
  }, [load])

  const counts = useMemo(() => {
    const c: Record<string, number> = { me: 0, chase: 0, decision: 0, validation: 0, done: 0, all: 0 }
    for (const a of apps ?? []) { c[a.bucket]++; if (a.bucket !== 'done') c.all++ }
    return c
  }, [apps])

  // Open on the first pile that has something in it, until he chooses one himself.
  useEffect(() => {
    if (picked || !apps) return
    const first = (['me', 'chase', 'decision', 'validation'] as const).find((k) => counts[k] > 0)
    setPile(first ?? 'all')
  }, [apps, counts, picked])

  const shown = useMemo(() => {
    const q = find.trim().toLowerCase()
    return (apps ?? []).filter((a) => {
      if (q) return `${a.address} ${a.client} ${a.council} ${a.councilRef} ${a.ppRef} ${a.job} ${a.type}`.toLowerCase().includes(q)
      return pile === 'all' ? a.bucket !== 'done' : a.bucket === pile
    })
  }, [apps, pile, find])

  if (!apps) return <div className="tk"><p className="tk-empty">{err ? `The tracker cannot be shown: ${err}` : 'Reading the tracker…'}</p></div>

  return (
    <div className="tk">
      <header className="tk-top">
        <h2>Planning tracker</h2>
        <input className="tk-find" type="search" placeholder="Find an address, client or reference" value={find} onChange={(e) => setFind(e.target.value)} aria-label="Find an application" />
        <button className="tk-btn" onClick={() => setAdding((v) => !v)}>{adding ? 'Cancel' : 'Add an application'}</button>
      </header>

      {adding ? <AddForm onAdd={async (b) => { if (await act({ op: 'add', ...b })) { setAdding(false); setPicked(true); setPile('validation') } }} /> : null}

      <nav className="tk-piles" aria-label="Show">
        {PILES.map((p) => (
          <button key={p.key} className={`tk-pile${!find && pile === p.key ? ' on' : ''}${p.key === 'me' && counts.me ? ' hot' : ''}`} onClick={() => { setPile(p.key); setPicked(true); setFind('') }} aria-pressed={!find && pile === p.key}>
            <b>{counts[p.key]}</b>
            {p.label}
          </button>
        ))}
      </nav>
      {err ? <p className="tk-err" role="alert">{err}</p> : null}

      {shown.length ? (
        <ul className="tk-list">
          {shown.map((a) => {
            const st = standing(a)
            const isOpen = open === a.id
            return (
              <li key={a.id} className={`tk-row${isOpen ? ' open' : ''}`}>
                <button className="tk-head" onClick={() => setOpen(isOpen ? null : a.id)} aria-expanded={isOpen}>
                  <span className="tk-site">
                    <b>{a.address || '(no address yet)'}</b>
                    <span>
                      {[a.council, a.councilRef || a.ppRef, a.type].filter(Boolean).join(' · ') || 'No details yet'}
                      {a.client ? ` · ${a.client}` : ''}
                    </span>
                  </span>
                  <span className="tk-where">
                    <span className={`tk-stand${st.tone ? ` tk-${st.tone}` : ''}`}>{st.text}</span>
                    <Track a={a} />
                  </span>
                  <span className="tk-chev" aria-hidden="true">{isOpen ? '−' : '+'}</span>
                </button>

                {a.flags.length ? (
                  <ul className="tk-flags">
                    {a.flags.map((f, i) => (
                      <li key={i} className={`tk-${f.tone}`}>
                        {f.actionId ? (
                          <label>
                            <input type="checkbox" onChange={() => void act({ op: 'action_done', id: a.id, actionId: f.actionId })} />
                            <span>{f.text}{f.due ? <em> · by {fmt(f.due)}</em> : null}</span>
                          </label>
                        ) : (
                          <>
                            <span>{f.text}</span>
                            {f.kind === 'chase' || f.kind === 'overdue' ? <button className="tk-mini" onClick={() => void act({ op: 'chased', id: a.id })}>Chased today</button> : null}
                          </>
                        )}
                      </li>
                    ))}
                  </ul>
                ) : null}

                {isOpen ? <Detail a={a} act={act} /> : null}
              </li>
            )
          })}
        </ul>
      ) : (
        <p className="tk-empty">
          {find ? `Nothing matches "${find}".` : pile === 'me' ? 'Nothing needs you right now.' : pile === 'chase' ? 'Nothing to chase today.' : 'Nothing in this pile.'}
        </p>
      )}
      <p className="tk-foot">Filled from Planning Portal and council emails. ≈ marks a decision date worked out from the statutory period, not one the council has given. Or just tell JARVIS: “Saxon Avenue was validated on the 22nd”.</p>
    </div>
  )
})

function AddForm({ onAdd }: { onAdd: (b: Record<string, string>) => void }) {
  const [f, setF] = useState({ address: '', council: '', type: 'Householder planning permission', client: '', councilRef: '', submitted: '' })
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value })
  return (
    <form className="tk-add" onSubmit={(e) => { e.preventDefault(); if (f.address.trim()) onAdd(f) }}>
      <label className="wide">Site address<input value={f.address} onChange={set('address')} placeholder="17 Saxon Avenue, Feltham TW13 5JJ" autoFocus required /></label>
      <label>Council<input value={f.council} onChange={set('council')} placeholder="Hounslow" /></label>
      <label>Type
        <select value={f.type} onChange={set('type')}>
          {['Householder planning permission', 'Full planning permission', 'Lawful development: Proposed use', 'Lawful development: Existing use', 'Prior Approval: Larger home extension', 'Approval of details reserved by a condition (discharge)', 'Removal/Variation of a condition', 'Pre-application advice', 'Building control'].map((t) => <option key={t}>{t}</option>)}
        </select>
      </label>
      <label>Client<input value={f.client} onChange={set('client')} /></label>
      <label>Council reference<input value={f.councilRef} onChange={set('councilRef')} placeholder="if you have it" /></label>
      <label>Submitted<input type="date" value={f.submitted} onChange={set('submitted')} /></label>
      <button className="tk-btn tk-primary" type="submit">Add to the tracker</button>
    </form>
  )
}

function Detail({ a, act }: { a: App; act: (b: Record<string, unknown>) => Promise<boolean> }) {
  const [text, setText] = useState('')
  const [due, setDue] = useState('')
  const [ref, setRef] = useState(a.councilRef)
  const [officer, setOfficer] = useState(a.officer ?? '')
  const save = (k: string, v: string, what: string) => { if (v !== ((a as unknown as Record<string, string>)[k] ?? '')) void act({ op: 'update', id: a.id, [k]: v, what }) }
  const openActions = a.actions.filter((x) => !x.done)
  const doneActions = a.actions.filter((x) => x.done)
  return (
    <div className="tk-detail">
      <section>
        <h3>Reference and dates</h3>
        <div className="tk-fields">
          <label>Council reference<input value={ref} onChange={(e) => setRef(e.target.value)} onBlur={() => save('councilRef', ref.trim(), `Council reference ${ref.trim()}`)} placeholder="not received yet" /></label>
          <label>Officer<input value={officer} onChange={(e) => setOfficer(e.target.value)} onBlur={() => save('officer', officer.trim(), `Officer ${officer.trim()}`)} placeholder="not known" /></label>
          <label>Validated<input type="date" defaultValue={a.validated ?? ''} onChange={(e) => e.target.value && save('validated', e.target.value, `Validated ${e.target.value}`)} /></label>
          <label>Decision due{a.targetBasis === 'calculated' ? ' (≈ worked out)' : ''}<input type="date" defaultValue={a.target ?? ''} onChange={(e) => e.target.value && save('target', e.target.value, `Decision due ${e.target.value} (entered by hand)`)} /></label>
          <label>Decision
            {/* The decision date is the one on the notice, never "today": it is entered beside this, not assumed. */}
            <select value={a.decision ?? ''} onChange={(e) => e.target.value && void act({ op: 'update', id: a.id, decision: e.target.value, what: `Decision: ${e.target.value}` })}>
              <option value="">not decided</option>
              {DECISIONS.map((d) => <option key={d}>{d}</option>)}
            </select>
          </label>
          <label>Decided on<input type="date" defaultValue={a.decided ?? ''} onChange={(e) => e.target.value && save('decided', e.target.value, `Decided ${e.target.value}`)} /></label>
        </div>
        <p className="tk-facts">
          {[a.ppRef && `Portal ${a.ppRef}`, a.fee && `fee ${a.fee}`, a.job && `job ${a.job}`, a.client && `client ${a.client}`, a.lastChased && `last chased ${fmt(a.lastChased)}`].filter(Boolean).join(' · ') || 'No other details.'}
        </p>
        <div className="tk-acts">
          <button className="tk-btn" onClick={() => void act({ op: 'chased', id: a.id })}>Chased today</button>
          {a.status === 'invalid' ? <button className="tk-btn" onClick={() => void act({ op: 'update', id: a.id, status: 'received', what: 'No longer invalid' })}>No longer invalid</button> : <button className="tk-btn" onClick={() => void act({ op: 'update', id: a.id, status: 'invalid', what: 'Council says invalid' })}>Mark invalid</button>}
          {a.bucket !== 'done' ? <button className="tk-btn" onClick={() => void act({ op: 'update', id: a.id, status: 'closed', what: 'Closed' })}>Close without a decision</button> : <button className="tk-btn" onClick={() => void act({ op: 'update', id: a.id, status: a.validated ? 'valid' : 'received', decision: '', what: 'Reopened' })}>Reopen</button>}
        </div>
      </section>

      <section>
        <h3>Actions</h3>
        {openActions.length || doneActions.length ? (
          <ul className="tk-todo">
            {openActions.map((x) => (
              <li key={x.id}><label><input type="checkbox" onChange={() => void act({ op: 'action_done', id: a.id, actionId: x.id })} /><span>{x.text}{x.due ? <em> · by {fmt(x.due)}</em> : null}</span></label></li>
            ))}
            {doneActions.slice(-4).map((x) => (
              <li key={x.id} className="done"><label><input type="checkbox" checked onChange={() => void act({ op: 'action_done', id: a.id, actionId: x.id, done: false })} /><span>{x.text}</span></label></li>
            ))}
          </ul>
        ) : <p className="tk-quiet">Nothing to do on this one.</p>}
        <form className="tk-new" onSubmit={async (e) => { e.preventDefault(); if (text.trim().length > 2 && (await act({ op: 'action_add', id: a.id, text, due }))) { setText(''); setDue('') } }}>
          <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Add something to do…" aria-label="New action" />
          <input type="date" value={due} onChange={(e) => setDue(e.target.value)} aria-label="Due date" />
          <button className="tk-btn" type="submit">Add</button>
        </form>
      </section>

      <section>
        <h3>History</h3>
        <ul className="tk-hist">
          {[...a.events].reverse().slice(0, 12).map((e, i) => (
            <li key={i}><time>{fmt(e.at)}</time><span>{e.what}{e.source ? <em> — {e.source}</em> : null}</span></li>
          ))}
        </ul>
      </section>
    </div>
  )
}
