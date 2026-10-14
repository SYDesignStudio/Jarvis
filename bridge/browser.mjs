import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, basename, extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { PATHS } from './paths.mjs'
import { CHROME as PLATFORM_CHROME } from './platform.mjs'

/**
 * JARVIS's own browser: a real Chrome window on Salman's desktop.
 *
 * Not Playwright's automation profile — that lands on bot checks and login
 * walls the moment it reaches a council register — and not the Claude-for-
 * Chrome extension, whose socket is a Mac path that never existed on this
 * machine (which is why every browser call failed until now). It is Chrome
 * itself, launched by the bridge with its debugging port open on localhost and
 * its own persistent profile under data\chrome, so Salman signs into a site
 * once in the "JARVIS" window and the session is kept. Driven over the
 * DevTools protocol through playwright-core's connectOverCDP, which adds no
 * automation flags: to the sites it visits it is a person's browser.
 *
 * Boundaries, enforced here rather than left to the model:
 *   - http(s) only, and never localhost or the private network (the NAS has a
 *     web admin; a browser is not the way JARVIS should ever reach it);
 *   - it never types into a password field, never attempts a human check —
 *     both are Salman's, in the window, by hand;
 *   - anything saved goes to INBOX\Downloads, nowhere else;
 *   - the port listens on 127.0.0.1 only; nothing is exposed off the machine.
 */

const HERE = dirname(fileURLToPath(import.meta.url))
const PORT = Number(process.env.JARVIS_CHROME_PORT ?? 9333)
// OUTSIDE the project folder: Vite watches the project for changes, and
// Chrome keeps its profile files locked — a watcher on them dies with EBUSY
// and takes the face down with it (seen 1 Oct 2026).
const PROFILE = process.env.JARVIS_CHROME_PROFILE ?? join(PATHS.inbox, '..', 'JARVIS BROWSER', 'profile')
const CHROME = PLATFORM_CHROME
export const DOWNLOADS = join(PATHS.inbox, 'Downloads')
const SHOTS = join(tmpdir(), 'jarvis-browser')
const ACTION_MS = 20_000

// ---------------------------------------------------------------- pure

const PRIVATE_HOST = /^(localhost|0\.0\.0\.0|\[::1\]|::1|.*\.local|.*\.localhost)$|^(10|127|192\.168|169\.254|172\.(1[6-9]|2\d|3[01]))\./i

/** A URL JARVIS may open: http(s), on the public internet. Bare domains get https. */
export function vetUrl(raw) {
  let s = String(raw ?? '').trim()
  if (!s) return { error: 'no address given' }
  if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) s = `https://${s}`
  let u
  try {
    u = new URL(s)
  } catch {
    return { error: `"${raw}" is not a web address` }
  }
  if (!/^https?:$/.test(u.protocol)) return { error: `only http and https pages can be opened (not ${u.protocol.replace(':', '')})` }
  if (PRIVATE_HOST.test(u.hostname)) return { error: 'that address is on the local network, which the browser does not visit' }
  return { ok: true, url: u.href }
}

export const HUMAN_CHECK = /captcha|verify (that )?you are (a )?human|i'?m not a robot|are you a robot|unusual traffic|access denied|cloudflare|just a moment/i

/** What to tell the model about a page besides its words. */
export function pageNotes({ text = '', refs = [] } = {}) {
  const notes = []
  if (HUMAN_CHECK.test(text)) notes.push('There is a human check on this page. Never attempt it: ask Salman to complete it in the JARVIS Chrome window, then read the page again.')
  if (refs.some((r) => r.password)) notes.push('This page asks for a password. Never type one: ask Salman to sign in in the JARVIS Chrome window, then read the page again.')
  return notes
}

const safeName = (s) => String(s ?? '').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 120) || 'download'

// ---------------------------------------------------------------- chrome

let browser = null
let context = null
let current = null
let launching = null

