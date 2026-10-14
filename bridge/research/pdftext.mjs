import { spawn } from 'node:child_process'

/**
 * Text out of a PDF with PyMuPDF, which is already on this machine for the
 * Spec Builder. The file is piped in and never executed; scanned pages with
 * no text layer come back empty and are reported as such.
 */
const SCRIPT = `
import sys, json, fitz
data = sys.stdin.buffer.read()
doc = fitz.open(stream=data, filetype="pdf")
pages = [p.get_text() for p in doc]
json.dump({"pages": len(pages), "text": pages}, sys.stdout)
`

export function pdfText(buffer, { python = process.env.JARVIS_PYTHON ?? 'py' } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(python, ['-c', SCRIPT], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    const out = []
    const err = []
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error('reading the PDF took too long'))
    }, 60_000)
    child.stdout.on('data', (d) => out.push(d))
    child.stderr.on('data', (d) => err.push(d))
    child.on('error', (e) => {
      clearTimeout(timer)
      reject(new Error(`PyMuPDF is not available (${e.message})`))
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code !== 0) return reject(new Error(`could not read the PDF: ${Buffer.concat(err).toString().trim().split('\n').pop()}`))
      try {
        const r = JSON.parse(Buffer.concat(out).toString('utf8'))
        const chars = r.text.join('').replace(/\s/g, '').length
        resolve({ pages: r.pages, text: r.text.map((t, i) => `--- page ${i + 1} ---\n${t.trim()}`).join('\n\n'), scanned: chars < r.pages * 40 })
      } catch (e) {
        reject(e)
      }
    })
    child.stdin.end(buffer)
  })
}
