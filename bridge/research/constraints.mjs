/**
 * Where a property is and what constrains it, from open government data:
 * postcodes.io for the council and coordinates, planning.data.gov.uk for the
 * designations. No keys, no scraping.
 *
 * Coordinates come from the postcode centre, not the building, so a site near
 * a boundary can be reported on the wrong side of it. The result says so, and
 * the report should tell the reader to confirm on the council's own map.
 */

const POSTCODE = /\b([A-Z]{1,2}\d[A-Z\d]?)\s*(\d[A-Z]{2})\b/i

export const findPostcode = (text) => {
  const m = POSTCODE.exec(String(text ?? ''))
  return m ? `${m[1]} ${m[2]}`.toUpperCase() : null
}

export async function locate(address) {
  const postcode = findPostcode(address)
  if (!postcode) throw new Error('the address needs a postcode so it can be located')
  const res = await fetch(`https://api.postcodes.io/postcodes/${encodeURIComponent(postcode)}`, { signal: AbortSignal.timeout(20_000) })
  if (res.status === 404) throw new Error(`${postcode} is not a known postcode`)
  if (!res.ok) throw new Error(`postcode lookup failed (${res.status})`)
  const r = (await res.json()).result
  return {
    postcode: r.postcode,
    lat: r.latitude,
    lng: r.longitude,
    lpa: r.admin_district,
    ward: r.admin_ward,
    parish: r.parish,
    region: r.region,
    country: r.country,
  }
}

const API = 'https://www.planning.data.gov.uk/entity.json'

async function entities(params) {
  const url = `${API}?${params}`
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) })
  if (!res.ok) throw new Error(`planning.data.gov.uk answered ${res.status}`)
  return (await res.json()).entities ?? []
}

/** Designations the site sits inside. */
const AREA_DATASETS = [
  'conservation-area',
  'article-4-direction-area',
  'tree-preservation-zone',
  'flood-risk-zone',
  'green-belt',
  'scheduled-monument',
  'park-and-garden',
  'world-heritage-site',
  'area-of-outstanding-natural-beauty',
  'listed-building-outline',
]

const metres = (a, b) => {
  const R = 6371000
  const toRad = (d) => (d * Math.PI) / 180
  const dLat = toRad(b.lat - a.lat)
  const dLng = toRad(b.lng - a.lng)
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2
  return Math.round(2 * R * Math.asin(Math.sqrt(h)))
}

const pointOf = (wkt) => {
  const m = /POINT\s*\(\s*(-?[\d.]+)\s+(-?[\d.]+)\s*\)/i.exec(String(wkt ?? ''))
  return m ? { lng: Number(m[1]), lat: Number(m[2]) } : null
}

/** Pure: raw entities → a tidy constraints summary. For tests. */
export function summarise(areas, listed, at) {
  const by = (ds) => areas.filter((e) => e.dataset === ds)
  const names = (ds) => [...new Set(by(ds).map((e) => e.name || e.reference).filter(Boolean))]
  const near = listed
    .map((e) => ({ name: e.name, grade: e['listed-building-grade'] ?? '', at: pointOf(e.point) }))
    .filter((e) => e.at)
    .map((e) => ({ name: e.name, grade: e.grade, metres: metres(at, e.at) }))
    .sort((a, b) => a.metres - b.metres)
  return {
    conservationAreas: names('conservation-area'),
    article4: by('article-4-direction-area').map((e) => ({ name: e.name || e.reference, description: e.description ?? '' })),
    treePreservation: names('tree-preservation-zone'),
    flood: [...new Set(by('flood-risk-zone').map((e) => e['flood-risk-level'] ? `Flood Zone ${e['flood-risk-level']}` : e.name).filter(Boolean))],
    greenBelt: by('green-belt').length > 0,
    heritage: [...names('scheduled-monument'), ...names('park-and-garden'), ...names('world-heritage-site')],
    aonb: names('area-of-outstanding-natural-beauty'),
    listedOnSite: names('listed-building-outline'),
    listedNearby: near.slice(0, 8),
  }
}

export async function constraints(place) {
  const at = { lat: place.lat, lng: place.lng }
  const areaParams = new URLSearchParams({ latitude: String(at.lat), longitude: String(at.lng), limit: '100' })
  for (const ds of AREA_DATASETS) areaParams.append('dataset', ds)
  // ~70 m either way: close enough to matter for setting, far enough to catch
  // the listed building next door when the postcode centre is up the street.
  const d = 0.0007
  const box = `POLYGON((${at.lng - d * 1.6} ${at.lat - d},${at.lng + d * 1.6} ${at.lat - d},${at.lng + d * 1.6} ${at.lat + d},${at.lng - d * 1.6} ${at.lat + d},${at.lng - d * 1.6} ${at.lat - d}))`
  const listedParams = new URLSearchParams({ dataset: 'listed-building', geometry: box, geometry_relation: 'intersects', limit: '50' })
  const [areas, listed] = await Promise.all([entities(areaParams), entities(listedParams).catch(() => [])])
  return { ...summarise(areas, listed, at), basis: 'postcode centre — confirm boundaries on the council’s own map' }
}
