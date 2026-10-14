import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * Retell's API, the few calls this bridge needs. Plain fetch; the SDK would be
 * a dependency for six endpoints.
 */
const BASE = 'https://api.retellai.com'

export function createRetell({ apiKey }) {
  const req = async (method, path, body) => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20_000),
    })
    const text = await res.text()
    let data = null
    try {
      data = text ? JSON.parse(text) : null
    } catch {
      data = { raw: text }
    }
    if (!res.ok) throw new Error(`retell ${method} ${path}: ${res.status} ${text.slice(0, 200)}`)
    return data
  }

  return {
    getCall: (id) => req('GET', `/v2/get-call/${encodeURIComponent(id)}`),
    createPhoneCall: (body) => req('POST', '/v2/create-phone-call', body),
    getAgent: (id) => req('GET', `/get-agent/${encodeURIComponent(id)}`),
    createAgent: (body) => req('POST', '/create-agent', body),
    createRetellLlm: (body) => req('POST', '/create-retell-llm', body),
    updateRetellLlm: (id, body) => req('PATCH', `/update-retell-llm/${encodeURIComponent(id)}`, body),
    updateAgent: (id, body) => req('PATCH', `/update-agent/${encodeURIComponent(id)}`, body),
    listVoices: () => req('GET', '/list-voices'),
    listPhoneNumbers: () => req('GET', '/list-phone-numbers'),
    updatePhoneNumber: (number, body) => req('PATCH', `/update-phone-number/${encodeURIComponent(number)}`, body),
  }
}

/**
 * Verify a webhook. Retell signs HMAC-SHA256(rawBody + timestamp) with the API
 * key and sends "v={timestamp},d={hex}". The timestamp has to be recent, and
 * the comparison has to be constant-time.
 */
export function verifyWebhook(rawBody, header, apiKey, { now = Date.now(), toleranceMs = 5 * 60_000 } = {}) {
  const m = /^v=(\d+),d=([0-9a-f]+)$/i.exec(String(header ?? '').trim())
  if (!m || !apiKey) return false
  const ts = Number(m[1])
  if (!Number.isFinite(ts) || Math.abs(now - ts) > toleranceMs) return false
  const expected = createHmac('sha256', apiKey).update(rawBody + m[1]).digest('hex')
  const a = Buffer.from(expected, 'hex')
  const b = Buffer.from(m[2], 'hex')
  return a.length === b.length && timingSafeEqual(a, b)
}

/** Sign a body the way Retell does — for tests and for the preflight. */
export function signWebhook(rawBody, apiKey, ts = Date.now()) {
  return `v=${ts},d=${createHmac('sha256', apiKey).update(rawBody + String(ts)).digest('hex')}`
}

/**
 * A British male voice from the catalogue, when none is configured or the
 * configured one has gone. Checked against the live list rather than guessed,
 * because a wrong voice id fails the whole agent creation.
 */
export async function pickVoice(retell, wanted) {
  let voices = []
  try {
    voices = await retell.listVoices()
  } catch {
    return wanted || null
  }
  if (wanted && voices.some((v) => v.voice_id === wanted)) return wanted
  const male = (v) => /male/i.test(v.gender ?? '') && !/female/i.test(v.gender ?? '')
  const british = voices.find((v) => /brit|uk|english \(uk\)|en-gb/i.test(`${v.accent ?? ''} ${v.voice_name ?? ''}`) && male(v))
  return british?.voice_id ?? voices.find(male)?.voice_id ?? voices[0]?.voice_id ?? null
}
