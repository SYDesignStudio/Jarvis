import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, extname } from 'node:path'
import { PATHS } from './paths.mjs'

/**
 * Files handed to JARVIS at the desk — dropped on the page, pasted, or picked
 * with the clip. They land in INBOX\Desk with the day in front, exactly as
 * Telegram documents land in INBOX, and the page tells JARVIS the path so he
 * reads them with the same tools as anything else. Nothing is parsed here:
 * bytes in, file on disk, path back.
 */

export const DESK_DIR = join(PATHS.inbox, 'Desk')
export const MAX_UPLOAD = 50 * 1024 * 1024

const ALLOWED = new Set(['.pdf', '.png', '.jpg', '.jpeg', '.webp', '.heic', '.gif', '.docx', '.doc', '.xlsx', '.xls', '.csv', '.txt', '.md', '.msg', '.eml', '.dwg', '.dxf', '.zip', '.rtf'])

const safe = (s) => String(s ?? '').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 120)

/** Is this something JARVIS should take? Returns { ok, name } or { error }. */
export function vetUpload(name, size) {
  const clean = safe(name)
  const ext = extname(clean).toLowerCase()
  if (!clean || !ext) return { error: 'the file needs a name with an extension' }
  if (!ALLOWED.has(ext)) return { error: `${ext} files are not accepted — PDFs, images, Word, Excel, CAD, text, email and zip are` }
  if (!(size > 0)) return { error: 'the file is empty' }
  if (size > MAX_UPLOAD) return { error: `the file is ${(size / 1048576).toFixed(0)} MB; the limit is ${MAX_UPLOAD / 1048576} MB` }
  return { ok: true, name: clean }
}

/** Save to INBOX\Desk, never overwriting. Returns the path. */
export function saveUpload(name, buffer, { dir = DESK_DIR, when = new Date() } = {}) {
  mkdirSync(dir, { recursive: true })
  const day = when.toISOString().slice(0, 10)
  let path = join(dir, `${day} ${name}`)
  for (let i = 2; existsSync(path); i++) path = join(dir, `${day} ${name.replace(/(\.[^.]+)$/, ` (${i})$1`)}`)
  writeFileSync(path, buffer, { flag: 'wx' })
  return path
}

/** The raw body of a request, capped. Rejects past the cap rather than buffering it all. */
export function readRaw(req, max = MAX_UPLOAD) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (c) => {
      size += c.length
      if (size > max) {
        reject(Object.assign(new Error('too large'), { status: 413 }))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

/** What the page tells JARVIS about the files it attached. */
export function attachmentLines(files) {
  if (!files.length) return ''
  return [
    '',
    ...files.map((f) => `[Attached: "${f.name}" (${f.size >= 1048576 ? `${(f.size / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(f.size / 1024))} KB`}) saved at ${f.path}]`),
    'Read every attached file before answering — read_planning_document for PDFs, Read for images and text; never judge one by its name. ' +
      'If it belongs to a job, copy it into that project\'s documents folder under PROJECTS and note it with project_note (source: "sent by Salman at the desk").',
  ].join('\n')
}
