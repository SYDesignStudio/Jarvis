import { randomUUID } from 'node:crypto'
import { readFile, stat, realpath } from 'node:fs/promises'
import { basename, extname, isAbsolute } from 'node:path'
import { ImapFlow } from 'imapflow'
import { simpleParser } from 'mailparser'
import { composeEmail, logoIsLive, LOGO_URL, signatureFor } from './signature.mjs'
import { DOC_ROOTS, localPathFrom, within } from './docs.mjs'

/**
 * Emails with attachments, as Gmail DRAFTS — never sent from here.
 *
 * Zapier can only attach a file it can download from the internet, and a
 * drawing on the NAS or a fee proposal in D:\APP DEVLOPMENT is not on the
 * internet (nor should a client's documents be put there to make it so). So the
 * message is built on this PC — Salman's signature and logo, the text, the
 * files — and placed in the account's Drafts folder over IMAP with the app
 * password the inbox watcher already uses. It appears in Gmail on the iPhone
 * and the desk, and Salman presses Send. There is no transport in this file:
 * nothing here can send an email. (The one place that can is mailsend.mjs,
 * for mailboxes Zapier does not reach, and only on Salman's "send N".)
 */

const MAX_TOTAL = 24 * 1024 * 1024 // Gmail's limit is 25 MB including encoding overhead headroom
const ALLOWED = {
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.doc': 'application/msword',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.xls': 'application/vnd.ms-excel',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.dwg': 'application/acad',
  '.dxf': 'application/dxf',
  '.txt': 'text/plain',
  '.csv': 'text/csv',
  '.webp': 'image/webp',
  '.heic': 'image/heic',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
}

/** Check every file before anything is built. Returns { files } or { error }. */
export async function vetAttachments(paths = [], roots = DOC_ROOTS, { maxTotal = MAX_TOTAL, limitName = 'Gmail allows about 25 MB; send fewer, or a share link' } = {}) {
  const files = []
  let total = 0
  for (const raw of paths) {
    const p = localPathFrom(raw) ?? raw
    let real
    try {
      if (!isAbsolute(p)) throw new Error()
      real = await realpath(p)
    } catch {
      return { error: `the file does not exist: ${raw}` }
    }
    const ext = extname(real).toLowerCase()
    if (!ALLOWED[ext]) return { error: `${basename(real)} is a ${ext || 'file'} — only PDFs, Word, Excel, images, videos and CAD files can be sent` }
    if (!within(roots, real)) return { error: `${basename(real)} is outside the folders JARVIS may attach from` }
    const info = await stat(real)
    total += info.size
    files.push({ path: real, name: basename(real), type: ALLOWED[ext], size: info.size })
  }
  if (total > maxTotal) return { error: `the files total ${(total / 1048576).toFixed(1)} MB — ${limitName}` }
  return { files, total }
}

// ---------------------------------------------------------------- MIME

