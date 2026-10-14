import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import { parseWhen } from './surfaces/reminders.mjs'

/**
 * Salman's iPhone calendar, which is iCloud — read, and added to. Never
 * changed or deleted: there is no update or delete here by construction.
 *
 * iCloud speaks CalDAV at caldav.icloud.com with the Apple ID email and an
 * APP-SPECIFIC password (appleid.apple.com → Sign-In and Security →
 * App-Specific Passwords), never the real Apple ID password. Put them in
 * .env.local as ICLOUD_USER and ICLOUD_APP_PASSWORD; ICLOUD_CALENDAR names the
 * calendar new events go in (default: the first of Home / Calendar / Work).
 */

const TZ = 'Europe/London'

// ---------------------------------------------------------------- pure: iCalendar

/** Minutes east of UTC for Europe/London at a given instant (0 in winter, 60 in summer). */
function londonOffset(date) {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(date)
  const get = (t) => Number(parts.find((p) => p.type === t).value)
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'))
  return Math.round((asUtc - date.getTime()) / 60000)
}

/** A wall-clock time in London → the real instant. */
export function londonTime(y, mo, d, h = 0, mi = 0, s = 0) {
  const guess = new Date(Date.UTC(y, mo, d, h, mi, s))
  const first = new Date(guess.getTime() - londonOffset(guess) * 60000)
  return new Date(guess.getTime() - londonOffset(first) * 60000)
}

/** "20261006T100000Z" / "20261006T100000" (+TZID) / "20261006" (all-day). */
export function parseIcsDate(value, params = '') {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(String(value).trim())
  if (!m) return { date: null, allDay: false }
  const [, y, mo, d, h, mi, s, z] = m
  if (h == null) return { date: londonTime(+y, +mo - 1, +d), allDay: true }
  if (z) return { date: new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +s)), allDay: false }
  // Floating or TZID times: Salman's calendars are all UK, so read them as London.
  void params
  return { date: londonTime(+y, +mo - 1, +d, +h, +mi, +s), allDay: false }
}

const unescapeText = (s) => String(s).replace(/\\n/gi, '\n').replace(/\\([,;\\])/g, '$1')
export const escapeText = (s) => String(s ?? '').replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/([,;])/g, '\\$1')

/** Every VEVENT in an iCalendar text: { title, start, end, allDay, location, notes, uid }. */
export function parseIcs(text) {
  const lines = String(text).replace(/\r?\n[ \t]/g, '').split(/\r?\n/)
  const events = []
  let ev = null
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') ev = {}
    else if (line === 'END:VEVENT' && ev) {
      if (ev.start) events.push(ev)
      ev = null
    } else if (ev) {
      const i = line.indexOf(':')
      if (i < 0) continue
      const [name, ...params] = line.slice(0, i).split(';')
      const value = line.slice(i + 1)
      if (name === 'SUMMARY') ev.title = unescapeText(value)
      else if (name === 'LOCATION') ev.location = unescapeText(value)
      else if (name === 'DESCRIPTION') ev.notes = unescapeText(value)
      else if (name === 'UID') ev.uid = value
      else if (name === 'DTSTART') Object.assign(ev, (({ date, allDay }) => ({ start: date, allDay }))(parseIcsDate(value, params.join(';'))))
      else if (name === 'DTEND') ev.end = parseIcsDate(value, params.join(';')).date
    }
  }
  return events
}

const icsUtc = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
const icsDay = (d) => {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d)
  return p.replace(/-/g, '')
}

