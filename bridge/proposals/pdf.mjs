import { CHROME_CANDIDATES } from '../platform.mjs'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * HTML → PDF through the machine's own Chrome (or Edge), headless. Chrome
 * honours @page margin boxes, which is how every page gets the company footer
 * and "Page n of m" without a second tool.
 */

const CANDIDATES = CHROME_CANDIDATES

export const browserPath = () => CANDIDATES.find((p) => existsSync(p)) ?? null

/** Pages in a PDF, counted from its page objects. Good enough for a sanity check. */
export const pageCount = (buf) => (buf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) ?? []).length

export async function htmlToPdf(html, outPath) {
  const browser = browserPath()
  if (!browser) throw new Error('no Chrome or Edge found to print the PDF')
  const dir = mkdtempSync(join(tmpdir(), 'jarvis-fp-'))
  const src = join(dir, 'proposal.html')
  writeFileSync(src, html, 'utf8')
  try {
    await new Promise((resolve, reject) => {
      const child = spawn(
        browser,
        [
          '--headless=new',
          '--disable-gpu',
          '--no-first-run',
          '--no-pdf-header-footer',
          `--user-data-dir=${join(dir, 'profile')}`,
          `--print-to-pdf=${outPath}`,
          pathToFileURL(src).href,
        ],
        { windowsHide: true, stdio: 'ignore' },
      )
      const timer = setTimeout(() => {
        child.kill()
        reject(new Error('the PDF printer did not finish in time'))
      }, 60_000)
      child.on('error', (e) => {
        clearTimeout(timer)
        reject(e)
      })
      child.on('exit', () => {
        clearTimeout(timer)
        resolve()
      })
    })
    if (!existsSync(outPath)) throw new Error('the PDF was not written')
    const buf = readFileSync(outPath)
    if (buf.subarray(0, 4).toString() !== '%PDF') throw new Error('the file written is not a PDF')
    return { path: outPath, bytes: buf.length, pages: pageCount(buf) }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
