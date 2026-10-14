import { memo, useCallback, useEffect, useRef, useState } from 'react'
import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

/**
 * A PDF on the blades — drawings, officer reports, inspection reports.
 *
 * Drawn with pdf.js onto canvases inside the blade rather than handed to the
 * browser's viewer in an iframe, for three reasons that each broke the first
 * attempt: a sandboxed iframe will not run Chrome's PDF viewer (the blade
 * came up black), the page CSP does not let the app frame arbitrary file
 * URLs, and the hand controller can only scroll what lives in this document.
 * Here the pages are ordinary children of the blade body, so the mouse wheel
 * and the two-finger gesture scroll them like anything else.
 *
 * Pages are laid out at their true proportions up front and only drawn when
 * they come near the viewport — an A1 building-regs pack is dozens of large
 * sheets, and rasterising all of them at once would stall the voice.
 */

let pdfjsPromise: Promise<typeof import('pdfjs-dist')> | null = null
function pdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = import('pdfjs-dist').then((m) => {
      m.GlobalWorkerOptions.workerSrc = workerUrl
      return m
    })
  }
  return pdfjsPromise
}

/** Canvas pixels are capped: a zoomed A1 sheet at 2x would otherwise ask for 100+ megapixels. */
const MAX_CANVAS_PIXELS = 24_000_000
const ZOOMS = [0.5, 0.75, 1, 1.5, 2, 3, 4]

type Size = { w: number; h: number }

const Page = memo(function Page({ doc, n, base, scale }: { doc: PDFDocumentProxy; n: number; base: Size; scale: number }) {
  const holder = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const [near, near_] = useState(false)
  const w = Math.round(base.w * scale)
  const h = Math.round(base.h * scale)

  useEffect(() => {
    const el = holder.current
    if (!el) return
    const io = new IntersectionObserver(([e]) => near_(e.isIntersecting), { rootMargin: '900px 0px' })
    io.observe(el)
    return () => io.disconnect()
  }, [])

  useEffect(() => {
    if (!near) return
    let task: RenderTask | null = null
    let dead = false
    void doc.getPage(n).then((page) => {
      if (dead || !canvas.current) return
      let ratio = Math.min(window.devicePixelRatio || 1, 2)
      if (w * h * ratio * ratio > MAX_CANVAS_PIXELS) ratio = Math.sqrt(MAX_CANVAS_PIXELS / (w * h))
      const viewport = page.getViewport({ scale: scale * ratio })
      const c = canvas.current
      c.width = Math.floor(viewport.width)
      c.height = Math.floor(viewport.height)
      c.style.width = `${w}px`
      c.style.height = `${h}px`
      task = page.render({ canvas: c, viewport })
      task.promise.catch(() => {})
    })
    return () => {
      dead = true
      task?.cancel()
    }
  }, [near, doc, n, scale, w, h])

  return (
    <div ref={holder} className="bl-pdf-page" style={{ width: w, height: h }}>
      {near ? <canvas ref={canvas} /> : null}
      <span className="bl-pdf-num">{n}</span>
    </div>
  )
})

export const PdfView = memo(function PdfView({ src, title }: { src: string; title: string }) {
  const wrap = useRef<HTMLDivElement>(null)
  const [doc, doc_] = useState<PDFDocumentProxy | null>(null)
  const [sizes, sizes_] = useState<Size[]>([])
  const [error, error_] = useState<string | null>(null)
  const [zoom, zoom_] = useState<number | 'fit'>('fit')
  const [width, width_] = useState(0)

  useEffect(() => {
    let dead = false
    let task: { destroy: () => Promise<void> } | null = null
    error_(null)
    doc_(null)
    void (async () => {
      try {
        const lib = await pdfjs()
        const loading = lib.getDocument({ url: src })
        task = loading
        const loaded = await loading.promise
        const all: Size[] = []
        for (let i = 1; i <= loaded.numPages; i++) {
          const v = (await loaded.getPage(i)).getViewport({ scale: 1 })
          all.push({ w: v.width, h: v.height })
        }
        if (dead) return
        sizes_(all)
        doc_(loaded)
      } catch (err: unknown) {
        if (dead) return
        const msg = err instanceof Error ? err.message : String(err)
        error_(/Missing PDF|Unexpected server response \((\d+)\)/i.test(msg) ? `The document could not be loaded (${msg}).` : `The document could not be shown: ${msg}`)
      }
    })()
    return () => {
      dead = true
      void task?.destroy()
    }
  }, [src])

  // Fit-to-width follows the blade as it is resized, by mouse or by hand.
  useEffect(() => {
    const el = wrap.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => width_(e.contentRect.width))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const widest = sizes.reduce((m, s) => Math.max(m, s.w), 1)
  const fitScale = width > 0 ? Math.max(0.1, (width - 28) / widest) : 1
  const scale = zoom === 'fit' ? fitScale : zoom

  const step = useCallback(
    (dir: 1 | -1) => {
      const now = zoom === 'fit' ? fitScale : zoom
      const next = dir > 0 ? ZOOMS.find((z) => z > now + 0.01) : [...ZOOMS].reverse().find((z) => z < now - 0.01)
      if (next) zoom_(next)
    },
    [zoom, fitScale],
  )

  if (error) return <p className="bl-note">{error}</p>

  return (
    <div ref={wrap} className="bl-pdf">
      <div className="bl-pdf-bar">
        <span className="bl-pdf-meta">{doc ? `${doc.numPages} page${doc.numPages === 1 ? '' : 's'}` : 'Loading…'}</span>
        <span className="bl-pdf-zoom">
          <button type="button" onClick={() => step(-1)} aria-label="Zoom out">−</button>
          <button type="button" className={zoom === 'fit' ? 'on' : ''} onClick={() => zoom_('fit')}>
            {zoom === 'fit' ? 'Fit' : `${Math.round(scale * 100)}%`}
          </button>
          <button type="button" onClick={() => step(1)} aria-label="Zoom in">+</button>
        </span>
        <a className="bl-pdf-open" href={src} target="_blank" rel="noreferrer" title={`Open ${title} in the browser's own viewer (print, search)`}>
          Open
        </a>
      </div>
      <div className="bl-pdf-pages">
        {doc && sizes.map((s, i) => <Page key={i} doc={doc} n={i + 1} base={s} scale={scale} />)}
      </div>
    </div>
  )
})
