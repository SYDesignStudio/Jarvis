import { session, strip } from './http.mjs'

/**
 * Ocella (Arcus) planning registers, e.g. Hillingdon. The search takes a
 * location string — a street works best; a bare postcode finds little.
 */

export function parseOcellaResults(html, base) {
  const rows = []
  const seen = new Set()
  for (const tr of html.match(/<tr[\s\S]*?<\/tr>/gi) ?? []) {
    const m = /href="(planningDetails\?reference=([^"&]+)[^"]*)"/i.exec(tr)
    if (!m || seen.has(m[2])) continue
    seen.add(m[2])
    const cells = [...tr.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((c) => strip(c[1])).filter(Boolean)
    rows.push({
      reference: decodeURIComponent(m[2]),
      url: new URL(m[1].replace(/&amp;/g, '&'), `${base}/`).href,
      cells,
      text: cells.join(' · '),
    })
  }
  return rows
}

export function parseOcellaDetail(html) {
  const out = {}
  for (const tr of html.match(/<tr[\s\S]*?<\/tr>/gi) ?? []) {
    const cells = [...tr.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((c) => strip(c[1]))
    if (cells.length >= 2 && cells[0] && cells[0].length < 40) out[cells[0].replace(/:$/, '')] = cells.slice(1).join(' ').trim()
  }
  return out
}

export function ocella(base) {
  const root = base.replace(/\/+$/, '')
  return {
    kind: 'ocella',
    base: root,
    async search(location, { max = 25 } = {}) {
      const s = session()
      const form = await s.get(`${root}/planningSearch`)
      const res = await s.post(
        `${root}/planningSearch`,
        { reference: '', location, area: '', agent: '', receivedFrom: '', receivedTo: '', decidedFrom: '', decidedTo: '', action: 'Search' },
        { referer: form.url },
      )
      return parseOcellaResults(res.html, root).slice(0, max)
    },
    async detail(reference) {
      const s = session()
      const url = `${root}/planningDetails?reference=${encodeURIComponent(reference)}&from=planningSearch`
      const page = await s.get(url)
      return { url, summary: parseOcellaDetail(page.html), documents: [] }
    },
  }
}
