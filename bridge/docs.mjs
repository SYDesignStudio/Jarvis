import { createReadStream, realpathSync } from 'node:fs'
import { realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve as resolvePath, extname, join } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { WORK_ROOT } from './paths.mjs'
import { LIBRARY_ROOT, NAS_SHARE, IS_WIN } from './platform.mjs'

/**
 * PDFs on the blades — drawings, officer reports, inspection reports.
 *
 * The page cannot read a local file or a NAS share, and the /file route only
 * serves pictures. This serves PDFs, and only PDFs, from the places Salman's
 * documents actually live — JARVIS's own folder, his practice library and the
 * NAS share — after resolving links, with the type pinned to application/pdf
 * and nosniff, so a file dressed up as a PDF can never be run as a page.
 * The page renders it with pdf.js inside the blade (no iframe), which is what
 * lets it zoom, scroll with a hand, and stay inside the page's CSP.
 */

export const DOC_ROOTS = [WORK_ROOT, LIBRARY_ROOT, NAS_SHARE, homedir(), tmpdir(), ...(process.env.JARVIS_DOC_ROOTS ?? '').split(';').map((s) => s.trim()).filter(Boolean)].map(
  (root) => {
    try {
      return realpathSync(root)
    } catch {
      return resolvePath(root)
    }
  },
)

export const MAX_DOC_BYTES = 250 * 1024 * 1024

/** True when `real` sits under one of the roots. Roots are resolved through symlinks
 * the same way the file was (macOS keeps /var as a link to /private/var). */
export const within = (roots, real) =>
  roots.some((root) => {
    let r = root
    try {
      r = realpathSync(root)
    } catch {}
    const rel = relative(r, real)
    return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
  })

/**
 * Whatever the model wrote → a Windows path, or null if it is not local.
 *   file://192.168.0.105/salman_nas/My Work/x.pdf   → \\192.168.0.105\salman_nas\My Work\x.pdf
 *   file:///D:/APP%20DEVLOPMENT/x.pdf               → D:\APP DEVLOPMENT\x.pdf
 *   //192.168.0.105/salman_nas/x.pdf, D:/x.pdf, D:\x.pdf, \\server\share\x.pdf
 */
export function localPathFrom(raw) {
  let s = String(raw ?? '').trim()
  if (!s) return null
  if (/^file:/i.test(s)) {
    s = s.replace(/^file:/i, '')
    try {
      s = decodeURIComponent(s)
    } catch {}
    if (/^\/\/\/[a-z]:/i.test(s)) s = s.slice(3) // file:///D:/…
    else if (/^\/[a-z]:/i.test(s)) s = s.slice(1) // file:/D:/…
    else if (/^\/\/[^/]/.test(s)) s = s // file://server/share/… → //server/share/…
    else return null
  }
  if (/^[a-z]:[\\/]/i.test(s)) return IS_WIN ? s.replace(/\//g, '\\') : null
  if (/^(\\\\|\/\/)[^\\/]+[\\/]/.test(s)) {
    if (IS_WIN) return `\\\\${s.slice(2).replace(/\//g, '\\')}`
    // On the Mac the NAS is a mounted volume: //192.168.0.105/salman_nas/x → /Volumes/salman_nas/x
    const m = /^(?:\\\\|\/\/)[^\\/]+[\\/]([^\\/]+)(.*)$/.exec(s)
    return m ? join('/Volumes', m[1], m[2].replace(/\\/g, '/')) : null
  }
  // A POSIX path on a POSIX machine is already local.
  if (!IS_WIN && s.startsWith('/')) return s
  return null
}

export const isPdfUrl = (raw) => /\.pdf(?:[?#]|$)/i.test(String(raw ?? '')) || /application\/pdf/i.test(String(raw ?? ''))

/** Resolve and vet a requested path. Returns { real, size } or { status, message }. */
export async function vetDoc(asked, roots = DOC_ROOTS) {
  const path = localPathFrom(asked) ?? asked
  let real = null
  try {
    if (isAbsolute(path)) real = await realpath(path)
  } catch {
    return { status: 404, message: 'not found' }
  }
  if (!real || extname(real).toLowerCase() !== '.pdf') return { status: 400, message: 'PDFs only' }
  if (!within(roots, real)) return { status: 403, message: 'outside the document folders' }
  const info = await stat(real).catch(() => null)
  if (!info?.isFile()) return { status: 404, message: 'not found' }
  if (info.size > MAX_DOC_BYTES) return { status: 413, message: 'too large' }
  return { real, size: info.size }
}

/** GET /doc?path=… — stream one vetted PDF. */
export async function serveDoc(req, res, cors) {
  const asked = new URL(req.url, 'http://x').searchParams.get('path') ?? ''
  const v = await vetDoc(asked)
  if (!v.real) {
    res.writeHead(v.status, cors)
    return res.end(v.message)
  }
  res.writeHead(200, {
    ...cors,
    'content-type': 'application/pdf',
    'content-length': v.size,
    'x-content-type-options': 'nosniff',
    'cache-control': 'no-store',
  })
  createReadStream(v.real).on('error', () => res.destroy()).pipe(res)
}