/** One event as an iCalendar file. Times are written in UTC; the iPhone shows them in local time. */
export function buildIcs({ title, start, end, allDay = false, location = '', notes = '', alertMinutes = 30, uid = randomUUID(), now = new Date() }) {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//SY Design Studio//JARVIS//EN', 'CALSCALE:GREGORIAN', 'BEGIN:VEVENT', `UID:${uid}`, `DTSTAMP:${icsUtc(now)}`]
  if (allDay) {
    const next = new Date(start.getTime() + 24 * 3600_000)
    lines.push(`DTSTART;VALUE=DATE:${icsDay(start)}`, `DTEND;VALUE=DATE:${icsDay(end && end > start ? end : next)}`)
  } else {
    lines.push(`DTSTART:${icsUtc(start)}`, `DTEND:${icsUtc(end)}`)
  }
  lines.push(`SUMMARY:${escapeText(title)}`)
  if (location) lines.push(`LOCATION:${escapeText(location)}`)
  lines.push(`DESCRIPTION:${escapeText(`${notes ? `${notes}\n\n` : ''}Added by JARVIS`)}`)
  if (alertMinutes > 0) lines.push('BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${escapeText(title)}`, `TRIGGER:-PT${Math.round(alertMinutes)}M`, 'END:VALARM')
  lines.push('END:VEVENT', 'END:VCALENDAR')
  // iCalendar lines are folded at 75 octets.
  return lines.map((l) => (l.length <= 74 ? l : l.match(/.{1,73}/g).join('\r\n '))).join('\r\n') + '\r\n'
}

const fmt = (d, opts) => d.toLocaleString('en-GB', { timeZone: TZ, ...opts })
export function eventLine(e) {
  const day = fmt(e.start, { weekday: 'short', day: 'numeric', month: 'short' })
  const time = e.allDay ? 'all day' : `${fmt(e.start, { hour: '2-digit', minute: '2-digit' })}${e.end ? `–${fmt(e.end, { hour: '2-digit', minute: '2-digit' })}` : ''}`
  return `${day} ${time} · ${e.title ?? '(no title)'}${e.location ? ` · ${e.location}` : ''}${e.calendar ? ` (${e.calendar})` : ''}`
}

// ---------------------------------------------------------------- iCloud

export const calendarConfigured = (env = process.env) => Boolean(env.ICLOUD_USER && env.ICLOUD_APP_PASSWORD)

let clientPromise = null
async function client(env) {
  if (!clientPromise) {
    const { createDAVClient } = await import('tsdav')
    clientPromise = createDAVClient({
      serverUrl: 'https://caldav.icloud.com',
      credentials: { username: env.ICLOUD_USER, password: env.ICLOUD_APP_PASSWORD },
      authMethod: 'Basic',
      defaultAccountType: 'caldav',
    }).catch((err) => {
      clientPromise = null
      throw err
    })
  }
  return clientPromise
}

const isEventCalendar = (c) => !c.components || c.components.includes('VEVENT')
const nameOf = (c) => (typeof c.displayName === 'string' ? c.displayName : c.displayName?._cdata ?? c.url)

export async function listCalendars(env = process.env) {
  const c = await client(env)
  return (await c.fetchCalendars()).filter(isEventCalendar)
}

export async function eventsBetween(from, to, env = process.env) {
  const c = await client(env)
  const cals = await listCalendars(env)
  const out = []
  await Promise.all(
    cals.map(async (cal) => {
      const objs = await c.fetchCalendarObjects({ calendar: cal, timeRange: { start: from.toISOString(), end: to.toISOString() }, expand: true })
      for (const o of objs) for (const e of parseIcs(o.data)) if (e.start < to && (e.end ?? e.start) >= from) out.push({ ...e, calendar: nameOf(cal) })
    }),
  )
  return out.sort((a, b) => a.start - b.start)
}

export async function targetCalendar(env = process.env) {
  const cals = await listCalendars(env)
  const want = env.ICLOUD_CALENDAR?.toLowerCase()
  return (
    (want && cals.find((c) => nameOf(c).toLowerCase() === want)) ??
    cals.find((c) => /^(home|calendar|work|personal)$/i.test(nameOf(c))) ??
    cals[0]
  )
}

export async function addEvent(ev, env = process.env) {
  const c = await client(env)
  const cal = await targetCalendar(env)
  if (!cal) throw new Error('no iCloud calendar found')
  const uid = randomUUID()
  const res = await c.createCalendarObject({ calendar: cal, filename: `${uid}.ics`, iCalString: buildIcs({ ...ev, uid }) })
  if (res && res.ok === false) throw new Error(`iCloud refused the event (${res.status})`)
  return { calendar: nameOf(cal), uid }
}

/** "tomorrow 10am", "Tue 6 Oct 10:00", ISO — to a Date. */
function when(s, now = new Date()) {
  const iso = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?)?$/.test(String(s).trim())
  if (iso) {
    const [d, t = '09:00'] = String(s).trim().split('T')
    const [y, mo, day] = d.split('-').map(Number)
    const [h, mi] = t.split(':').map(Number)
    return londonTime(y, mo - 1, day, h, mi)
  }
  return parseWhen(s, now)
}

// ---------------------------------------------------------------- tools

