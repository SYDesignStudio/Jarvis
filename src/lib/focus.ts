import { BRIDGE_HTTP_URL } from '../config'

/**
 * The buttons' route into a focus session. Voice goes through the agent's
 * tools; the FOCUS key and the desk card come here. Both land on the same
 * engine in the bridge, which also speaks the resulting line.
 */
export async function postFocus(
  action: 'start' | 'pause' | 'resume' | 'abort' | 'lock_here' | 'extend',
  extra: { minutes?: number; fromCard?: boolean } = {},
): Promise<void> {
  const res = await fetch(`${BRIDGE_HTTP_URL}/focus`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action, ...extra }),
  })
  if (!res.ok) throw new Error(`The focus timer did not respond (${res.status}).`)
}

/** Default length for a session started by key or button. */
export const BUTTON_MINUTES = 30

/** mm:ss, with hours folded in as minutes past 60 ("75:00"). */
export function clock(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000))
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}
