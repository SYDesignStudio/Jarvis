import { memo, useCallback, useEffect, useRef, useState } from 'react'
import { BRIDGE_HTTP_URL } from '../config'

/**
 * The Specline dashboard: the product's own desk, on a blade.
 *
 * It is Specline's world inside JARVIS's, so it wears Specline's identity —
 * petrol on drafting ink, IBM Plex, figures in mono — not the HUD's cyan. The
 * headline figures sit inside the bracket mark, which is the one flourish;
 * everything else is hairlines and columns, because it is a ledger.
 *
 * Read-only. Changes are made by telling JARVIS, who has the tool for it; the
 * page only ever holds the answer the bridge fetched, never the key.
 */

type Practice = {
  id: number; name: string; wants: string; live: boolean; status: string; plan: string; plan_name: string
  seats: number; seats_used: number; ends_at: string | null; source: string; credits: number; issued: number; jobs: number
}
type Person = {
  id: number; name: string; email: string; role: string; practice: string; verified: boolean
  last_login_at: string | null; logins: number; issued: number; created_at: string
}
type Message = { id: number; at: string; name: string; email: string; practice: string; subject: string; body: string; status: string }
type Overview = {
  at: string
  switches: { site_lock: boolean; app_open: string; billing_enforce: boolean; payments: string; payments_ready: boolean }
  counts: Record<string, number>
  practices: Practice[]
  people: Person[]
  messages: Message[]
  waitlist: { at: string; email: string; name: string; practice: string }[]
  issued_recent: { at: string; practice: string; type: string; job_no: string; title: string; rev: string }[]
  regs: { code: string; title: string; status: string; open_events: number }[]
  feed: { at: string; who: string; what: string; detail: string }[]
}

const since = (iso: string | null): string => {
  if (!iso) return 'never'
  const d = (Date.now() - new Date(iso).getTime()) / 1000
  if (d < 90) return 'just now'
  if (d < 3600) return `${Math.round(d / 60)} min`
  if (d < 86400) return `${Math.round(d / 3600)} h`
  if (d < 14 * 86400) return `${Math.round(d / 86400)} d`
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
}
const day = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: '2-digit' }) : '')
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

const WHAT: [RegExp, string][] = [
  [/^signup/, 'Sign-up'], [/^login-locked/, 'Sign-in refused'], [/^billing\.issue/, 'Specification issued'],
  [/^billing\.credits/, 'Credits'], [/^billing\.grant/, 'Subscription granted'], [/^billing\.end/, 'Subscription ended'],
  [/^billing\.checkout/, 'Checkout opened'], [/^billing\.expire/, 'Subscription expired'], [/^agent\.refused/, 'Assistant key refused'],
  [/^agent\./, 'JARVIS'], [/^message-/, 'Message'], [/^push\./, 'Notification'], [/^regs/, 'Regulations'], [/^settings/, 'Settings'],
]
const whatLabel = (w: string) => WHAT.find(([re]) => re.test(w))?.[1] ?? w.replace(/[.-]/g, ' ')

/** What needs him, most pressing first — the same rules the bridge speaks from. */
function attention(o: Overview): { text: string; tone: 'hold' | 'fail' }[] {
  const c = o.counts
  const out: { text: string; tone: 'hold' | 'fail' }[] = []
  if (c.messages_new) out.push({ text: `${plural(c.messages_new, 'new message')} from the contact form`, tone: 'hold' })
  if (c.past_due) out.push({ text: `${plural(c.past_due, 'practice')} with a failed payment`, tone: 'fail' })
  if (c.regs_changed) out.push({ text: `${plural(c.regs_changed, 'Approved Document')} changed on gov.uk, not yet reviewed`, tone: 'hold' })
  const unverified = o.people.filter((p) => !p.verified).length
  if (unverified) out.push({ text: `${plural(unverified, 'account')} not yet verified`, tone: 'hold' })
  for (const p of o.practices) {
    if (p.live && p.seats_used > p.seats) out.push({ text: `${p.name} is over its seats (${p.seats_used} of ${p.seats})`, tone: 'hold' })
    if (p.live && p.ends_at && new Date(p.ends_at).getTime() - Date.now() < 14 * 86400_000) out.push({ text: `${p.name} ends ${day(p.ends_at)}`, tone: 'hold' })
  }
  if (o.switches.payments === 'test') out.push({ text: 'Payments are in test mode — cards are not charged', tone: 'hold' })
  else if (o.switches.payments !== 'none' && !o.switches.payments_ready) out.push({ text: 'Payments are not fully connected', tone: 'fail' })
  return out
}

