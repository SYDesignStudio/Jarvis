/**
 * Everything JARVIS says during a focus session, and the names he says it with.
 *
 * Scripted rather than generated: a callout has to land within a second of the
 * drift and cost nothing, and a model round trip does neither. Four lines per
 * tier so a long drift never loops the same three phrases.
 *
 * {label} is the distraction's spoken name and {intent} is what the user said
 * they were working on. The label exists for exactly one tick — see engine.mjs.
 */

/** Master switch for naming the distraction out loud. Off = nameless pools only. */
export const NAME_DISTRACTIONS = true

/** Spoken names for the sites that most often win. Anything else reads as its bare domain. */
const HOST_LABELS = [
  [/(^|\.)instagram\.com$/, 'Instagram'],
  [/(^|\.)youtube\.com$|(^|\.)youtu\.be$/, 'YouTube'],
  [/(^|\.)(x|twitter)\.com$/, 'X'],
  [/(^|\.)reddit\.com$/, 'Reddit'],
  [/(^|\.)tiktok\.com$/, 'TikTok'],
  [/(^|\.)netflix\.com$/, 'Netflix'],
  [/^mail\.google\.com$/, 'Gmail'],
  [/(^|\.)facebook\.com$/, 'Facebook'],
  [/(^|\.)linkedin\.com$/, 'LinkedIn'],
  [/(^|\.)amazon\.(co\.uk|com)$/, 'Amazon'],
  [/(^|\.)bbc\.(co\.uk|com)$/, 'the BBC'],
  [/(^|\.)whatsapp\.com$/, 'WhatsApp'],
  [/(^|\.)rightmove\.co\.uk$/, 'Rightmove'],
]

/** Windows process names that deserve a proper name when spoken. */
const APP_LABELS = {
  outlook: 'Outlook',
  olk: 'Outlook',
  spotify: 'Spotify',
  whatsapp: 'WhatsApp',
  explorer: 'File Explorer',
  excel: 'Excel',
  winword: 'Word',
  powerpnt: 'PowerPoint',
  teams: 'Teams',
  'ms-teams': 'Teams',
  slack: 'Slack',
  discord: 'Discord',
  acad: 'AutoCAD',
  revit: 'Revit',
  sketchup: 'SketchUp',
  claude: 'Claude',
  code: 'VS Code',
  steam: 'Steam',
}

export function labelFor({ app, host, browser }) {
  if (browser && host) {
    for (const [re, name] of HOST_LABELS) if (re.test(host)) return name
    return host.replace(/^www\./, '')
  }
  if (!app) return ''
  return APP_LABELS[app] ?? app.charAt(0).toUpperCase() + app.slice(1)
}

/** Tiers escalate with the number of drifts this session: first, second, third-plus. */
const NAMED = {
  butler: [
    [
      'Sir, {label} can wait.',
      '{label}, sir? The work is in the other window.',
      'I believe you meant to be elsewhere, sir. {label} will keep.',
      'Sir. {label}. Not the plan.',
    ],
    [
      'Twice into {label}, sir. It is starting to look deliberate.',
      '{label} again, sir. The deadline has not moved.',
      'Back in {label}, sir. I did notice.',
      'Sir, {label} has now been visited more often than the drawing.',
    ],
    [
      'Third time in {label}, sir. The detours are becoming the project.',
      '{label}, sir. At this point I could bill it.',
      'Sir, {label} is winning.',
      '{label}. Sir.',
    ],
  ],
  drill: [
    [
      '{label}. Out. Now.',
      'Off {label}. Back to it.',
      'I see {label}. Close it.',
      'No {label}. Work.',
    ],
    [
      '{label} again. Twice. Move.',
      'Second strike, {label}. Back.',
      'You were told. {label}. Closed.',
      '{label}. Again. Unacceptable.',
    ],
    [
      'Three times on {label}. Enough.',
      '{label}. Every time. Back to the job.',
      'Close {label}. That is an order.',
      '{label}. Out.',
    ],
  ],
}

const NAMELESS = [
  [
    'Sir, that is not the work.',
    'Wrong window, sir.',
    'I believe you meant to be elsewhere, sir.',
    'Sir. Not the plan.',
  ],
  [
    'Drifting again, sir.',
    'That is twice now, sir.',
    'Sir, the work is in the other window.',
    'Again, sir.',
  ],
  [
    'Sir, the detours are becoming the project.',
    'Third time, sir.',
    'Sir, this is winning.',
    'Sir.',
  ],
]

/** First callout of a session, when both the work and the distraction are known. */
const INTENT_LINES = [
  "Sir — {label} does not look like '{intent}' to me.",
  "I was told this was '{intent}', sir. {label} is not.",
]

let rotation = 0
const pick = (pool) => pool[rotation++ % pool.length]

const fill = (line, vars) =>
  line.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? ''))

/**
 * One callout line. `tier` is 1..3. The label is used and then dropped — this
 * function's return value is spoken and stored nowhere.
 */
export function calloutLine({ tier, label, intent, firstOfSession, style = 'butler' }) {
  const t = Math.max(1, Math.min(3, tier)) - 1
  const named = NAME_DISTRACTIONS && label
  if (named && firstOfSession && intent) {
    return fill(pick(INTENT_LINES), { label, intent })
  }
  if (named) return fill(pick((NAMED[style] ?? NAMED.butler)[t]), { label })
  return pick(NAMELESS[t])
}

export const LINES = {
  lockedOn: 'Locked on, sir.',
  deferredAskIntent:
    "Go to what you're working on and I'll lock on there. And what are we focusing on?",
  deferred: "Go to it, sir — I'll lock on where you land.",
  appOnly: 'You have not left me, sir. I shall hold you to the browser instead.',
  intentNoted: 'Noted, sir.',
  paused: 'Paused, sir.',
  resumed: 'Resumed, sir.',
  aborted: 'Session abandoned, sir. I shall not mention it again.',
  excused: 'Very good, sir. I shall say nothing until you are back.',
  noSession: 'There is no session running, sir.',
  alreadyRunning: 'A session is already running, sir.',
}

/** Minutes as they would be said: "one minute", "twenty-four minutes". */
export function spokenMinutes(n) {
  const m = Math.max(0, Math.round(n))
  return `${m} minute${m === 1 ? '' : 's'}`
}
