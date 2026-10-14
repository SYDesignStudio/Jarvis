/**
 * Salman's email signature, and the one way JARVIS builds an email body.
 *
 * Mail sent or drafted through an API (the Gmail connector, Zapier Gmail)
 * never picks up the signature saved in Gmail's settings — only the web
 * composer adds that. So every email JARVIS writes goes through
 * composeEmail(), which appends the signature in both HTML and plain text.
 *
 * Standing rules baked in here, not left to the model:
 *   - never "ACIAT" (Salman asked for it removed, 27 Sep 2026);
 *   - the website line is the bare address, no "Web:" label;
 *   - the logo is a hosted PNG on a white tile, so it stays readable in dark
 *     mode (the charcoal lettering disappears on a dark background otherwise).
 *     Email clients will not show SVG or data: images, hence a URL — and if
 *     that URL is not live yet, the signature goes out without the image
 *     rather than with a broken one.
 */

export const SIGNATURE = {
  name: 'Salman Yousaf',
  title: 'Architectural Technologist',
  mobile: '07859431227',
  mobileIntl: '+447859431227',
  email: 'salman@sydesignstudio.co.uk',
  website: 'www.sydesignstudio.co.uk',
  company: 'SY DESIGN STUDIO Ltd',
}

// Hosted by Gmail: Salman uploaded SYDS_Email_Signature_Logo.png to the
// info@ Gmail signature (28 Sep 2026) and this is the address Gmail gave it.
// He does not want the logo on his website. If he ever replaces the image in
// that Gmail signature, read the new address from a sent email's HTML
// (img src="https://ci3.googleusercontent.com/mail-sig/...") and update here.
export const LOGO_URL =
  process.env.JARVIS_SIGNATURE_LOGO_URL ??
  'https://ci3.googleusercontent.com/mail-sig/AIorK4zVw4oxYrhzoDnCdBldnWPAuktNPV8qElaymFPJj6WRPamWZsZTQaHihaBRl2CFuKckRmy5lsUtLmER'

// The PNG is 280 x 308 (2x); shown at 110 px wide.
const LOGO_W = 110
const LOGO_H = 121

const ORANGE = '#E2711D'
const CHARCOAL = '#2F3336'
const GREY = '#6B7075'
const FONT = 'Arial, Helvetica, sans-serif'

export const esc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/**
 * Specline is a separate business with its own mailbox (info@specline.co.uk,
 * on Hostinger). Its mail never carries the SY Design Studio logo, title or
 * mobile. It carries the Specline mark instead (3 Oct 2026): the bracket
 * icon over the wordmark, the file the site already serves — a transparent
 * PNG, so it sits on a white tile here or the dark lettering vanishes in a
 * dark-mode inbox. Petrol is Specline's one accent; never SY orange.
 */
export const SPECLINE_LOGO_URL = process.env.JARVIS_SPECLINE_LOGO_URL ?? 'https://specline.co.uk/static/social/specline-doc-logo.png'
export const SPECLINE_SIGNATURE = {
  name: 'Salman Yousaf',
  title: 'Specline',
  email: 'info@specline.co.uk',
  website: 'www.specline.co.uk',
  company: '',
  plain: true,
  logoUrl: SPECLINE_LOGO_URL,
  // The PNG is 1040 x 1160; shown at 92 px wide.
  logoW: 92,
  logoH: 103,
  logoAlt: 'Specline',
  accent: '#0E6E85',
}

/** Which signature an account signs with. */
export const signatureFor = (account) => (/@specline\.co\.uk\s*>?$/i.test(String(account ?? '')) ? SPECLINE_SIGNATURE : SIGNATURE)

export function signatureText(s = SIGNATURE) {
  if (s.plain) return [s.name, s.title, s.email, s.website].filter(Boolean).join('\n')
  return [s.name, s.title, `Mobile: ${s.mobile}`, `Email: ${s.email}`, s.website, s.company].join('\n')
}

function plainSignatureHtml(s, logoUrl) {
  const accent = s.accent ?? CHARCOAL
  const row = (inner, style = '') => `<tr><td style="font-family:${FONT};font-size:13px;line-height:18px;color:${CHARCOAL};${style}">${inner}</td></tr>`
  const logo = logoUrl
    ? `<tr><td style="padding:0 0 12px 0;"><table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;"><tr>` +
      `<td bgcolor="#ffffff" style="background:#ffffff;padding:8px 10px 0 10px;border-radius:6px;"><a href="https://${s.website}" style="text-decoration:none;">` +
      `<img src="${esc(logoUrl)}" width="${s.logoW}" height="${s.logoH}" alt="${esc(s.logoAlt ?? s.title)}" ` +
      `style="display:block;border:0;outline:none;width:${s.logoW}px;height:${s.logoH}px;"></a></td></tr></table></td></tr>`
    : ''
  return (
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:22px 0 0 0;border-collapse:collapse;">` +
    logo +
    `<tr><td style="border-left:3px solid ${accent};padding:1px 0 1px 12px;">` +
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">` +
    row(esc(s.name), `font-size:15px;line-height:20px;font-weight:bold;color:${accent};`) +
    // With the logo above, the bare word "Specline" underneath it would only repeat the wordmark.
    (s.title && !logoUrl ? row(esc(s.title), `color:${GREY};`) : '') +
    row(`<a href="mailto:${s.email}" style="color:${CHARCOAL};text-decoration:none;">${esc(s.email)}</a>`, 'padding-top:8px;') +
    row(`<a href="https://${s.website}" style="color:${accent};text-decoration:none;">${esc(s.website)}</a>`) +
    `</table></td></tr></table>`
  )
}

