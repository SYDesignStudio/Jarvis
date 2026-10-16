/**
 * Apps JARVIS builds for Salman — dashboards, calculators, trackers, tools —
 * that live inside JARVIS and keep working after the conversation ends.
 *
 * An app is a folder under JARVIS APPS in the shared work folder (so the PC
 * and the MacBook see the same apps): index.html plus whatever small files it
 * wants, an app.json manifest, a state.json the app may save to, and a short
 * history of earlier versions so a bad edit can be undone. JARVIS writes them
 * with the jarvis_apps tools; the face shows them in a blade.
 *
 * Safety is in the frame, not in trust. An app runs in a sandboxed iframe
 * with an opaque origin and a CSP that forbids network connections, so it can
 * reach neither the agent socket nor the internet. Everything it needs comes
 * through one postMessage channel to the face — window.JARVIS, injected into
 * every app as it is served — and the face fetches on its behalf: live data
 * (the tracker, Specline, jobs, knowledge, chats), its own files, its saved
 * state, and a way to hand JARVIS a request as if Salman had typed it.
 */
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WORK_ROOT } from '../paths.mjs'

export const APPS_ROOT = process.env.JARVIS_APPS_DIR ?? join(WORK_ROOT, 'JARVIS APPS')

const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/
const FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,60}\.(html|css|js|json|svg|csv|md|txt)$/i
const MAX_FILE = 2 * 1024 * 1024
const MAX_HISTORY = 12
const RESERVED = new Set(['manifest', 'state', 'delete', 'history', '_trash'])

const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.csv': 'text/csv; charset=utf-8', '.md': 'text/markdown; charset=utf-8', '.txt': 'text/plain; charset=utf-8' }

