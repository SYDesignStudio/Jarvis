/**
 * Telegram: JARVIS in your pocket.
 *
 * One bot, one chat — yours. Messages from any other chat are ignored, with
 * one line in the log so a stranger poking the bot is visible and nothing
 * more. Long polling, so nothing has to be reachable from the internet.
 *
 * Two jobs. `notify` delivers a line and reports whether Telegram actually
 * accepted it — the receipt the mail watcher and the phone rely on. And a
 * message from you is a turn on a persistent session, the same brain as the
 * desk, so "what did Robin say" works from the train.
 */

import { callRecordingIn, pastedCallText, localWhisperAvailable, transcribeFile, keepCall, transcriptText, callNotesPrompt } from '../calls/index.mjs'
import { isWhatsAppExport, readExport, chatNotesPrompt } from '../calls/chats.mjs'
import { mediaIn, jobFrom, stageFrom, fileBatch, targetLabel, STAGES } from './photos.mjs'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join as joinPath } from 'node:path'

const API = (token, method) => `https://api.telegram.org/bot${token}/${method}`

/**
 * @param {object} io
 * @param {object} [io.speech]  { transcribe(buffer, mime), synthesise(text, format), canTranscribe(), canSpeak() }
 */
/**
 * A bare "call me" — the one-tap Shortcut on his phone. Anything with more in
 * it ("call me about Longmeadow", "call Nav") is a request for the model.
 */
export const isCallMe = (text) =>
  /^\s*(?:hey\s+)?(?:jarvis[,!]?\s*)?(?:please\s+)?(?:call|ring|phone)\s+me(?:\s+(?:back|now|please))?\s*[.!]?\s*$/i.test(String(text ?? ''))

