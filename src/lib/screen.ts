/**
 * The user's screen, when they have chosen to share it.
 *
 * Three rules, all about not lying:
 *   - a frame is captured at the moment of asking, never cached from earlier;
 *   - if the share has ended, the answer says so rather than using a memory;
 *   - JPEG is what is encoded, so image/jpeg is what is declared.
 *
 * The stillness watch costs nothing until it needs to think: every few seconds
 * a tiny thumbnail is diffed locally against the last one. No frame leaves the
 * machine for that — only when the screen has sat unchanged long enough does
 * one frame go to the brain, and only for a nudge.
 */

/** How often the stillness watch samples. */
export const STILL_SAMPLE_MS = 5000
/** Colleague pace: stared at the same thing this long before a nudge. */
export const STARE_MS = 4 * 60_000
/** And then leave them alone for this long. */
export const NUDGE_COOLDOWN_MS = 10 * 60_000
/** Mean per-pixel change (0..255) that counts as the screen having moved. */
const CHANGE_THRESHOLD = 3
/** Frames sent to the brain are capped at this width; detail past it is tokens, not sight. */
const MAX_W = 1920

let stream: MediaStream | null = null
let video: HTMLVideoElement | null = null
let surface = ''
let onEnded: (() => void) | null = null

let stillTimer: ReturnType<typeof setInterval> | null = null
let lastThumb: Uint8ClampedArray | null = null
let stillSince = 0

export const diag = { live: false, surface: '', lastDiff: 0, stillSeconds: 0 }
if (typeof window !== 'undefined') {
  ;(window as unknown as Record<string, unknown>).__screen = diag
}

export const shareLive = () => Boolean(stream && video && stream.getVideoTracks()[0]?.readyState === 'live')
export const shareSurface = () => surface

/** Starts the picker. Must be called from a click or key press — browsers insist. */
export async function startShare(ended: () => void): Promise<void> {
  if (shareLive()) return
  const s = await navigator.mediaDevices.getDisplayMedia({
    // Entire screen first in the picker. A single tab keeps rendering itself
    // while you wander, so it can never show what you are actually doing.
    video: { displaySurface: 'monitor', frameRate: 5 },
    audio: false,
    // Chrome-only hints; unknown keys are ignored elsewhere.
    ...({ selfBrowserSurface: 'exclude', monitorTypeSurfaces: 'include' } as object),
  } as DisplayMediaStreamOptions)

  const el = document.createElement('video')
  el.muted = true
  el.playsInline = true
  el.srcObject = s
  await el.play()

  stream = s
  video = el
  onEnded = ended
  const track = s.getVideoTracks()[0]
  surface = String((track.getSettings() as { displaySurface?: string }).displaySurface ?? '')
  diag.live = true
  diag.surface = surface
  // The browser's own "Stop sharing" bar ends the track without asking us.
  track.addEventListener('ended', () => stopShare())
  startStillness()
}

export function stopShare(): void {
  stopStillness()
  stream?.getTracks().forEach((t) => t.stop())
  if (video) video.srcObject = null
  stream = null
  video = null
  surface = ''
  diag.live = false
  diag.surface = ''
  const cb = onEnded
  onEnded = null
  cb?.()
}

/** One frame, now. Throws with a sentence the brain can pass on. */
export function grabScreen(): { data: string; mimeType: string; surface: string } {
  if (!shareLive() || !video?.videoWidth) {
    throw new Error(
      'Screen sharing is off, so I cannot see the screen. Tell the user to press S ' +
        '(or click SHARE SCREEN) and choose Entire screen.',
    )
  }
  const scale = Math.min(1, MAX_W / video.videoWidth)
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(video.videoWidth * scale)
  canvas.height = Math.round(video.videoHeight * scale)
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('could not read the screen frame')
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
  const url = canvas.toDataURL('image/jpeg', 0.82)
  return { data: url.slice(url.indexOf(',') + 1), mimeType: 'image/jpeg', surface }
}

/* ---------------------------------------------------------------- stillness */

function thumb(): Uint8ClampedArray | null {
  if (!video?.videoWidth) return null
  const c = document.createElement('canvas')
  c.width = 64
  c.height = 36
  const ctx = c.getContext('2d', { willReadFrequently: true })
  if (!ctx) return null
  ctx.drawImage(video, 0, 0, 64, 36)
  return ctx.getImageData(0, 0, 64, 36).data
}

function startStillness() {
  stopStillness()
  lastThumb = null
  stillSince = Date.now()
  stillTimer = setInterval(() => {
    const t = thumb()
    if (!t) return
    if (lastThumb) {
      let sum = 0
      for (let i = 0; i < t.length; i += 4) {
        sum += Math.abs(t[i] - lastThumb[i]) + Math.abs(t[i + 1] - lastThumb[i + 1]) + Math.abs(t[i + 2] - lastThumb[i + 2])
      }
      const diff = sum / ((t.length / 4) * 3)
      diag.lastDiff = Math.round(diff * 10) / 10
      if (diff > CHANGE_THRESHOLD) stillSince = Date.now()
    }
    lastThumb = t
    diag.stillSeconds = Math.round((Date.now() - stillSince) / 1000)
  }, STILL_SAMPLE_MS)
}

function stopStillness() {
  if (stillTimer) clearInterval(stillTimer)
  stillTimer = null
  lastThumb = null
}

/** How long the screen has sat unchanged, or 0 when not sharing. */
export const stillFor = () => (shareLive() ? Date.now() - stillSince : 0)
/** Call after a nudge so the next one waits for a fresh stare. */
export const resetStill = () => {
  stillSince = Date.now()
}