const Figure = ({ n, label, sub }: { n: number; label: string; sub?: string }) => (
  <div className="sl-fig">
    <span className="sl-num">{n}</span>
    <span className="sl-lab">{label}</span>
    {sub ? <span className="sl-sub">{sub}</span> : null}
  </div>
)

const Switch = ({ label, value, tone }: { label: string; value: string; tone?: 'hold' | 'pass' }) => (
  <span className={`sl-sw${tone ? ` sl-${tone}` : ''}`}>
    <i>{label}</i>
    {value}
  </span>
)

export const SpeclineDash = memo(function SpeclineDash() {
  const [o, setO] = useState<Overview | null>(null)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const alive = useRef(true)

  const load = useCallback(async (fresh = false) => {
    setBusy(true)
    try {
      const r = await fetch(`${BRIDGE_HTTP_URL}/specline${fresh ? '?fresh=1' : ''}`)
      const data = await r.json()
      if (!alive.current) return
      if (!r.ok) throw new Error(data?.error ?? `the bridge answered ${r.status}`)
      setO(data)
      setErr('')
    } catch (e) {
      if (alive.current) setErr(e instanceof Error ? e.message : String(e))
    } finally {
      if (alive.current) setBusy(false)
    }
  }, [])

  useEffect(() => {
    alive.current = true
    void load()
    const t = window.setInterval(() => void load(), 60_000)
    return () => {
      alive.current = false
      window.clearInterval(t)
    }
  }, [load])

  if (!o) {
    return (
      <div className="sl">
        <p className="sl-empty">{err ? `Specline cannot be shown: ${err}` : 'Reading specline.co.uk…'}</p>
      </div>
    )
  }

  const c = o.counts
  const s = o.switches
  const need = attention(o)
  const open = { admin: 'owner only', verified: 'verified accounts', closed: 'closed' }[s.app_open] ?? s.app_open

  return (
    <div className="sl">
      <header className="sl-top">
        <div className="sl-mark" aria-hidden="true" />
        <div className="sl-name">
          <b>Specline</b>
          <span>specline.co.uk · as at {new Date(o.at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}</span>
        </div>
        <div className="sl-switches">
          <Switch label="Sign-ups" value={s.site_lock ? 'locked' : 'open'} tone={s.site_lock ? 'hold' : 'pass'} />
          <Switch label="Tool" value={open} tone={s.app_open === 'closed' ? 'hold' : undefined} />
          <Switch label="Billing rule" value={s.billing_enforce ? 'enforced' : 'off'} />
          <Switch label="Payments" value={s.payments === 'none' ? 'not connected' : s.payments} tone={s.payments === 'live' && s.payments_ready ? 'pass' : 'hold'} />
        </div>
        <button className="sl-refresh" onClick={() => void load(true)} disabled={busy}>
          {busy ? 'Reading…' : 'Refresh'}
        </button>
      </header>
      {err ? <p className="sl-stale">Not refreshed: {err}. Showing the last reading.</p> : null}

      <section className="sl-figs">
        <Figure n={c.accounts} label="Accounts" sub={`${c.accounts_week} this week · ${c.active_week} signed in`} />
        <Figure n={c.entitled} label="Subscribed practices" sub={`of ${c.practices}`} />
        <Figure n={c.issued} label="Specifications issued" sub={`${c.issued_week} this week`} />
        <Figure n={c.jobs} label="Saved jobs" sub={`${c.jobs_week} touched this week`} />
        <Figure n={c.waitlist} label="Waiting list" sub={`${c.waitlist_week} this week`} />
        <Figure n={c.messages_new} label="New messages" sub={`${c.messages_day} today`} />
      </section>

      <section className="sl-founding" aria-label={`Founding places: ${c.founding_taken} of ${c.founding_places} taken`}>
        <span className="sl-h">Founding places</span>
        <div className="sl-places">
          {Array.from({ length: c.founding_places }, (_, i) => (
            <i key={i} className={i < c.founding_taken ? 'on' : ''} />
          ))}
        </div>
        <span className="sl-mono">
          {c.founding_taken} of {c.founding_places} taken
        </span>
      </section>

      <div className="sl-cols">
        <div className="sl-col">
          <section>
            <h3 className="sl-h">Needs you</h3>
            {need.length ? (
              <ul className="sl-need">
                {need.map((n, i) => (
                  <li key={i} className={`sl-${n.tone}`}>
                    {n.text}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="sl-quiet">Nothing is waiting on you.</p>
            )}
          </section>

          <section>
            <h3 className="sl-h">
              Open messages <span>{o.messages.length}</span>
            </h3>
            {o.messages.length ? (
              <ul className="sl-msgs">
                {o.messages.map((m) => (
                  <li key={m.id}>
                    <div className="sl-row">
                      <b>{m.name || m.email}</b>
                      <span className={`sl-tag${m.status === 'new' ? ' sl-hold' : ''}`}>{m.status}</span>
                      <span className="sl-when">{since(m.at)}</span>
                    </div>
                    <p className="sl-subj">{m.subject || '(no subject)'}</p>
                    <p className="sl-body">{m.body}</p>
                    <p className="sl-dim">
                      #{m.id} · {m.email}
                      {m.practice ? ` · ${m.practice}` : ''}
                    </p>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="sl-quiet">No open messages from the contact form.</p>
            )}
          </section>

          <section>
            <h3 className="sl-h">What just happened</h3>
            <ul className="sl-feed">
              {o.feed.slice(0, 18).map((f, i) => (
                <li key={i}>
                  <span className="sl-when">{since(f.at)}</span>
                  <b>{whatLabel(f.what)}</b>
                  <span className="sl-dim">
                    {String(f.detail).slice(0, 90)}
                    {f.who ? ` · ${f.who}` : ''}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        </div>

        <div className="sl-col">
          <section>
            <h3 className="sl-h">
              Practices <span>{o.practices.length}</span>
            </h3>
            <table className="sl-table">
              <thead>
                <tr>
                  <th>Practice</th>
                  <th>Subscription</th>
                  <th className="r">Seats</th>
                  <th className="r">Credits</th>
                  <th className="r">Jobs</th>
                  <th className="r">Issued</th>
                </tr>
              </thead>
              <tbody>
                {o.practices.map((p) => (
                  <tr key={p.id}>
                    <td>
                      {p.name}
                      <span className="sl-dim"> #{p.id}</span>
                    </td>
                    <td>
                      {p.live ? (
                        <>
                          {p.plan_name}
                          <span className={`sl-tag${p.status === 'past_due' ? ' sl-fail' : ''}`}>{p.status === 'past_due' ? 'payment failed' : p.source || p.status}</span>
                          {p.ends_at ? <span className="sl-dim"> to {day(p.ends_at)}</span> : null}
                        </>
                      ) : (
                        <span className="sl-dim">none{p.wants && p.wants !== 'undecided' ? ` · wants ${p.wants}` : ''}</span>
                      )}
                    </td>
                    <td className={`r${p.live && p.seats_used > p.seats ? ' sl-hold' : ''}`}>{p.live ? `${p.seats_used}/${p.seats}` : p.seats_used}</td>
                    <td className="r">{p.credits}</td>
                    <td className="r">{p.jobs}</td>
                    <td className="r">{p.issued}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          <section>
            <h3 className="sl-h">
              People <span>{o.people.length}</span>
            </h3>
            <table className="sl-table">
              <thead>
                <tr>
                  <th>Person</th>
                  <th>Practice</th>
                  <th className="r">Last in</th>
                  <th className="r">Sign-ins</th>
                  <th className="r">Issued</th>
                </tr>
              </thead>
              <tbody>
                {o.people.slice(0, 40).map((p) => (
                  <tr key={p.id}>
                    <td>
                      {p.name}
                      {p.role === 'owner' ? <span className="sl-tag">owner</span> : null}
                      {!p.verified ? <span className="sl-tag sl-hold">unverified</span> : null}
                      <span className="sl-dim sl-block">{p.email}</span>
                    </td>
                    <td>{p.practice}</td>
                    <td className="r">{since(p.last_login_at)}</td>
                    <td className="r">{p.logins}</td>
                    <td className="r">{p.issued}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          <div className="sl-pair">
            <section>
              <h3 className="sl-h">Recently issued</h3>
              {o.issued_recent.length ? (
                <ul className="sl-feed">
                  {o.issued_recent.slice(0, 8).map((i, k) => (
                    <li key={k}>
                      <span className="sl-when">{since(i.at)}</span>
                      <b>
                        {i.job_no || i.type} {i.rev}
                      </b>
                      <span className="sl-dim">
                        {i.title ? `${i.title} · ` : ''}
                        {i.practice}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="sl-quiet">No specification has been issued yet.</p>
              )}
            </section>
            <section>
              <h3 className="sl-h">
                Waiting list <span>{c.waitlist}</span>
              </h3>
              {o.waitlist.length ? (
                <ul className="sl-feed">
                  {o.waitlist.slice(0, 8).map((w, k) => (
                    <li key={k}>
                      <span className="sl-when">{since(w.at)}</span>
                      <b>{w.practice || w.name || w.email.split('@')[0]}</b>
                      <span className="sl-dim">{w.email}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="sl-quiet">Nobody is on the waiting list.</p>
              )}
            </section>
          </div>
        </div>
      </div>

      <p className="sl-foot">To change anything here, tell JARVIS — “lock sign-ups”, “give that practice three credits”, “mark message 4 replied”.</p>
    </div>
  )
})