export function createTelegram({ token, chatId, makeSession, speech = null, inboxDir = null, quickCall = null, approvals = null, restart = null, log = console.log }) {
  if (!token) return null
  let session = null
  let offset = 0
  let running = false
  let known = { ok: false, username: '' }

  const call = async (method, body, timeoutMs = 15_000) => {
    const res = await fetch(API(token, method), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {}),
      signal: AbortSignal.timeout(timeoutMs),
    })
    const data = await res.json().catch(() => ({}))
    if (!data.ok) throw new Error(`telegram ${method}: ${data.description ?? res.status}`)
    return data.result
  }

  /** Deliver one message. Resolves true only on a real Telegram receipt. */
  async function notify(text, { silent = false } = {}) {
    if (!chatId) {
      log('[jarvis:telegram] no TELEGRAM_CHAT_ID — message not sent')
      return false
    }
    try {
      // 4096 is Telegram's ceiling; a longer alert is split rather than dropped.
      for (let i = 0; i < text.length; i += 4000) {
        await call('sendMessage', {
          chat_id: chatId,
          text: text.slice(i, i + 4000),
          disable_notification: silent,
        })
      }
      return true
    } catch (err) {
      log(`[jarvis:telegram] send failed: ${err.message}`)
      return false
    }
  }

  /** Fetch a file Telegram is holding, by its file_id. */
  async function download(fileId) {
    const info = await call('getFile', { file_id: fileId })
    const res = await fetch(`https://api.telegram.org/file/bot${token}/${info.file_path}`, { signal: AbortSignal.timeout(30_000) })
    if (!res.ok) throw new Error(`could not download the voice note (${res.status})`)
    return Buffer.from(await res.arrayBuffer())
  }

  /** A voice bubble in reply. Falls back to an audio file, then to nothing. */
  async function sendVoice(text) {
    if (!speech?.canSpeak()) return false
    try {
      const { buffer, mime, ext } = await speech.synthesise(text, 'opus')
      const form = new FormData()
      form.append('chat_id', String(chatId))
      form.append(ext === 'ogg' ? 'voice' : 'audio', new Blob([buffer], { type: mime }), `jarvis.${ext}`)
      const res = await fetch(API(token, ext === 'ogg' ? 'sendVoice' : 'sendAudio'), { method: 'POST', body: form, signal: AbortSignal.timeout(60_000) })
      const data = await res.json().catch(() => ({}))
      if (data.ok) return true
      log(`[jarvis:telegram] voice reply refused: ${data.description ?? res.status}`)
      return false
    } catch (err) {
      log(`[jarvis:telegram] voice reply failed: ${err.message}`)
      return false
    }
  }

  // ---------------------------------------------------------------- site photos
  //
  // Photos and videos are filed by the bridge, not the model: download, work
  // out the job and stage from the caption, save into the job's photos folder.
  // An album arrives as separate messages sharing a media_group_id with the
  // caption on one of them, so items are gathered for a moment first. When the
  // job or stage is unclear the batch waits and JARVIS asks; the next short
  // reply ("1110 progress") files it.
  const albums = new Map()
  let pending = null

  // Photos waiting for "which job / stage" are kept on disk as well, so a
  // restart between sending them and answering does not lose them.
  const PENDING_DIR = inboxDir ? joinPath(inboxDir, 'Photos', 'waiting') : null
  const savePending = () => {
    if (!PENDING_DIR) return
    try {
      rmSync(PENDING_DIR, { recursive: true, force: true })
      if (!pending) return
      mkdirSync(PENDING_DIR, { recursive: true })
      const meta = { caption: pending.caption, at: pending.at, items: [] }
      pending.items.forEach((it, i) => {
        const file = `${String(i + 1).padStart(2, '0')}${it.ext}`
        writeFileSync(joinPath(PENDING_DIR, file), it.buffer)
        meta.items.push({ file, ext: it.ext, kind: it.kind, name: it.name, date: it.date })
      })
      writeFileSync(joinPath(PENDING_DIR, 'waiting.json'), JSON.stringify(meta, null, 1))
    } catch (err) {
      log(`[jarvis:telegram] could not keep waiting photos on disk: ${err.message}`)
    }
  }
  const loadPending = () => {
    if (!PENDING_DIR || !existsSync(joinPath(PENDING_DIR, 'waiting.json'))) return
    try {
      const meta = JSON.parse(readFileSync(joinPath(PENDING_DIR, 'waiting.json'), 'utf8'))
      pending = {
        caption: meta.caption ?? '',
        at: meta.at ?? Date.now(),
        items: meta.items.map((m) => ({ ...m, date: new Date(m.date), buffer: readFileSync(joinPath(PENDING_DIR, m.file)) })),
      }
      log(`[jarvis:telegram] ${pending.items.length} photo(s) still waiting for a job`)
    } catch (err) {
      log(`[jarvis:telegram] could not reload waiting photos: ${err.message}`)
    }
  }
  loadPending()
  // What happened to recent messages — shown in /diag, because the bridge's
  // console is usually a window nobody is looking at.
  const events = []
  const trace = (type, detail) => {
    events.push({ at: new Date().toISOString(), type, detail: String(detail ?? '').slice(0, 300) })
    if (events.length > 30) events.shift()
  }
  const PENDING_MS = 2 * 60 * 60_000

  async function fetchMedia(msg, media) {
    if ((media.size ?? 0) > 20 * 1024 * 1024) throw new Error('over 20 MB — Telegram will not let me fetch it. Send it as a photo rather than a file, or a shorter video.')
    return { buffer: await download(media.file_id), ext: media.ext, kind: media.kind, name: media.name, date: new Date((msg.date ?? Date.now() / 1000) * 1000) }
  }

  async function fileOrAsk(batch) {
    // Photos sent without a caption while others are already waiting join
    // them — they are the same visit — instead of replacing them.
    if (pending && !(batch.caption ?? '').trim() && batch !== pending) {
      batch = { items: [...pending.items, ...batch.items], caption: pending.caption }
    }
    const text = batch.caption ?? ''
    const t = jobFrom(text)
    const stage = stageFrom(text)
    const n = batch.items.length
    const what = `${n} ${batch.items.every((i) => i.kind === 'video') ? (n === 1 ? 'video' : 'videos') : n === 1 ? 'photo' : 'photos'}`
    if ((t.job || t.project) && stage) {
      try {
        const saved = fileBatch(t, stage, batch.items)
        const folder = saved.length ? saved[0].path.replace(/[\\/][^\\/]+$/, '') : ''
        pending = null
        savePending()
        trace('photos-saved', `${what} → ${folder}`)
        await notify(`Saved ${what} to ${targetLabel(t)} › ${STAGES[stage].label}.\n${folder}`)
      } catch (err) {
        trace('photos-error', `${what} for ${targetLabel(t)}: ${err.message}`)
        await notify(`I could not save the ${what}, sir: ${err.message}`)
      }
      return
    }
    trace('photos-asked', `${what}, caption "${text}" — job ${t.job || t.project ? 'ok' : t.several ? 'ambiguous' : 'unknown'}, stage ${stage ?? 'unknown'}`)
    pending = { ...batch, at: Date.now() }
    savePending()
    const need = []
    if (t.several) need.push(`which job — ${t.several.map((j) => `${j.number ? `${j.number} ` : ''}${j.address}`).join(', or ')}?`)
    else if (!t.job && !t.project) need.push('which job they are for (job number or address)')
    if (!stage) need.push('whether they are existing, during construction or completed')
    await notify(`Got ${what}. Tell me ${need.join(', and ')} — e.g. "1110 progress" — and I'll file them.`)
  }

  async function onMedia(msg, media) {
    trace('media-in', `${media.kind}${media.name ? ` ${media.name}` : ''}, caption "${msg.caption ?? ''}"${msg.media_group_id ? ', album' : ''}`)
    const caption = (msg.caption ?? '').trim()
    // An album has a media_group_id; photos picked together but sent one by
    // one do not — they are gathered the same way, so a set of ten gets one
    // question, not ten.
    const group = msg.media_group_id ?? 'burst'
    // The download starts now but is NOT awaited here: the next photo of an
    // album must be registered straight away, or a slow download closes the
    // album early and splits it into single photos (3 sent, 1 saved).
    const fetching = fetchMedia(msg, media).catch((err) => {
      trace('media-error', err.message)
      void notify(`I could not fetch one ${media.kind}, sir: ${err.message}`)
      return null
    })
    const a = albums.get(group) ?? { fetches: [], caption: '' }
    a.fetches.push(fetching)
    if (caption) a.caption = caption
    clearTimeout(a.timer)
    // Closed 3 s after the LAST photo of the album arrived — then every download is awaited.
    a.timer = setTimeout(async () => {
      albums.delete(group)
      const items = (await Promise.all(a.fetches)).filter(Boolean)
      trace('album', `${items.length} of ${a.fetches.length} fetched`)
      if (items.length) await fileOrAsk({ items, caption: a.caption })
    }, 3000)
    albums.set(group, a)
  }

  /** A text reply that answers "which job / which stage" for waiting photos. True if it was handled. */
  async function answerPending(text) {
    if (!pending) return false
    if (Date.now() - pending.at > PENDING_MS) {
      const keep = pending
      pending = null
      savePending()
      if (inboxDir) {
        try {
          const saved = fileBatch({ project: '_unfiled' }, 'construction', keep.items)
          await notify(`The photos you sent earlier weren't filed — I've kept them in ${saved[0].path.replace(/[\\/][^\\/]+$/, '')}.`)
        } catch {}
      }
      return false
    }
    if (/^(cancel|forget (it|them)|ignore)\b/i.test(text)) {
      pending = null
      savePending()
      await notify('Dropped, sir — those photos were not saved.')
      return true
    }
    const combined = `${pending.caption} ${text}`.trim()
    const t = jobFrom(combined)
    const stage = stageFrom(combined)
    // Only treat it as an answer if it moved things on; otherwise it is a new request.
    const helped = (t.job || t.project || t.several) || stage
    if (!helped || text.length > 120) return false
    await fileOrAsk({ items: pending.items, caption: combined })
    return true
  }

  async function handle(msg) {
    const from = String(msg.chat?.id ?? '')
    let text = (msg.text ?? msg.caption ?? '').trim()
    // A voice note is Salman talking to JARVIS; an audio file or an audio
    // document is a recorded phone call to turn into notes and actions.
    const recording = callRecordingIn(msg)
    const voice = msg.voice ?? null
    const doc = recording ? null : msg.document ?? null
    // A photo or video with no caption is still a message — an album carries
    // its caption on ONE photo, and this line used to drop the rest.
    if (!text && !voice && !doc && !recording && !mediaIn(msg)) return
    if (!chatId) {
      // The one moment the bot answers a stranger: telling whoever set it up
      // what to paste. Nothing else is revealed.
      log(`[jarvis:telegram] message from chat ${from} — put TELEGRAM_CHAT_ID=${from} in .env.local to make this your chat`)
      await call('sendMessage', { chat_id: from, text: `Chat id ${from}. Put TELEGRAM_CHAT_ID=${from} in .env.local and restart JARVIS.` }).catch(() => {})
      return
    }
    if (from !== String(chatId)) {
      log(`[jarvis:telegram] ignored a message from chat ${from}`)
      return
    }

    // Site photos and videos: filed by the bridge into the job's folder.
    trace('message', Object.keys(msg).filter((k) => !['message_id', 'from', 'chat', 'date'].includes(k)).join(','))
    const media = mediaIn(msg)
    if (media) return onMedia(msg, media)
    // A short reply that says which job / stage for photos that are waiting.
    if (msg.text && (await answerPending(msg.text.trim()))) return
    // "Call me": ring straight away, no model turn in between — the Shortcut
    // on his phone sends exactly this, and a ring within seconds is the point.
    // "restart" on its own: restart the brain, no model turn — it is what you
    // reach for when the model is the thing that is stuck.
    if (msg.text && restart && /^\s*restart(\s+jarvis)?\s*[.!]?\s*$/i.test(msg.text)) {
      trace('restart', msg.text.trim())
      await notify('Restarting now, sir. Back in about twenty seconds.')
      if (!restart()) await notify('I cannot restart myself — I was not started with npm start. It needs doing at the PC once.')
      return
    }
    if (msg.text && quickCall && isCallMe(msg.text)) {
      trace('quick-call', msg.text.trim())
      await quickCall()
      return
    }
    // "yes 12" / "no 12" / "edit 12: …" — Salman's verdict on proposed lessons —
    // and "send 3" / "cancel 3" for an email held in the outbox. Applied by the
    // bridge itself; no model turn, so nothing but his own message can do it.
    if (msg.text && approvals) {
      const lines = await approvals(msg.text.trim())
      if (lines) {
        trace('lesson-approval', msg.text.trim())
        await notify(lines.join('\n'))
        return
      }
    }

    // A recorded call: keep it, transcribe it here, then hand the transcript to
    // the session with the call-notes steps. Long calls take a minute or two.
    if (recording) {
      if (!inboxDir) {
        await notify('I cannot keep recordings yet, sir — no inbox folder is configured.')
        return
      }
      if ((recording.file_size ?? 0) > 20 * 1024 * 1024) {
        await notify('That recording is over 20 MB, sir, which is more than Telegram lets me fetch. Send the transcript instead: in Notes, copy the transcript and send it to me starting with "Call:".')
        return
      }
      if (!localWhisperAvailable()) {
        await notify('I cannot transcribe calls on this PC yet, sir — faster-whisper is not installed. Paste the transcript starting with "Call:" instead.')
        return
      }
      const when = new Date((msg.forward_date ?? msg.date ?? Date.now() / 1000) * 1000)
      await notify('Got the call recording, sir. Transcribing it here — give me a moment.')
      try {
        const kept = await keepCall(inboxDir, recording.file_name, await download(recording.file_id), when)
        const result = await transcribeFile(kept.audioPath)
        if (!result.text) {
          await notify("I couldn't make out any speech in that recording, sir.")
          return
        }
        const { writeFile } = await import('node:fs/promises')
        await writeFile(kept.transcriptPath, transcriptText(result, { source: recording.file_name, when }), 'utf8')
        text = callNotesPrompt({ transcript: result.text, transcriptPath: kept.transcriptPath, note: text, when })
      } catch (err) {
        await notify(err.message)
        return
      }
    } else if (pastedCallText(text)) {
      text = callNotesPrompt({ transcript: pastedCallText(text), when: new Date((msg.date ?? Date.now() / 1000) * 1000) })
    }

    // A voice note: hear it first. Anything that goes wrong is said back
    // plainly — a silent failure would look like being ignored.
    if (voice) {
      if (!speech?.canTranscribe()) {
        await notify('I have no way to transcribe voice yet, sir — no Fish Audio or ElevenLabs key is configured.')
        return
      }
      await call('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {})
      try {
        const audio = await download(voice.file_id)
        text = await speech.transcribe(audio, voice.mime_type ?? 'audio/ogg')
      } catch (err) {
        await notify(err.message)
        return
      }
      if (!text) {
        await notify("I couldn't make that out, sir.")
        return
      }
    }

    // A file — usually an officer report he opened past a CAPTCHA. Saved to the
    // inbox and handed to the session by path; it is read with the research
    // tools like any other document, never opened or run as anything but a file.
    if (doc) {
      if (!inboxDir) {
        await notify('I cannot keep files yet, sir — no inbox folder is configured.')
        return
      }
      try {
        const { mkdir, writeFile } = await import('node:fs/promises')
        const { join } = await import('node:path')
        const safe = String(doc.file_name ?? 'document').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').slice(0, 120)
        await mkdir(inboxDir, { recursive: true })
        const path = join(inboxDir, `${new Date().toISOString().slice(0, 10)} ${safe}`)
        if ((doc.file_size ?? 0) > 20 * 1024 * 1024) {
          await notify('That file is over 20 MB, sir, which is more than Telegram lets me fetch.')
          return
        }
        await writeFile(path, await download(doc.file_id))
        if (isWhatsAppExport(doc.file_name ?? '')) {
          text = chatNotesPrompt({ text: await readExport(path), fileName: doc.file_name, savedAt: path, note: text })
        } else text =
          `Salman sent a file on Telegram, saved at "${path}"` +
          (text ? `, with the note: "${text}"` : '') +
          '. Open and read it (read_planning_document for PDFs; never judge it by its name). If it belongs to a job, ' +
          'copy it into that project\'s documents folder under PROJECTS and file what matters with ' +
          'project_note (source: "sent by Salman on Telegram"). Tell him in two or three lines what it is, what it says ' +
          'and where it is saved. If you cannot tell which job it belongs to, ask.'
      } catch (err) {
        await notify(`I could not save that file, sir: ${err.message}`)
        return
      }
    }

    if (!session || session.closed) session = makeSession()
    if (session.busy) await session.interrupt()
    await call('sendChatAction', { chat_id: chatId, action: voice ? 'record_voice' : 'typing' }).catch(() => {})
    const typing = setInterval(() => {
      call('sendChatAction', { chat_id: chatId, action: voice ? 'record_voice' : 'typing' }).catch(() => {})
    }, 4500)
    try {
      const { text: answer } = await session.ask(text)
      const reply = answer || 'I have nothing to add, sir.'
      // Voice in, voice out — with the words underneath so nothing is lost.
      await notify(voice ? `You said: "${text}"\n\n${reply}` : reply)
      if (voice) await sendVoice(reply)
    } catch (err) {
      await notify(`I'm afraid that failed, sir: ${err.message}`)
    } finally {
      clearInterval(typing)
    }
  }

  async function poll() {
    while (running) {
      try {
        const updates = await call('getUpdates', { offset, timeout: 25, allowed_updates: ['message'] }, 40_000)
        // (documents arrive as ordinary messages with a `document` field)
        // Handled one at a time, in order, so a voice note and the text after
        // it land on the session in the sequence they were sent.
        for (const u of updates) {
          offset = u.update_id + 1
          if (u.message) await handle(u.message)
        }
      } catch (err) {
        if (!running) break
        log(`[jarvis:telegram] poll: ${err.message}`)
        await new Promise((r) => setTimeout(r, 5000))
      }
    }
  }

  /**
   * A turn started by the bridge rather than by a message — what the user
   * said on a phone call, handed to the same session so it is carried out.
   * The answer lands in the chat like any other.
   */
  async function run(prompt) {
    if (!chatId) return false
    if (!session || session.closed) session = makeSession()
    if (session.busy) await session.interrupt()
    const typing = setInterval(() => {
      call('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {})
    }, 4500)
    try {
      const { text } = await session.ask(prompt)
      await notify(text || 'Done, sir.')
      return true
    } catch (err) {
      await notify(`I'm afraid that failed, sir: ${err.message}`)
      return false
    } finally {
      clearInterval(typing)
    }
  }

  const MIME = {
    '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
    '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.doc': 'application/msword', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.xls': 'application/vnd.ms-excel',
    '.dwg': 'application/acad', '.dxf': 'application/dxf', '.txt': 'text/plain', '.csv': 'text/csv', '.zip': 'application/zip', '.md': 'text/markdown',
  }

  /**
   * A file to the owner's chat — a proposal, a drawing, a photo, a report.
   * As a document by default (the original file, full quality); as_photo shows
   * an image inline instead. Resolves { ok, why }. Telegram bots can send up to 50 MB.
   */
  async function sendFile(path, caption = '', { asPhoto = false } = {}) {
    if (!chatId) return { ok: false, why: 'no Telegram chat configured' }
    try {
      const { readFile, stat } = await import('node:fs/promises')
      const { basename, extname } = await import('node:path')
      const size = (await stat(path)).size
      if (size > 50 * 1024 * 1024) return { ok: false, why: `the file is ${(size / 1048576).toFixed(0)} MB; Telegram allows 50 MB` }
      const ext = extname(path).toLowerCase()
      const photo = asPhoto && /^image\//.test(MIME[ext] ?? '') && size < 10 * 1024 * 1024
      const form = new FormData()
      form.append('chat_id', String(chatId))
      form.append(photo ? 'photo' : 'document', new Blob([await readFile(path)], { type: MIME[ext] ?? 'application/octet-stream' }), basename(path))
      if (caption) form.append('caption', caption.slice(0, 1000))
      const res = await fetch(API(token, photo ? 'sendPhoto' : 'sendDocument'), { method: 'POST', body: form, signal: AbortSignal.timeout(180_000) })
      const data = await res.json().catch(() => ({}))
      if (!data.ok) log(`[jarvis:telegram] file refused: ${data.description ?? res.status}`)
      return data.ok ? { ok: true } : { ok: false, why: data.description ?? `HTTP ${res.status}` }
    } catch (err) {
      log(`[jarvis:telegram] file failed: ${err.message}`)
      return { ok: false, why: err.message }
    }
  }

  /** Kept for the proposal and research tools: true only on a real receipt. */
  const sendDocument = async (path, caption = '') => (await sendFile(path, caption)).ok

  return {
    notify,
    run,
    sendDocument,
    sendFile,
    /** For tests: feed one incoming message as if it came from getUpdates. */
    _handle: (msg) => handle(msg),
    async start({ listen = true } = {}) {
      try {
        const me = await call('getMe')
        known = { ok: true, username: me.username ?? '' }
      } catch (err) {
        log(`[jarvis:telegram] token rejected: ${err.message}`)
        return false
      }
      if (!listen) {
        log(`[jarvis] telegram: sending as @${known.username}; the PC does the listening`)
        return true
      }
      running = true
      void poll()
      log(`[jarvis] telegram ready as @${known.username}${chatId ? '' : ' — waiting for your first message to learn the chat id'}`)
      return true
    },
    stop() {
      running = false
      session?.close()
      session = null
    },
    diag: () => ({
      configured: Boolean(token),
      chatId: Boolean(chatId),
      username: known.username,
      ok: known.ok,
      voiceIn: Boolean(speech?.canTranscribe()),
      voiceOut: Boolean(speech?.canSpeak()),
      pendingPhotos: pending ? pending.items.length : 0,
      recent: events.slice(-12),
    }),
  }
}