async function alive() {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/json/version`, { signal: AbortSignal.timeout(1500) })
    return r.ok
  } catch {
    return false
  }
}

async function launch(log) {
  if (!existsSync(CHROME)) throw new Error(`Chrome is not at ${CHROME} (set JARVIS_CHROME_EXE)`)
  mkdirSync(PROFILE, { recursive: true })
  mkdirSync(DOWNLOADS, { recursive: true })
  const child = spawn(
    CHROME,
    [
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${PROFILE}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--window-size=1400,1000',
      '--disable-session-crashed-bubble',
      'about:blank',
    ],
    { detached: true, stdio: 'ignore', windowsHide: false },
  )
  child.unref()
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 400))
    if (await alive()) {
      log?.(`[jarvis:browser] Chrome launched on 127.0.0.1:${PORT}, profile ${PROFILE}`)
      return
    }
  }
  throw new Error('Chrome started but its debugging port never answered')
}

/** The connected browser context, launching Chrome if it is not running. */
export async function ensureBrowser(log = console.log) {
  if (browser?.isConnected() && context) return context
  if (launching) return launching
  launching = (async () => {
    try {
      if (!(await alive())) await launch(log)
      const { chromium } = await import('playwright-core')
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`, { timeout: 15_000 })
      browser.on('disconnected', () => {
        browser = null
        context = null
        current = null
      })
      context = browser.contexts()[0] ?? (await browser.newContext())
      context.setDefaultTimeout(ACTION_MS)
      // Downloads land in INBOX\Downloads, nowhere else.
      try {
        const cdp = await browser.newBrowserCDPSession()
        await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: DOWNLOADS, eventsEnabled: true })
      } catch {}
      return context
    } finally {
      launching = null
    }
  })()
  return launching
}

const isUserPage = (p) => /^(https?:|about:blank)/.test(p.url())

async function page() {
  const ctx = await ensureBrowser()
  if (current && !current.isClosed()) return current
  const pages = ctx.pages().filter(isUserPage)
  current = pages[pages.length - 1] ?? (await ctx.newPage())
  return current
}

async function settle(p) {
  await p.waitForLoadState('domcontentloaded', { timeout: 15_000 }).catch(() => {})
  // Register searches fetch their results after the click; reading before the
  // network goes quiet shows a page with a spinner and no results.
  await p.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => {})
  await p.waitForTimeout(500)
}