const b64 = (buf) => Buffer.from(buf).toString('base64').replace(/.{76}/g, '$&\r\n')
const encodeWord = (s) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`)
const address = (s) => {
  const m = /^\s*(.*?)\s*<([^>]+)>\s*$/.exec(s)
  return m ? `${m[1] ? `"${encodeWord(m[1].replace(/"/g, ''))}" ` : ''}<${m[2]}>` : s.trim()
}
const asciiName = (n) => n.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, "'")

/**
 * The raw message. Pure — every input explicit — so it can be tested by
 * parsing it back. attachments: [{ name, type, content: Buffer }].
 */
export function buildMime({ from, to = [], cc = [], subject, text, html, attachments = [], inReplyTo = '', references = '', date = new Date(), messageId = `<${randomUUID()}@sydesignstudio.co.uk>` }) {
  const mixed = `mix-${randomUUID()}`
  const alt = `alt-${randomUUID()}`
  const head = [
    `From: ${address(from)}`,
    to.length ? `To: ${to.map(address).join(', ')}` : null,
    cc.length ? `Cc: ${cc.map(address).join(', ')}` : null,
    `Subject: ${encodeWord(subject)}`,
    `Date: ${date.toUTCString().replace('GMT', '+0000')}`,
    `Message-ID: ${messageId}`,
    inReplyTo ? `In-Reply-To: ${inReplyTo}` : null,
    references || inReplyTo ? `References: ${[references, inReplyTo].filter(Boolean).join(' ').trim()}` : null,
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${mixed}"`,
  ].filter(Boolean)
  const parts = [
    `--${mixed}`,
    `Content-Type: multipart/alternative; boundary="${alt}"`,
    '',
    `--${alt}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    b64(text),
    `--${alt}`,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    b64(html),
    `--${alt}--`,
  ]
  for (const a of attachments) {
    parts.push(
      `--${mixed}`,
      `Content-Type: ${a.type}; name="${asciiName(a.name)}"`,
      `Content-Disposition: attachment; filename="${asciiName(a.name)}"; filename*=UTF-8''${encodeURIComponent(a.name)}`,
      'Content-Transfer-Encoding: base64',
      '',
      b64(a.content),
    )
  }
  parts.push(`--${mixed}--`, '')
  return `${head.join('\r\n')}\r\n\r\n${parts.join('\r\n')}`
}

// ---------------------------------------------------------------- IMAP

async function withClient(acct, fn) {
  const client = new ImapFlow({ host: acct.host, port: 993, secure: true, auth: { user: acct.user, pass: acct.password }, logger: false })
  await client.connect()
  try {
    return await fn(client)
  } finally {
    await client.logout().catch(() => {})
  }
}

/** The headers a reply needs, from the message being answered. */
async function original(acct, id) {
  const all = String(id).startsWith('all:')
  const uid = Number(String(id).replace(/^all:/, ''))
  return withClient(acct, async (client) => {
    const lock = await client.getMailboxLock(all ? '[Gmail]/All Mail' : 'INBOX')
    try {
      const msg = await client.fetchOne(String(uid), { uid: true, source: true }, { uid: true })
      if (!msg) return null
      const p = await simpleParser(msg.source)
      return {
        messageId: p.messageId ? `<${p.messageId.replace(/^<|>$/g, '')}>` : '',
        references: Array.isArray(p.references) ? p.references.map((r) => `<${r.replace(/^<|>$/g, '')}>`).join(' ') : p.references ? `<${String(p.references).replace(/^<|>$/g, '')}>` : '',
        subject: p.subject ?? '',
        replyTo: p.replyTo?.text || p.from?.text || '',
        date: p.date,
        from: p.from?.text ?? '',
      }
    } finally {
      lock.release()
    }
  })
}

/** The account an email is from: the exact address, or a unique first part ("specline", "salman"). */
export function accountFor(accounts, wanted) {
  const w = String(wanted ?? '').toLowerCase().trim()
  if (!w) return null
  return (
    accounts.find((a) => a.user.toLowerCase() === w) ??
    accounts.find((a) => a.user.toLowerCase().startsWith(`${w.split('@')[0]}@`) && (!w.includes('@') || a.user.toLowerCase().endsWith(w.split('@')[1]))) ??
    accounts.find((a) => a.user.toLowerCase().includes(w)) ??
    null
  )
}

/**
 * Build the finished message for an account — signature for that account,
 * attachments vetted, reply headers from the original — without putting it
 * anywhere. createDraft files it in Drafts; mailsend.mjs holds it for
 * Salman's "send N".
 * opts: { account, to, cc, subject, text, attachments: [paths], replyToId, roots }
 */
export async function buildMessage(accounts, opts) {
  const acct = accountFor(accounts, opts.account)
  if (!acct) throw new Error(`no inbox "${opts.account}" is configured`)

  const vetted = await vetAttachments(opts.attachments ?? [], opts.roots)
  if (vetted.error) throw new Error(vetted.error)

  let reply = null
  if (opts.replyToId != null && opts.replyToId !== '') {
    reply = await original(acct, opts.replyToId)
    if (!reply) throw new Error('the email being replied to was not found — check the id and account')
  }
  const to = (opts.to?.length ? opts.to : reply ? [reply.replyTo] : []).filter(Boolean)
  if (!to.length) throw new Error('no recipient')
  const subject = opts.subject || (reply ? (/^re:/i.test(reply.subject) ? reply.subject : `Re: ${reply.subject}`) : '')
  if (!subject) throw new Error('no subject')

  const signature = signatureFor(acct.user)
  // Each account signs with its own logo; a logo that is not reachable is left out, never sent broken.
  const logoUrl = signature.plain ? (signature.logoUrl ?? null) : LOGO_URL
  const live = logoUrl ? await (opts.logoIsLive ?? logoIsLive)(logoUrl) : false
  const { htmlBody, body } = composeEmail(opts.text, { logoUrl: live ? logoUrl : null, signature })
  const attachments = await Promise.all(vetted.files.map(async (f) => ({ ...f, content: await readFile(f.path) })))
  const cc = (opts.cc ?? []).filter(Boolean)
  const raw = buildMime({
    from: `${signature.name} <${acct.user}>`,
    to,
    cc,
    subject,
    text: body,
    html: htmlBody,
    attachments,
    inReplyTo: reply?.messageId ?? '',
    references: reply?.references ?? '',
    messageId: `<${randomUUID()}@${acct.user.split('@')[1]}>`,
  })
  return { acct, raw, to, cc, subject, text: body, files: vetted.files, total: vetted.total, logo: live, plainSignature: Boolean(signature.plain && !logoUrl), threaded: Boolean(reply?.messageId) }
}

/** The server's own name for a special folder: "[Gmail]/Drafts" on Google, "INBOX.Drafts" or "Drafts" on Hostinger. */
export async function specialFolder(client, use, fallback) {
  const boxes = await client.list().catch(() => [])
  const name = use.replace(/^\\/, '').toLowerCase()
  return boxes.find((b) => b.specialUse === use)?.path ?? boxes.find((b) => new RegExp(`(^|[./])${name}( items| mail)?$`, 'i').test(b.path))?.path ?? fallback
}

/** Put a finished message in a special folder of its account (Drafts, Sent). */
export async function fileMessage(acct, raw, use, flags) {
  const gmail = /gmail\.com$/i.test(acct.host)
  return withClient(acct, async (client) => {
    const folder = await specialFolder(client, use, gmail ? `[Gmail]/${use === '\\Sent' ? 'Sent Mail' : 'Drafts'}` : use === '\\Sent' ? 'INBOX.Sent' : 'INBOX.Drafts')
    await client.append(folder, raw, flags)
    return folder
  })
}

/**
 * Take a message JARVIS itself filed back out of a special folder, by its
 * Message-ID — the Drafts copy of a held email once it is sent, cancelled or
 * replaced. Only ever a message this bridge put there: the id is one it minted.
 */
export async function unfileMessage(acct, messageId, use = '\\Drafts') {
  if (!messageId) return 0
  const gmail = /gmail\.com$/i.test(acct.host)
  return withClient(acct, async (client) => {
    const folder = await specialFolder(client, use, gmail ? '[Gmail]/Drafts' : 'INBOX.Drafts')
    const lock = await client.getMailboxLock(folder)
    try {
      const uids = await client.search({ header: { 'message-id': messageId } }, { uid: true })
      if (!uids?.length) return 0
      await client.messageDelete(uids, { uid: true })
      return uids.length
    } finally {
      lock.release()
    }
  })
}

/** Build the email and put it in the account's Drafts — Gmail or any IMAP mailbox. Never sent from here. */
export async function createDraft(accounts, opts) {
  const m = await buildMessage(accounts, opts)
  const folder = await fileMessage(m.acct, m.raw, '\\Drafts', ['\\Draft', '\\Seen'])
  return { account: m.acct.user, folder, to: m.to, subject: m.subject, files: m.files, total: m.total, logo: m.logo, plainSignature: m.plainSignature, threaded: m.threaded }
}
