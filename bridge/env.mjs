/**
 * A local .env.local (and .env), read once, before anything else.
 *
 * This process is spawned directly (`node bridge/server.mjs`), never through a
 * shell that has sourced anything, so nothing outside process.env survives a
 * restart. .env.local is the file .env.example already tells you to create.
 * Real environment variables always win, and .env.local wins over .env,
 * matching Vite's own precedence for the same file names.
 *
 * It lives in its own module, imported first, because ES module imports are
 * evaluated before the importing file's own code: platform.mjs and paths.mjs
 * read process.env the moment they load, and a loader that ran later in
 * server.mjs left JARVIS_SATELLITE, JARVIS_WORK_DIR and friends unread.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export function loadDotenv(name, cwd = process.cwd()) {
  let raw
  try {
    raw = readFileSync(join(cwd, name), 'utf8')
  } catch {
    return
  }
  for (const line of raw.split('\n')) {
    const m = /^\s*([\w.-]+)\s*=\s*(.*?)\s*$/.exec(line)
    if (!m || m[1].startsWith('#')) continue
    const [, key, rawValue] = m
    if (process.env[key] !== undefined) continue
    process.env[key] = rawValue.replace(/^(['"])(.*)\1$/, '$2')
  }
}

loadDotenv('.env')
loadDotenv('.env.local')