export function calendarServer(env = process.env) {
  const configured = calendarConfigured(env)
  const notSet = { isError: true, content: [{ type: 'text', text: 'The iPhone (iCloud) calendar is not connected yet — ICLOUD_USER and ICLOUD_APP_PASSWORD are missing from .env.local. Say so.' }] }
  return createSdkMcpServer({
    name: 'jarvis_calendar',
    version: '1.0.0',
    instructions: configured
      ? "Salman's iPhone calendar (iCloud). calendar_events to see what's on; add_calendar_event for appointments. You can add, never change or delete."
      : 'The iPhone calendar is not connected yet (no iCloud app-specific password).',
    alwaysLoad: true,
    tools: [
      tool(
        'calendar_events',
        "What's in Salman's iPhone calendar between two dates — all his iCloud calendars. Default: today and the next 7 days. " +
          'Use for "what\'s on tomorrow", "am I free Tuesday at 10", and before suggesting or adding any appointment.',
        { from: z.string().optional().catch(undefined), days: z.union([z.number(), z.string()]).optional().catch(undefined) },
        async (a) => {
          if (!configured) return notSet
          try {
            const start = a.from ? when(a.from) : londonTime(...(() => { const n = new Date(); const p = fmt(n, { year: 'numeric', month: '2-digit', day: '2-digit' }).split('/'); return [+p[2], +p[1] - 1, +p[0]] })())
            if (!start || Number.isNaN(start.getTime())) return { isError: true, content: [{ type: 'text', text: `Could not read the date "${a.from}".` }] }
            const days = Math.min(62, Math.max(1, Number(a.days) || 7))
            const end = new Date(start.getTime() + days * 24 * 3600_000)
            const evs = await eventsBetween(start, end, env)
            const head = `${fmt(start, { weekday: 'short', day: 'numeric', month: 'short' })} to ${fmt(new Date(end - 1), { weekday: 'short', day: 'numeric', month: 'short' })}:`
            return { content: [{ type: 'text', text: evs.length ? `${head}\n${evs.map(eventLine).join('\n')}` : `${head} nothing in the calendar.` }] }
          } catch (err) {
            return { isError: true, content: [{ type: 'text', text: `Could not read the calendar: ${err.message}` }] }
          }
        },
      ),
      tool(
        'add_calendar_event',
        "Add an appointment to Salman's iPhone calendar: site visits, meetings, calls, surveys, deadlines (all_day). " +
          'start: "2026-10-06T10:00", or spoken ("Tuesday 10am", "tomorrow at 3"). Check calendar_events for clashes first and say if there is one. ' +
          'Put the job and address in the title or location. Only ever ADDS — nothing existing is touched. An alert fires 30 minutes before unless alert_minutes says otherwise.',
        {
          title: z.string().min(2),
          start: z.string(),
          end: z.string().optional().catch(undefined),
          duration_minutes: z.union([z.number(), z.string()]).optional().catch(undefined),
          all_day: z.boolean().optional().catch(undefined),
          location: z.string().optional().catch(undefined),
          notes: z.string().optional().catch(undefined),
          alert_minutes: z.union([z.number(), z.string()]).optional().catch(undefined),
        },
        async (a) => {
          if (!configured) return notSet
          const start = when(a.start)
          if (!start || Number.isNaN(start.getTime())) return { isError: true, content: [{ type: 'text', text: `Could not read the start time "${a.start}". Ask Salman for the date and time.` }] }
          if (start.getTime() < Date.now() - 3600_000 && !a.all_day) return { isError: true, content: [{ type: 'text', text: `${eventLine({ start, title: a.title })} is in the past. Check the date with Salman.` }] }
          const end = a.end ? when(a.end) : new Date(start.getTime() + (Number(a.duration_minutes) || 60) * 60000)
          try {
            const r = await addEvent(
              { title: a.title, start, end, allDay: Boolean(a.all_day), location: a.location ?? '', notes: a.notes ?? '', alertMinutes: a.alert_minutes == null ? 30 : Number(a.alert_minutes) },
              env,
            )
            return { content: [{ type: 'text', text: `Added to the ${r.calendar} calendar: ${eventLine({ start, end, allDay: Boolean(a.all_day), title: a.title, location: a.location })}. It will be on the iPhone within a minute.` }] }
          } catch (err) {
            return { isError: true, content: [{ type: 'text', text: `NOT added — ${err.message}. Say so.` }] }
          }
        },
      ),
    ],
  })
}
