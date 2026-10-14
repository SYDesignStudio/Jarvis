import { session, strip } from './http.mjs'

/**
 * Idox Public Access — the planning register most English councils run
 * (".../online-applications/"). Search by address, read an application's
 * summary, and list its documents so the officer's report can be found.
 */

const unescape = (s) => String(s ?? '').replace(/&amp;/g, '&')

/** Results of a simple search, one row per application. */
export function parseResults(html, base) {
  const rows = []
  const items = html.split(/<li class="searchresult"/i).slice(1)
  for (const item of items) {
    const link = /href="([^"]*applicationDetails\.do\?[^"]*keyVal=([A-Za-z0-9_]+)[^"]*)"/.exec(item)
    if (!link) continue
    const text = strip(item)
    const pick = (label) => new RegExp(`${label}:?\\s*([^|\\n]+?)(?=\\s*(?:\\||\\n|Ref\\. No|Received|Validated|Status|Decision|Appeal|$))`, 'i').exec(text)?.[1]?.trim() ?? ''
    const summary = strip(/<a[^>]*>([\s\S]*?)<\/a>/.exec(item)?.[1] ?? '')
    const address = strip(/<p class="address">([\s\S]*?)<\/p>/i.exec(item)?.[1] ?? '')
    rows.push({
      keyVal: link[2],
      url: new URL(unescape(link[1]), base + '/').href,
      reference: pick('Ref\\. No'),
      received: pick('Received'),
      validated: pick('Validated'),
      status: pick('Status'),
      decision: pick('Decision'),
      proposal: summary,
      address,
    })
  }
  return rows
}

/** The Summary tab as label → value. */
export function parseSummary(html) {
  const out = {}
  const table = /<table[^>]*id="simpleDetailsTable"[\s\S]*?<\/table>/i.exec(html)?.[0] ?? html
  for (const m of table.matchAll(/<th[^>]*>([\s\S]*?)<\/th>\s*<td[^>]*>([\s\S]*?)<\/td>/gi)) {
    const k = strip(m[1]).replace(/:$/, '')
    if (k) out[k] = strip(m[2])
  }
  return out
}

/** Documents tab: type, date, description, link. */
export function parseDocuments(html, base) {
  const docs = []
  for (const row of html.match(/<tr[\s\S]*?<\/tr>/gi) ?? []) {
    const href = /href="([^"]*\/files\/[^"]+)"/i.exec(row)?.[1]
    if (!href) continue
    const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((c) => strip(c[1]))
    docs.push({
      url: new URL(unescape(href), base + '/').href,
      // Column order varies between councils; keep the text and let the
      // matcher below look across all of it.
      cells: cells.filter(Boolean),
      text: cells.filter(Boolean).join(' · '),
    })
  }
  return docs
}

/** Documents most likely to be the officer's report, best first. */
export function rankReports(docs) {
  const score = (d) => {
    const t = d.text.toLowerCase()
    if (/officer'?s? report|delegated report|committee report|report of the (head|director)|case officer report/.test(t)) return 3
    if (/\breport\b/.test(t) && !/(tree|arb|flood|noise|ecolog|heritage|transport|energy|daylight|structural|survey|fire)/.test(t)) return 2
    if (/decision notice|decision letter|refusal notice|approval notice|\bdecision\b/.test(t)) return 1
    return 0
  }
  return docs.map((d) => ({ ...d, kind: ['other', 'decision', 'report', 'officer report'][score(d)] }))
    .sort((a, b) => ['other', 'decision', 'report', 'officer report'].indexOf(b.kind) - ['other', 'decision', 'report', 'officer report'].indexOf(a.kind))
}

export function idox(base) {
  const root = base.replace(/\/+$/, '')
  return {
    kind: 'idox',
    base: root,
    async search(query, { max = 20 } = {}) {
      const s = session()
      const form = await s.get(`${root}/search.do?action=simple&searchType=Application`)
      const csrf = /name="_csrf"\s+value="([^"]+)"/.exec(form.html)?.[1]
      const res = await s.post(
        `${root}/simpleSearchResults.do?action=firstPage`,
        {
          ...(csrf ? { _csrf: csrf } : {}),
          searchType: 'Application',
          'searchCriteria.simpleSearchString': query,
          'searchCriteria.simpleSearch': 'true',
        },
        { referer: form.url },
      )
      // A single match goes straight to the application; treat that as one row.
      if (/applicationDetails\.do/.test(res.url)) {
        const summary = parseSummary(res.html)
        const keyVal = /keyVal=([A-Za-z0-9_]+)/.exec(res.url)?.[1]
        return [{ keyVal, url: res.url, reference: summary.Reference ?? '', proposal: summary.Proposal ?? '', address: summary.Address ?? '', status: summary.Status ?? '', decision: summary.Decision ?? '', received: summary['Application Received'] ?? '' }]
      }
      if (/too many results/i.test(res.html)) throw new Error('too many results — search with the house number and street, or add a keyword')
      return parseResults(res.html, root).slice(0, max)
    },
    async detail(keyVal) {
      const s = session()
      const sum = await s.get(`${root}/applicationDetails.do?activeTab=summary&keyVal=${encodeURIComponent(keyVal)}`)
      const further = await s.get(`${root}/applicationDetails.do?activeTab=details&keyVal=${encodeURIComponent(keyVal)}`).catch(() => null)
      const docs = await s.get(`${root}/applicationDetails.do?activeTab=documents&keyVal=${encodeURIComponent(keyVal)}`).catch(() => null)
      return {
        url: sum.url,
        documentsUrl: docs?.url ?? `${root}/applicationDetails.do?activeTab=documents&keyVal=${encodeURIComponent(keyVal)}`,
        summary: parseSummary(sum.html),
        details: further ? parseSummary(further.html) : {},
        documents: docs ? rankReports(parseDocuments(docs.html, root)) : [],
        // Some councils put every document behind a CAPTCHA. That is a
        // deliberate "a person must do this", so it is reported, not worked
        // around: the link goes to Salman instead.
        gated: Boolean(docs && /recaptcha/i.test(docs.html)),
      }
    },
    /** A document's bytes, fetched the way the page would, or an error if the council refuses. */
    async fetchDocument(keyVal, url) {
      const s = session()
      const page = await s.get(`${root}/applicationDetails.do?activeTab=documents&keyVal=${encodeURIComponent(keyVal)}`)
      const f = await s.get(url, { binary: true, referer: page.url })
      if (!/pdf|octet-stream/i.test(f.type) && f.buffer.subarray(0, 4).toString() !== '%PDF') {
        throw new Error('the council returned a page instead of the document — it is probably behind a CAPTCHA')
      }
      return f.buffer
    },
  }
}