export function signatureHtml({ logoUrl = LOGO_URL, signature = SIGNATURE } = {}) {
  const s = signature
  // A plain signature brings its own logo; the caller's logoUrl (the SY
  // Design Studio one by default) is only honoured as an explicit null = none.
  if (s.plain) return plainSignatureHtml(s, logoUrl === null ? null : (s.logoUrl ?? null))
  const line = (inner, pad = 3) =>
    `<tr><td style="padding:${pad}px 0 0 0;font-family:${FONT};font-size:13px;line-height:18px;color:${CHARCOAL};">${inner}</td></tr>`
  const label = (t) => `<span style="color:${ORANGE};font-weight:bold;">${t}</span>&nbsp;`
  const logo = logoUrl
    ? `<tr><td style="padding:0 0 14px 0;"><a href="https://${s.website}" style="text-decoration:none;">` +
      `<img src="${esc(logoUrl)}" width="${LOGO_W}" height="${LOGO_H}" alt="SY Design Studio" ` +
      `style="display:block;border:0;outline:none;width:${LOGO_W}px;height:${LOGO_H}px;"></a></td></tr>`
    : ''
  return (
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:22px 0 0 0;border-collapse:collapse;">` +
    logo +
    `<tr><td style="border-left:3px solid ${ORANGE};padding:1px 0 1px 12px;">` +
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">` +
    `<tr><td style="font-family:${FONT};font-size:16px;line-height:20px;font-weight:bold;color:${ORANGE};">${esc(s.name)}</td></tr>` +
    `<tr><td style="padding:2px 0 0 0;font-family:${FONT};font-size:13px;line-height:18px;color:${GREY};">${esc(s.title)}</td></tr>` +
    line(`${label('Mobile')}<a href="tel:${s.mobileIntl}" style="color:${CHARCOAL};text-decoration:none;">${esc(s.mobile)}</a>`, 10) +
    line(`${label('Email')}<a href="mailto:${s.email}" style="color:${CHARCOAL};text-decoration:none;">${esc(s.email)}</a>`) +
    line(`<a href="https://${s.website}" style="color:${ORANGE};text-decoration:none;">${esc(s.website)}</a>`) +
    `<tr><td style="padding:10px 0 0 0;font-family:${FONT};font-size:11px;line-height:14px;font-weight:bold;letter-spacing:1.5px;color:${CHARCOAL};">${esc(s.company)}</td></tr>` +
    `</table></td></tr></table>`
  )
}

/**
 * Drop any signature the model wrote itself (it copies old ones, ACIAT and
 * all) so the real one is never doubled. Only trailing lines are touched.
 */
export function stripOwnSignature(text) {
  const lines = String(text).replace(/\r/g, '').split('\n')
  const sigLine = new RegExp(
    [
      '^salman(\\s+yousaf)?$', '^architectural technologist', '^aciat$', '^mobile\\b', '^tel\\b', '^email\\b',
      '^(web:\\s*)?(https?://)?(www\\.)?sydesignstudio\\.co\\.uk', '^sy design studio( ltd)?$', '^director\\b',
      '^specline$', '^(https?://)?(www\\.)?specline\\.co\\.uk', '^info@specline\\.co\\.uk$',
      '^architectural technologist\\s*[—–-]', '^$',
    ].join('|'),
    'i',
  )
  let end = lines.length
  while (end > 0 && sigLine.test(lines[end - 1].trim())) end--
  return lines.slice(0, end).join('\n').replace(/\s+$/, '')
}

const linkify = (escaped) =>
  escaped
    .replace(/\b(https?:\/\/[^\s<]+[^\s<.,;:!?)])/g, `<a href="$1" style="color:${ORANGE};">$1</a>`)
    .replace(/\b([\w.+-]+@[\w-]+(?:\.[\w-]+)+)\b/g, `<a href="mailto:$1" style="color:${ORANGE};">$1</a>`)

export function bodyHtml(text) {
  return String(text)
    .replace(/\r/g, '')
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map(
      (p) =>
        `<p style="margin:0 0 14px 0;font-family:${FONT};font-size:14px;line-height:21px;color:${CHARCOAL};">` +
        linkify(esc(p)).replace(/\n/g, '<br>') +
        `</p>`,
    )
    .join('')
}

/**
 * The finished email: `htmlBody` for the rich version, `body` for the plain
 * alternative. `text` is the message itself, sign-off included ("Kind regards,"),
 * with blank lines between paragraphs. logoUrl: null gives the text-only signature.
 */
export function composeEmail(text, { logoUrl = LOGO_URL, signature = SIGNATURE } = {}) {
  const clean = stripOwnSignature(text)
  return {
    htmlBody: `<div style="font-family:${FONT};font-size:14px;line-height:21px;color:${CHARCOAL};">${bodyHtml(clean)}${signatureHtml({ logoUrl, signature })}</div>`,
    body: `${clean}\n\n${signatureText(signature)}`,
  }
}

let liveCache = { url: '', ok: false, at: 0 }
/** Is the hosted logo actually there? Checked at most every 10 minutes. */
export async function logoIsLive(url = LOGO_URL, fetchImpl = fetch) {
  if (!url) return false
  if (liveCache.url === url && Date.now() - liveCache.at < 10 * 60_000) return liveCache.ok
  let ok = false
  try {
    const r = await fetchImpl(url, { method: 'HEAD', signal: AbortSignal.timeout(6000) })
    ok = r.ok && /^image\//.test(r.headers.get('content-type') ?? '')
  } catch {}
  liveCache = { url, ok, at: Date.now() }
  return ok
}
