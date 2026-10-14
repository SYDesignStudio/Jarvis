import { spawn, spawnSync } from 'node:child_process'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { localWhisperAvailable, transcribeFile } from '../calls/index.mjs'

/**
 * Speech for the surfaces that have no browser: hearing a voice note and
 * answering with one. Hearing is done on this PC first (faster-whisper on the
 * graphics card — free, private, a few seconds); Fish Audio or ElevenLabs only
 * if that is not installed. Speaking uses Fish Audio, then ElevenLabs.
 */

const fishKey = () => process.env.FISH_AUDIO_API_KEY || null
const elevenKey = () => process.env.ELEVENLABS_API_KEY || null
const FISH_VOICE = () => process.env.JARVIS_FISH_VOICE_ID ?? '612b878b113047d9a770c069c8b4fdfe'
const FISH_MODEL = () => process.env.JARVIS_FISH_MODEL ?? 's2.1-pro-free'
const ELEVEN_VOICE = () => process.env.JARVIS_VOICE_ID ?? 'JBFqnCBsd6RMkjVDRZzb'

const localHearing = () => process.env.JARVIS_LOCAL_STT !== '0' && localWhisperAvailable()
export const canTranscribe = () => Boolean(localHearing() || fishKey() || elevenKey())
export const canSpeak = () => Boolean(fishKey() || elevenKey())

/** Fish marks speakers inline; the words are all the model should see. */
export const cleanTranscript = (text) =>
  String(text ?? '')
    .replace(/<\|[^|]*\|>/g, '')
    .replace(/\[(?:laughs?|music|noise|applause|silence)[^\]]*\]/gi, '')
    .replace(/\s+/g, ' ')
    .trim()

const extFor = (type) =>
  /ogg|opus/.test(type) ? 'ogg' : /mp4|m4a|aac/.test(type) ? 'm4a' : /mpeg|mp3/.test(type) ? 'mp3' : /wav/.test(type) ? 'wav' : 'webm'

/**
 * Words out of audio. Throws with a sentence fit to send back to the user.
 */
export async function transcribe(buffer, type = 'audio/ogg') {
  const blob = new Blob([buffer], { type })
  const ext = extFor(type)
  if (localHearing()) {
    const dir = await mkdtemp(join(tmpdir(), 'jarvis-voice-'))
    try {
      const file = join(dir, `voice.${ext}`)
      await writeFile(file, buffer)
      const result = await transcribeFile(file, { timeoutMs: 5 * 60_000 })
      return cleanTranscript(result.text)
    } catch (err) {
      // Fall through to a paid provider if there is one; otherwise say what broke.
      if (!fishKey() && !elevenKey()) throw err
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  }
  if (fishKey()) {
    const form = new FormData()
    form.append('audio', blob, `voice.${ext}`)
    form.append('language', 'en')
    form.append('ignore_timestamps', 'true')
    const res = await fetch('https://api.fish.audio/v1/asr', {
      method: 'POST',
      headers: { authorization: `Bearer ${fishKey()}` },
      body: form,
      signal: AbortSignal.timeout(60_000),
    })
    if (res.status === 402) {
      throw new Error(
        'I can hear you, sir, but transcription needs Fish Audio API credit. Add some at fish.audio/app/developers and I shall listen.',
      )
    }
    if (!res.ok) throw new Error(`Transcription failed (${res.status}).`)
    const data = await res.json()
    return cleanTranscript(data.text)
  }
  if (elevenKey()) {
    const form = new FormData()
    form.append('model_id', 'scribe_v1')
    form.append('file', blob, `voice.${ext}`)
    const res = await fetch('https://api.elevenlabs.io/v1/speech-to-text', {
      method: 'POST',
      headers: { 'xi-api-key': elevenKey() },
      body: form,
      signal: AbortSignal.timeout(60_000),
    })
    if (!res.ok) throw new Error(`Transcription failed (${res.status}).`)
    const data = await res.json()
    return cleanTranscript(data.text)
  }
  throw new Error('I have no way to transcribe voice yet, sir — no Fish Audio or ElevenLabs key is configured.')
}

/**
 * Audio out of words. `format` is 'opus' (an OGG voice note) or 'mp3'.
 * Returns { buffer, mime, ext } or throws.
 */
export async function synthesise(text, format = 'opus') {
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, 2500)
  if (!clean) throw new Error('nothing to say')
  if (fishKey()) {
    const res = await fetch('https://api.fish.audio/v1/tts', {
      method: 'POST',
      headers: { authorization: `Bearer ${fishKey()}`, 'content-type': 'application/json', model: FISH_MODEL() },
      body: JSON.stringify({ text: clean, reference_id: FISH_VOICE(), format }),
      signal: AbortSignal.timeout(90_000),
    })
    if (!res.ok) throw new Error(`speech failed (${res.status})`)
    const buffer = Buffer.from(await res.arrayBuffer())
    return format === 'opus'
      ? { buffer, mime: 'audio/ogg', ext: 'ogg' }
      : { buffer, mime: 'audio/mpeg', ext: 'mp3' }
  }
  if (elevenKey()) {
    const res = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${ELEVEN_VOICE()}?output_format=mp3_22050_32`,
      {
        method: 'POST',
        headers: { 'xi-api-key': elevenKey(), 'content-type': 'application/json' },
        body: JSON.stringify({ text: clean, model_id: 'eleven_flash_v2_5' }),
        signal: AbortSignal.timeout(90_000),
      },
    )
    if (!res.ok) throw new Error(`speech failed (${res.status})`)
    const mp3 = Buffer.from(await res.arrayBuffer())
    if (format === 'opus' && ffmpegAvailable()) return { buffer: await toOggOpus(mp3), mime: 'audio/ogg', ext: 'ogg' }
    return { buffer: mp3, mime: 'audio/mpeg', ext: 'mp3' }
  }
  throw new Error('no speech provider configured')
}

let ffmpegOk = null
export function ffmpegAvailable() {
  if (ffmpegOk === null) ffmpegOk = spawnSync('ffmpeg', ['-version'], { windowsHide: true }).status === 0
  return ffmpegOk
}

/** mp3 → OGG/Opus, which is the only thing Telegram shows as a voice bubble. */
export function toOggOpus(mp3) {
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', ['-loglevel', 'error', '-i', 'pipe:0', '-c:a', 'libopus', '-b:a', '32k', '-f', 'ogg', 'pipe:1'], { windowsHide: true })
    const out = []
    p.stdout.on('data', (d) => out.push(d))
    p.on('error', reject)
    p.on('close', (code) => (code === 0 ? resolve(Buffer.concat(out)) : reject(new Error(`ffmpeg exited ${code}`))))
    p.stdin.end(mp3)
  })
}