export const slugify = (name) =>
  String(name ?? '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '')

export const validSlug = (s) => SLUG.test(s) && !RESERVED.has(s)
export const validFile = (f) => FILE.test(f) && !f.includes('..') && !RESERVED.has(f.replace(/\.[^.]+$/, ''))

const here = dirname(fileURLToPath(import.meta.url))
export const BASE_CSS = readFileSync(join(here, 'base.css'), 'utf8')

/**
 * window.JARVIS — the only way out of the sandbox, and it goes to the face.
 * Plain ES5 so it runs in whatever the app does; every call is a promise.
 */
export const SDK_JS = `(function(){
  var q = new Map(), n = 0, onRefresh = []
  function call(op, p) {
    return new Promise(function (res, rej) {
      var id = ++n; q.set(id, [res, rej])
      parent.postMessage(Object.assign({ jarvis: 'call', id: id, op: op }, p || {}), '*')
    })
  }
  addEventListener('message', function (e) {
    var m = e.data; if (!m || typeof m !== 'object') return
    if (m.jarvis === 'reply') { var p = q.get(m.id); if (!p) return; q.delete(m.id); m.error ? p[1](new Error(m.error)) : p[0](m.result) }
    else if (m.jarvis === 'refresh') { onRefresh.forEach(function (f) { try { f() } catch (err) { console.error(err) } }) }
    else if (m.jarvis === 'theme') { var r = document.documentElement.style; if (m.interface) r.setProperty('--interface', m.interface); if (m.bg) r.setProperty('--bg', m.bg) }
  })
  window.JARVIS = {
    data: function (source) { return call('data', { source: source }) },
    file: function (name) { return call('file', { file: name }) },
    state: { get: function () { return call('state.get') }, set: function (v) { return call('state.set', { value: v }) } },
    ask: function (text) { return call('ask', { text: text }) },
    open: function (slug) { return call('open', { slug: slug }) },
    onRefresh: function (f) { onRefresh.push(f) }
  }
})()`

/** The CSP every app document is served under: no connections, scripts from here and a few CDNs. */
export function cspFor(selfOrigins = []) {
  const self = ["'self'", ...selfOrigins].join(' ')
  const cdns = 'https://cdn.jsdelivr.net https://cdnjs.cloudflare.com https://unpkg.com'
  return [
    "default-src 'none'",
    `script-src ${self} 'unsafe-inline' 'unsafe-eval' ${cdns}`,
    `style-src ${self} 'unsafe-inline' https://fonts.googleapis.com ${cdns}`,
    `font-src ${self} https://fonts.gstatic.com data:`,
    `img-src ${self} data: blob: https:`,
    `media-src ${self} https:`,
    "connect-src 'none'",
    "frame-ancestors 'self' http://localhost:* http://127.0.0.1:* https://*.ts.net",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ')
}

/** The served document: the app's own HTML with the SDK and the base stylesheet put in. */
export function injectSdk(html) {
  const head = `<link rel="stylesheet" href="../base.css"><script>${SDK_JS}</script>`
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, (m) => `${m}${head}`)
  if (/<html[^>]*>/i.test(html)) return html.replace(/<html[^>]*>/i, (m) => `${m}<head>${head}</head>`)
  return `<!doctype html><html><head><meta charset="utf-8">${head}</head><body>${html}</body></html>`
}

const readJson = (p, fallback) => {
  try {
    return JSON.parse(readFileSync(p, 'utf8'))
  } catch {
    return fallback
  }
}

export function createApps({ root = APPS_ROOT, now = () => new Date() } = {}) {
  mkdirSync(root, { recursive: true })
  const dir = (slug) => join(root, slug)
  const manifestOf = (slug) => readJson(join(dir(slug), 'app.json'), null)
  const stamp = () => now().toISOString()

  function list() {
    let names = []
    try {
      names = readdirSync(root, { withFileTypes: true })
        .filter((d) => d.isDirectory() && validSlug(d.name))
        .map((d) => d.name)
    } catch {
      return []
    }
    return names
      .map((slug) => manifestOf(slug))
      .filter(Boolean)
      .sort((a, b) => String(b.updated).localeCompare(String(a.updated)))
  }

  function files(slug) {
    const d = dir(slug)
    if (!existsSync(d)) return null
    const out = {}
    for (const f of readdirSync(d)) {
      if (validFile(f) && f !== 'app.json' && f !== 'state.json') out[f] = readFileSync(join(d, f), 'utf8')
    }
    return out
  }

  function get(slug) {
    const m = manifestOf(slug)
    return m ? { ...m, files: files(slug) } : null
  }

  /** Copy the current files aside before they change; keep the last few. */
  function snapshot(slug) {
    const d = dir(slug)
    const h = join(d, 'history')
    const current = files(slug)
    if (!current || !Object.keys(current).length) return
    const at = stamp().replace(/[:.]/g, '-')
    mkdirSync(join(h, at), { recursive: true })
    for (const [f, body] of Object.entries(current)) writeFileSync(join(h, at, f), body)
    const m = manifestOf(slug)
    if (m) writeFileSync(join(h, at, 'app.json'), JSON.stringify(m, null, 2))
    const entries = readdirSync(h).sort()
    while (entries.length > MAX_HISTORY) rmSync(join(h, entries.shift()), { recursive: true, force: true })
  }

  function write({ slug, name, description = '', files: incoming = {} }) {
    const s = validSlug(slug ?? '') ? slug : slugify(slug || name)
    if (!validSlug(s)) throw new Error(`"${slug ?? name}" does not make a usable app name — letters, numbers and dashes`)
    const html = incoming['index.html']
    const existing = manifestOf(s)
    if (!existing && typeof html !== 'string') throw new Error('a new app needs an index.html')
    for (const [f, body] of Object.entries(incoming)) {
      if (!validFile(f)) throw new Error(`"${f}" is not an allowed file name (html, css, js, json, svg, csv, md, txt; no folders)`)
      if (typeof body !== 'string') throw new Error(`${f} must be text`)
      if (Buffer.byteLength(body) > MAX_FILE) throw new Error(`${f} is over 2 MB`)
    }
    if (typeof html === 'string' && !/<[a-z][\s\S]*>/i.test(html)) throw new Error('index.html has no markup in it')
    if (existing) snapshot(s)
    mkdirSync(dir(s), { recursive: true })
    for (const [f, body] of Object.entries(incoming)) writeFileSync(join(dir(s), f), body)
    const manifest = {
      slug: s,
      name: String(name ?? existing?.name ?? s).trim() || s,
      description: String(description || existing?.description || '').trim(),
      created: existing?.created ?? stamp(),
      updated: stamp(),
      version: (existing?.version ?? 0) + 1,
    }
    writeFileSync(join(dir(s), 'app.json'), JSON.stringify(manifest, null, 2))
    return manifest
  }

  function patch({ slug, file = 'index.html', find, replace, all = false }) {
    if (!validSlug(slug) || !manifestOf(slug)) throw new Error(`no app called "${slug}"`)
    if (!validFile(file)) throw new Error(`"${file}" is not an allowed file name`)
    const p = join(dir(slug), file)
    if (!existsSync(p)) throw new Error(`${slug} has no ${file}`)
    const body = readFileSync(p, 'utf8')
    const needle = String(find ?? '')
    if (!needle) throw new Error('nothing to find')
    const hits = body.split(needle).length - 1
    if (!hits) throw new Error(`"${needle.slice(0, 60)}" is not in ${file} — read the app first and copy the text exactly`)
    if (hits > 1 && !all) throw new Error(`"${needle.slice(0, 60)}" appears ${hits} times in ${file} — include more of the surrounding text, or pass all: true`)
    snapshot(slug)
    const next = all ? body.split(needle).join(String(replace ?? '')) : body.replace(needle, () => String(replace ?? ''))
    writeFileSync(p, next)
    const m = manifestOf(slug)
    m.updated = stamp()
    m.version += 1
    writeFileSync(join(dir(slug), 'app.json'), JSON.stringify(m, null, 2))
    return { ...m, replaced: all ? hits : 1 }
  }

  function undo(slug) {
    if (!validSlug(slug) || !manifestOf(slug)) throw new Error(`no app called "${slug}"`)
    const h = join(dir(slug), 'history')
    const entries = existsSync(h) ? readdirSync(h).sort() : []
    if (!entries.length) throw new Error(`${slug} has no earlier version to go back to`)
    const last = join(h, entries[entries.length - 1])
    const before = manifestOf(slug)
    for (const f of Object.keys(files(slug) ?? {})) rmSync(join(dir(slug), f), { force: true })
    for (const f of readdirSync(last)) cpSync(join(last, f), join(dir(slug), f))
    rmSync(last, { recursive: true, force: true })
    // The files go back; the version number keeps counting, so an open blade
    // and the other machine both see this as a newer state, not an older one.
    const m = { ...manifestOf(slug), version: before.version + 1, updated: stamp() }
    writeFileSync(join(dir(slug), 'app.json'), JSON.stringify(m, null, 2))
    return m
  }

  function remove(slug) {
    if (!validSlug(slug) || !manifestOf(slug)) throw new Error(`no app called "${slug}"`)
    const trash = join(root, '_trash')
    mkdirSync(trash, { recursive: true })
    renameSync(dir(slug), join(trash, `${slug}-${stamp().replace(/[:.]/g, '-')}`))
    return true
  }

  const state = (slug) => (validSlug(slug) ? readJson(join(dir(slug), 'state.json'), null) : null)
  function setState(slug, value) {
    if (!validSlug(slug) || !manifestOf(slug)) throw new Error(`no app called "${slug}"`)
    const body = JSON.stringify(value ?? null)
    if (Buffer.byteLength(body) > MAX_FILE) throw new Error('state is over 2 MB')
    writeFileSync(join(dir(slug), 'state.json'), body)
    return true
  }

  /** One file of an app, with its content type — or null. */
  function file(slug, name) {
    if (!validSlug(slug) || !validFile(name) || name === 'app.json' || name === 'state.json') return null
    const p = join(dir(slug), name)
    try {
      if (!statSync(p).isFile()) return null
      return { body: readFileSync(p), type: TYPES[extname(name).toLowerCase()] ?? 'application/octet-stream' }
    } catch {
      return null
    }
  }

  return { root, list, get, files, write, patch, undo, remove, state, setState, file, manifest: manifestOf }
}

// ---------------------------------------------------------------- the tools

const DESCRIPTION_WRITE = `Create an app, or replace its files wholesale. An app is a self-contained
web page that lives inside JARVIS and keeps working: a dashboard, a calculator,
a checklist, a tool. Give it index.html (complete, with its own <style> and
<script>) and any small extra files (a data.json you computed, an app.js).

Inside the page, window.JARVIS is already there (do not add it):
  JARVIS.data('tracker' | 'specline' | 'jobs' | 'knowledge' | 'chats' | 'apps')  → live JSON
  JARVIS.file('data.json')          → one of the app's own files (JSON parsed)
  JARVIS.state.get() / .set(value)  → the app's saved state, shared PC and Mac
  JARVIS.ask('chase 25/0941')       → hands JARVIS a request as if Salman typed it
  JARVIS.open('other-app')          → opens another app
  JARVIS.onRefresh(fn)              → called when the app's files change
It cannot fetch the internet or the bridge directly; data comes through those
calls. Scripts and styles may load from cdn.jsdelivr.net, cdnjs or unpkg
(Chart.js: https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.js).
The base stylesheet is loaded for you: --interface, --bg, --ink, --dim,
--line, --hold, --fail, --pass, and classes .ap-grid .ap-card .ap-stat
.ap-table .ap-h .ap-note .ap-btn, in JARVIS's own dark cyan look.

For a small change to an existing app use app_patch instead — this replaces
every file you pass. The app opens on screen when written unless open:false.`

export function appsServer({ apps, openApp = null, notify = null } = {}) {
  const text = (t) => ({ content: [{ type: 'text', text: t }] })
  const fail = (t) => ({ isError: true, content: [{ type: 'text', text: t }] })
  const line = (m) => `${m.name} (${m.slug}) v${m.version} — ${m.description || 'no description'} — updated ${m.updated.slice(0, 16).replace('T', ' ')}`
  return createSdkMcpServer({
    name: 'jarvis_apps',
    version: '1.0.0',
    instructions: 'Apps JARVIS has built for Salman, living inside JARVIS: list, read, write, patch, open, undo, delete.',
    tools: [
      tool('app_list', 'The apps that exist: name, slug, description, version, last updated.', {}, async () => {
        const all = apps.list()
        return text(all.length ? all.map(line).join('\n') : 'No apps yet.')
      }),
      tool('app_read', 'Read an app: its manifest and the full text of every file, so you can change it with app_patch.', { slug: z.string().describe('The app slug, from app_list.') }, async ({ slug }) => {
        const a = apps.get(slug)
        if (!a) return fail(`No app called "${slug}". app_list shows what exists.`)
        return text(`${line(a)}\n\n` + Object.entries(a.files ?? {}).map(([f, body]) => `===== ${f} (${body.length} chars)\n${body}`).join('\n\n'))
      }),
      tool(
        'app_write',
        DESCRIPTION_WRITE,
        {
          slug: z.string().optional().describe('Short id, letters/numbers/dashes, e.g. "fees-dashboard". Omit to derive from the name.'),
          name: z.string().describe('What Salman will see it called, e.g. "Fees dashboard".'),
          description: z.string().optional().describe('One line on what it shows or does.'),
          files: z.record(z.string(), z.string()).describe('File name → full text. index.html is required for a new app.'),
          open: z.boolean().optional().describe('Put it on screen now (default true).'),
        },
        async ({ slug, name, description, files, open = true }) => {
          try {
            const m = apps.write({ slug, name, description, files })
            notify?.(m.slug)
            if (open) openApp?.(m.slug, m.name)
            return text(`Written: ${line(m)}.${open && openApp ? ' On screen.' : ''}`)
          } catch (err) {
            return fail(`Not written: ${err.message}`)
          }
        },
      ),
      tool(
        'app_patch',
        'Change part of an app file: replace one exact piece of text with another. Read the app first (app_read) and copy the text to find exactly. The previous version is kept for app_undo.',
        {
          slug: z.string(),
          file: z.string().optional().describe('Default index.html.'),
          find: z.string().describe('The exact text to replace. Must occur once unless all is true.'),
          replace: z.string().describe('What to put there instead.'),
          all: z.boolean().optional().describe('Replace every occurrence.'),
        },
        async (args) => {
          try {
            const m = apps.patch(args)
            notify?.(m.slug)
            return text(`Patched ${args.file ?? 'index.html'} in ${m.name} (${m.replaced} replacement${m.replaced === 1 ? '' : 's'}); now v${m.version}. The open blade refreshes itself.`)
          } catch (err) {
            return fail(`Not patched: ${err.message}`)
          }
        },
      ),
      tool('app_open', 'Put an app on screen.', { slug: z.string() }, async ({ slug }) => {
        const m = apps.manifest(slug)
        if (!m) return fail(`No app called "${slug}".`)
        if (!openApp) return text(`${m.name} is at the desk — it opens on the JARVIS screen, not here.`)
        openApp(m.slug, m.name)
        return text(`${m.name} is on screen.`)
      }),
      tool('app_undo', 'Go back to the version before the last app_write or app_patch.', { slug: z.string() }, async ({ slug }) => {
        try {
          const m = apps.undo(slug)
          notify?.(m.slug)
          return text(`${m.name} is back to its previous version.`)
        } catch (err) {
          return fail(err.message)
        }
      }),
      tool('app_delete', "Remove an app (it goes to the apps folder's _trash, not gone for good). Only on Salman's word.", { slug: z.string() }, async ({ slug }) => {
        try {
          const m = apps.manifest(slug)
          apps.remove(slug)
          notify?.(slug)
          return text(`${m?.name ?? slug} removed.`)
        } catch (err) {
          return fail(err.message)
        }
      }),
    ],
  })
}

// ---------------------------------------------------------------- the routes

/**
 * Everything under /apps. Returns true when the request was handled.
 *   GET  /apps                   the list (the Apps panel)
 *   GET  /apps/base.css          the shared stylesheet
 *   GET  /apps/data/<source>     live data, fetched by the face for an app
 *   GET  /apps/<slug>/           the app document, SDK injected, under CSP
 *   GET  /apps/<slug>/<file>     one of its files (scripts, images, data)
 *   GET  /apps/<slug>/manifest   for the blade's own refresh check
 *   GET/POST /apps/<slug>/state  the app's saved state (POST from the page only)
 *   POST /apps/<slug>/delete     the Remove button on the Apps panel
 */
export async function appsRoutes(req, res, { apps, cors, readRaw, data, selfOrigins = () => [] }) {
  const u = new URL(req.url, 'http://x')
  if (u.pathname !== '/apps' && !u.pathname.startsWith('/apps/')) return false
  const reply = (code, body, headers = {}) => {
    res.writeHead(code, { ...cors, 'cache-control': 'no-store', ...headers })
    return res.end(body)
  }
  const json = (code, body) => reply(code, JSON.stringify(body), { 'content-type': 'application/json' })
  try {
    if (u.pathname === '/apps') return json(200, { apps: apps.list() }), true
    if (u.pathname === '/apps/base.css') return reply(200, BASE_CSS, { 'content-type': 'text/css; charset=utf-8' }), true
    if (u.pathname.startsWith('/apps/data/')) {
      const source = decodeURIComponent(u.pathname.slice('/apps/data/'.length))
      const out = await data(source)
      return out === undefined ? json(404, { error: `no data source called "${source}"` }) : json(200, out), true
    }
    const parts = u.pathname.slice('/apps/'.length).split('/').map((s) => decodeURIComponent(s))
    const slug = parts[0]
    const rest = parts.slice(1).join('/')
    if (!validSlug(slug) || !apps.manifest(slug)) return json(404, { error: 'no such app' }), true
    if (rest === '' || rest === 'index.html') {
      if (parts.length === 1) return reply(302, '', { location: `${u.pathname}/` }), true
      const f = apps.file(slug, 'index.html')
      if (!f) return json(404, { error: 'the app has no index.html' }), true
      return reply(200, injectSdk(f.body.toString('utf8')), { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': cspFor(selfOrigins(req)), 'x-content-type-options': 'nosniff' }), true
    }
    if (rest === 'favicon.ico') return reply(204, ''), true // Chrome asks for one per document; nothing to say
    if (rest === 'manifest') return json(200, apps.manifest(slug)), true
    if (rest === 'state') {
      if (req.method === 'POST') {
        if (!req.headers.origin) return json(403, { error: 'not from the page' }), true
        const body = (await readRaw(req)).toString('utf8')
        apps.setState(slug, body ? JSON.parse(body) : null)
        return json(200, { ok: true }), true
      }
      return json(200, { state: apps.state(slug) }), true
    }
    if (rest === 'delete' && req.method === 'POST') {
      if (!req.headers.origin) return json(403, { error: 'not from the page' }), true
      apps.remove(slug)
      return json(200, { ok: true }), true
    }
    const f = apps.file(slug, rest)
    if (!f) return json(404, { error: 'no such file' }), true
    return reply(200, f.body, { 'content-type': f.type, 'x-content-type-options': 'nosniff' }), true
  } catch (err) {
    return json(err.status ?? 500, { error: err.message }), true
  }
}