/** Words and controls of the page. Refs are stamped onto the elements so clicks can find them. */
export async function snapshot(p, { maxText = 7000 } = {}) {
  const data = await p.evaluate((max) => {
    const vis = (el) => {
      const r = el.getBoundingClientRect()
      const s = getComputedStyle(el)
      return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'
    }
    const els = [...document.querySelectorAll('a[href], button, input, select, textarea, [role="button"], [role="link"], [role="tab"], [role="menuitem"], summary')].filter(vis)
    const refs = []
    els.forEach((el, i) => {
      const ref = `e${i + 1}`
      el.setAttribute('data-jarvis-ref', ref)
      const tag = el.tagName.toLowerCase()
      const type = (el.getAttribute('type') || '').toLowerCase()
      const label = (el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('alt') || el.getAttribute('name') || '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 80)
      const kind = tag === 'a' ? 'link' : tag === 'input' ? type || 'text' : tag === 'select' ? 'select' : tag === 'textarea' ? 'textarea' : 'button'
      let href = tag === 'a' ? el.getAttribute('href') : null
      if (href && href.length > 140) href = `${href.slice(0, 137)}…`
      refs.push({ ref, kind, label, href, password: type === 'password' })
    })
    const main = document.querySelector('main, article, [role="main"]') || document.body
    const text = (main.innerText || '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
    return { title: document.title, url: location.href, text: text.slice(0, max), truncated: text.length > max, refs: refs.slice(0, 160), total: refs.length }
  }, maxText)
  return data
}

function describe(s) {
  const lines = [`${s.title || '(no title)'} — ${s.url}`]
  // The one line a register page is read for, put where it cannot be missed.
  const count = /\b(\d+)\s+results?\b/i.exec(s.text)
  if (/no results found|no records? (were )?found|0 results|nothing found|no matching/i.test(s.text)) {
    lines.push('RESULT: the page says NO RESULTS. Try the search ONCE more a different way (postcode, or street name only); if that also finds nothing, report that there are no applications listed for the address and stop.')
  } else if (count) lines.push(`RESULT: the page reports ${count[1]} result(s).`)
  lines.push('', s.text || '(no visible text)')
  if (s.truncated) lines.push('…(page text trimmed)')
  const notes = pageNotes(s)
  if (notes.length) lines.push('', ...notes.map((n) => `NOTE: ${n}`))
  if (s.refs.length) {
    lines.push('', `Controls (${s.total}${s.total > s.refs.length ? `, first ${s.refs.length}` : ''}) — use the ref with browser_click / browser_type:`)
    for (const r of s.refs) lines.push(`  [${r.ref}] ${r.kind}${r.label ? ` "${r.label}"` : ''}${r.href ? ` → ${r.href}` : ''}`)
  }
  return lines.join('\n')
}

const locator = (p, ref) => p.locator(`[data-jarvis-ref="${String(ref).trim()}"]`).first()

async function shot(p) {
  mkdirSync(SHOTS, { recursive: true })
  const file = join(SHOTS, `shot-${Date.now()}.png`)
  const buf = await p.screenshot({ type: 'png', scale: 'css' })
  writeFileSync(file, buf)
  return { file, buf }
}

const fail = (text) => ({ isError: true, content: [{ type: 'text', text }] })
const ok = (text) => ({ content: [{ type: 'text', text }] })

/**
 * Run an action against the current page, reconnecting once if the window
 * went away, and turning any failure into a plain sentence.
 */
async function act(fn) {
  try {
    return await fn(await page())
  } catch (err) {
    const m = String(err?.message ?? err)
    if (/closed|disconnected|Target page|crashed/i.test(m)) {
      current = null
      browser = null
      context = null
      try {
        return await fn(await page())
      } catch (err2) {
        return fail(`The browser window could not be used: ${String(err2?.message ?? err2).split('\n')[0]}. Say so.`)
      }
    }
    return fail(`That did not work: ${m.split('\n')[0]}. Read the page again before trying something else.`)
  }
}

export async function browserStatus() {
  return { port: PORT, running: await alive(), profile: PROFILE, chrome: existsSync(CHROME) }
}

// ---------------------------------------------------------------- tools

export function browserServer({ log = console.log } = {}) {
  return createSdkMcpServer({
    name: 'jarvis_browser',
    version: '1.0.0',
    instructions:
      "JARVIS's own Chrome window on Salman's desktop — signed-in sessions kept. browser_open a page, browser_read its words and controls, " +
      'browser_click / browser_type by ref, browser_screenshot to SEE it, browser_save to keep a document in INBOX\\Downloads. ' +
      'Never type passwords or attempt human checks: ask Salman to do those in the window.',
    alwaysLoad: true,
    tools: [
      tool(
        'browser_open',
        'Open a web page in the JARVIS Chrome window and return its words and controls. Public http(s) sites only. ' +
          'For council planning registers that have no API (Hounslow, Richmond and the like), this is the way in.',
        { url: z.string().min(3) },
        async (a) => {
          const v = vetUrl(a.url)
          if (!v.ok) return fail(`Not opened: ${v.error}.`)
          return act(async (p) => {
            await p.goto(v.url, { waitUntil: 'domcontentloaded', timeout: 30_000 })
            await settle(p)
            await p.bringToFront().catch(() => {})
            return ok(describe(await snapshot(p)))
          })
        },
      ),
      tool('browser_read', 'The current page again: its words and controls, with fresh refs. Use after anything changes.', {}, async () =>
        act(async (p) => ok(describe(await snapshot(p)))),
      ),
      tool(
        'browser_find',
        'Controls on the current page whose label, placeholder or link contains this text — quicker than reading everything.',
        { text: z.string().min(1) },
        async (a) =>
          act(async (p) => {
            const s = await snapshot(p, { maxText: 0 })
            const q = a.text.toLowerCase()
            const hits = s.refs.filter((r) => `${r.label} ${r.href ?? ''}`.toLowerCase().includes(q))
            return ok(hits.length ? hits.map((r) => `[${r.ref}] ${r.kind}${r.label ? ` "${r.label}"` : ''}${r.href ? ` → ${r.href}` : ''}`).join('\n') : `Nothing on the page matches "${a.text}".`)
          }),
      ),
      tool(
        'browser_click',
        'Click a control by its ref (from browser_open / browser_read / browser_find). If it starts a download, the file is saved to INBOX\\Downloads and the path returned.',
        { ref: z.string().min(2) },
        async (a) =>
          act(async (p) => {
            const dl = p.waitForEvent('download', { timeout: 2500 }).catch(() => null)
            await locator(p, a.ref).click({ timeout: ACTION_MS })
            const d = await dl
            if (d) {
              mkdirSync(DOWNLOADS, { recursive: true })
              const file = join(DOWNLOADS, `${new Date().toISOString().slice(0, 10)} ${safeName(d.suggestedFilename())}`)
              await d.saveAs(file)
              return ok(`Downloaded to ${file}. Read it with read_planning_document if it is a PDF.`)
            }
            await settle(p)
            return ok(describe(await snapshot(p)))
          }),
      ),
      tool(
        'browser_type',
        'Type into a field by ref (replacing what is there). submit: true presses Enter afterwards. Never used for passwords.',
        { ref: z.string().min(2), text: z.string(), submit: z.boolean().optional().catch(undefined) },
        async (a) =>
          act(async (p) => {
            const l = locator(p, a.ref)
            const type = ((await l.getAttribute('type')) ?? '').toLowerCase()
            if (type === 'password') return fail('Not typed: that is a password field. Ask Salman to sign in in the JARVIS Chrome window.')
            await l.fill(a.text, { timeout: ACTION_MS })
            if (a.submit) {
              await l.press('Enter')
              await settle(p)
            }
            return ok(a.submit ? describe(await snapshot(p)) : `Typed into ${a.ref}.`)
          }),
      ),
      tool('browser_select', 'Choose an option in a dropdown by ref — by its visible text or value.', { ref: z.string().min(2), option: z.string() }, async (a) =>
        act(async (p) => {
          const l = locator(p, a.ref)
          try {
            await l.selectOption({ label: a.option })
          } catch {
            await l.selectOption(a.option)
          }
          await settle(p)
          return ok(`Selected "${a.option}".`)
        }),
      ),
      tool('browser_press', 'Press a key on the page: Enter, Escape, Tab, PageDown, ArrowDown…', { key: z.string().min(1) }, async (a) =>
        act(async (p) => {
          await p.keyboard.press(a.key)
          await settle(p)
          return ok(describe(await snapshot(p)))
        }),
      ),
      tool('browser_scroll', 'Scroll the page down or up (one screen) and read it again.', { direction: z.enum(['down', 'up']).optional().catch('down') }, async (a) =>
        act(async (p) => {
          await p.mouse.wheel(0, a.direction === 'up' ? -800 : 800)
          await p.waitForTimeout(400)
          return ok(describe(await snapshot(p)))
        }),
      ),
      tool(
        'browser_wait',
        'Wait a few seconds for a slow page (a spinner, results still loading), then read it again. Up to 20 seconds. ' +
          'If a site keeps spinning after two waits it is probably throttling you: stop, tell Salman, and try later rather than repeating the search.',
        { seconds: z.union([z.number(), z.string()]).optional().catch(undefined) },
        async (a) =>
          act(async (p) => {
            await p.waitForTimeout(Math.min(20, Math.max(1, Number(a.seconds) || 5)) * 1000)
            return ok(describe(await snapshot(p)))
          }),
      ),
      tool('browser_back', 'Go back one page.', {}, async () =>
        act(async (p) => {
          await p.goBack({ waitUntil: 'domcontentloaded', timeout: 20_000 }).catch(() => {})
          await settle(p)
          return ok(describe(await snapshot(p)))
        }),
      ),
      tool(
        'browser_screenshot',
        'SEE the current page: returns a picture of it. Use when the words are not enough — a map, a drawing, a layout, a form that is not behaving.',
        {},
        async () =>
          act(async (p) => {
            const { file, buf } = await shot(p)
            return { content: [{ type: 'text', text: `Screenshot of "${await p.title()}" (${p.url()}), saved at ${file}.` }, { type: 'image', data: buf.toString('base64'), mimeType: 'image/png' }] }
          }),
      ),
      tool(
        'browser_save',
        "Save a document into INBOX\\Downloads using the browser's own session — a PDF link on a council register, an officer report behind a login. " +
          'url: the document link (defaults to the current page). Returns the saved path; read PDFs with read_planning_document.',
        { url: z.string().optional().catch(undefined), name: z.string().optional().catch(undefined) },
        async (a) =>
          act(async (p) => {
            const target = a.url ? vetUrl(a.url) : { ok: true, url: p.url() }
            if (!target.ok) return fail(`Not saved: ${target.error}.`)
            const got = await p.evaluate(async (u) => {
              const r = await fetch(u, { credentials: 'include' })
              if (!r.ok) return { error: `${r.status}` }
              const b = await r.arrayBuffer()
              let s = ''
              const bytes = new Uint8Array(b)
              for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000))
              return { type: r.headers.get('content-type') || '', b64: btoa(s), name: (r.headers.get('content-disposition') || '').match(/filename\*?=(?:UTF-8'')?"?([^";]+)/i)?.[1] || '' }
            }, target.url)
            if (got.error) return fail(`The document could not be fetched (HTTP ${got.error}).`)
            const buf = Buffer.from(got.b64, 'base64')
            if (buf.length > 60 * 1024 * 1024) return fail('That file is over 60 MB.')
            const fromUrl = decodeURIComponent(basename(new URL(target.url).pathname) || '')
            let name = safeName(a.name || got.name || fromUrl || 'document')
            const isPdf = buf.subarray(0, 5).toString() === '%PDF-' || /pdf/i.test(got.type)
            if (isPdf && extname(name).toLowerCase() !== '.pdf') name = `${name.replace(/\.[a-z0-9]{1,5}$/i, '')}.pdf`
            if (!isPdf && /text\/html/i.test(got.type)) return fail('That link returned a web page, not a document — it may need a login or a human check in the JARVIS Chrome window first.')
            mkdirSync(DOWNLOADS, { recursive: true })
            let file = join(DOWNLOADS, `${new Date().toISOString().slice(0, 10)} ${name}`)
            for (let i = 2; existsSync(file); i++) file = join(DOWNLOADS, `${new Date().toISOString().slice(0, 10)} ${name.replace(/(\.[^.]+)?$/, ` (${i})$1`)}`)
            writeFileSync(file, buf)
            return ok(`Saved ${(buf.length / 1024).toFixed(0)} KB to ${file}.${isPdf ? ' Read it with read_planning_document.' : ''}`)
          }),
      ),
      tool('browser_tabs', 'List the open tabs, or switch to one by number.', { switch_to: z.union([z.number(), z.string()]).optional().catch(undefined) }, async (a) =>
        act(async () => {
          const ctx = await ensureBrowser(log)
          const pages = ctx.pages().filter(isUserPage)
          if (a.switch_to != null && a.switch_to !== '') {
            const n = Number(a.switch_to)
            const p = pages[n - 1]
            if (!p) return fail(`There is no tab ${a.switch_to}.`)
            current = p
            await p.bringToFront().catch(() => {})
            return ok(describe(await snapshot(p)))
          }
          return ok(pages.length ? pages.map((p, i) => `${i + 1}. ${p === current ? '• ' : ''}${p.url()}`).join('\n') : 'No tabs open.')
        }),
      ),
    ],
  })
}
