/**
 * Salman's verdict on a proposed lesson, typed on Telegram:
 *   "yes 12"  "approve 12"  "ok 12"      → into the playbook
 *   "no 12"   "reject 12"                → dropped (kept as rejected)
 *   "edit 12: keep dormers set down 200mm" → into the playbook, reworded
 *   "yes 12 13 14" / "no all"            → several at once
 */
export function parseApproval(text) {
  const s = String(text ?? '').trim()
  let m = /^(?:edit|change|reword)\s+#?(\d+)\s*[:\-–—]\s*(.+)$/is.exec(s)
  if (m) return { verdict: 'edit', ids: [Number(m[1])], text: m[2].trim() }
  m = /^(yes|approve|approved|ok|okay|accept|no|reject|rejected|drop)\s+(all|(?:#?\d+[\s,]*)+)\s*$/i.exec(s)
  if (!m) return null
  const verdict = /^(no|reject|rejected|drop)$/i.test(m[1]) ? 'no' : 'yes'
  if (/^all$/i.test(m[2])) return { verdict, ids: 'all' }
  const ids = [...m[2].matchAll(/\d+/g)].map((x) => Number(x[0]))
  return ids.length ? { verdict, ids } : null
}

/** Apply a verdict to the store; returns lines to send back. */
export function applyApproval(store, parsed) {
  const ids = parsed.ids === 'all' ? store.pendingLessons().map((l) => l.id) : parsed.ids
  if (!ids.length) return ['Nothing is waiting for approval, sir.']
  const out = []
  for (const id of ids) {
    const r = store.decide(id, parsed.verdict, { text: parsed.text })
    if (r.error) out.push(r.error)
    else if (r.record.status === 'approved') out.push(`#${id} added to the ${r.record.council || r.record.projectType} playbook${parsed.verdict === 'edit' ? ' as reworded' : ''}.`)
    else out.push(`#${id} dropped.`)
  }
  const left = store.pendingLessons().length
  if (left) out.push(`${left} still waiting.`)
  return out
}

/** The Telegram message for a batch of proposed lessons. */
export function lessonMessage(lessons, { job = '' } = {}) {
  if (!lessons.length) return ''
  const lines = [job ? `Lessons from ${job} — reply "yes N", "no N" or "edit N: new wording":` : 'Proposed lessons — reply "yes N", "no N" or "edit N: new wording":']
  for (const l of lessons) {
    lines.push(`#${l.id} [${l.council || l.projectType}${l.cases === 1 ? ' · 1 case only' : ` · ${l.cases} cases`}] ${l.lesson}\n   refs: ${l.refs.join('; ')}`)
  }
  return lines.join('\n')
}
