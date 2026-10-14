/**
 * A small browser-shaped HTTP client for council planning registers: a cookie
 * jar per session, a real User-Agent, redirects followed, and a polite gap
 * between requests. Public registers only — nothing here logs in.
 */

export const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36'

/** One register visit: cookies persist across its requests and nowhere else. */
export function session({ gapMs = 400 } = {}) {
  const jar = new Map()
  let last = 0

  const cookieHeader = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ')
  const keep = (res) => {
    for (const c of res.headers.getSetCookie?.() ?? []) {
      const [pair] = c.split(';')
      const i = pair.indexOf('=')
      if (i > 0) jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim())
    }
  }

  // Council servers are slow, especially on document pages; ninety seconds is
  // what it takes on a bad day.
  async function request(url, { method = 'GET', form, referer, binary = false, timeoutMs = 90_000 } = {}) {
    const wait = last + gapMs - Date.now()
    if (wait > 0) await new Promise((r) => setTimeout(r, wait))
    let target = url
    let body = form ? new URLSearchParams(form).toString() : undefined
    for (let hop = 0; hop < 6; hop++) {
      const res = await fetch(target, {
        method,
        redirect: 'manual',
        headers: {
          'user-agent': UA,
          accept: binary ? '*/*' : 'text/html,application/xhtml+xml',
          'accept-language': 'en-GB,en;q=0.9',
          ...(jar.size ? { cookie: cookieHeader() } : {}),
          ...(referer ? { referer } : {}),
          ...(body ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
        },
        body,
        signal: AbortSignal.timeout(timeoutMs),
      })
      last = Date.now()
      keep(res)
      if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
        target = new URL(res.headers.get('location'), target).href
        method = 'GET'
        body = undefined
        continue
      }
      if (!res.ok) throw new Error(`${new URL(target).host} answered ${res.status}`)
      return binary
        ? { url: target, buffer: Buffer.from(await res.arrayBuffer()), type: res.headers.get('content-type') ?? '' }
        : { url: target, html: await res.text() }
    }
    throw new Error('too many redirects')
  }
  return { get: (u, o) => request(u, o), post: (u, form, o) => request(u, { ...o, method: 'POST', form }) }
}

/** HTML → plain text, enough for table cells and labels. */
export const strip = (html) =>
  String(html ?? '')
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#039;|&rsquo;/g, "'")
    .replace(/[ \t\r\f\v]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim()
