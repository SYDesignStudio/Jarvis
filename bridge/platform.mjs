import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { WORK_ROOT } from './paths.mjs'

/**
 * One JARVIS, two bodies.
 *
 * The brain runs on Salman's Windows PC, which stays on, and on his MacBook,
 * which travels. Everything that differs between the two is settled here, once:
 * where the practice library and the NAS are, which Chrome to launch, which
 * Python runs the transcriber, and which machine OWNS the things only one may
 * own. Nothing else in the bridge asks what platform it is on.
 *
 * Shared memory: the Mac mounts the PC's D:\APP DEVLOPMENT (over Tailscale)
 * and the NAS, and points JARVIS_WORK_DIR, JARVIS_LIBRARY_DIR and
 * JARVIS_NAS_SHARE at the mounts — so the tracker, knowledge, project notes,
 * JOBS.md and held emails are the same files on both.
 *
 * Ownership (JARVIS_SATELLITE=1 on the Mac): only one JARVIS may poll the
 * Telegram bot, watch the inboxes or run the background sweeps — two would
 * fight over one bot and double-handle every email. The satellite still reads
 * mail, still sends Telegram messages, still does everything asked of it.
 */

export const IS_WIN = process.platform === 'win32'
export const IS_MAC = process.platform === 'darwin'
export const SATELLITE = process.env.JARVIS_SATELLITE === '1'

/** Salman's practice library — read, never written. */
export const LIBRARY_ROOT = process.env.JARVIS_LIBRARY_DIR ?? (IS_WIN ? 'D:\\BUILDING REGULATIONS' : '/Volumes/BUILDING REGULATIONS')

/** The NAS share holding the job folders. */
export const NAS_SHARE = process.env.JARVIS_NAS_SHARE ?? (IS_WIN ? '\\\\192.168.0.105\\salman_nas' : '/Volumes/salman_nas')
export const NAS_JOBS = join(NAS_SHARE, 'My Work', '02 - SY Design Studio')

/** Where the agent sessions run — the library when it is reachable, else home. */
export const SESSION_CWD = process.env.JARVIS_CWD ?? (existsSync(LIBRARY_ROOT) ? LIBRARY_ROOT : homedir())

/** Google Chrome, for JARVIS's own browser window and for printing PDFs. */
export const CHROME_CANDIDATES = [
  process.env.JARVIS_CHROME_EXE,
  process.env.JARVIS_CHROME,
  ...(IS_WIN
    ? [
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
        'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
      ]
    : IS_MAC
      ? [
          '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
          join(homedir(), 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
          '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
        ]
      : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser']),
].filter(Boolean)
export const CHROME = CHROME_CANDIDATES.find((p) => existsSync(p)) ?? CHROME_CANDIDATES[0]

/** The Python that runs the transcriber: the launcher on Windows, python3 elsewhere. */
export const PYTHON = process.env.JARVIS_PYTHON ?? (IS_WIN ? 'py' : 'python3')

/** How this machine is described to the model, so its instructions use the paths it can actually reach. */
export const machineNote = () =>
  IS_WIN
    ? "You are running on Salman's Windows PC, the always-on home of JARVIS."
    : `You are running on Salman's MacBook. The shared work folder is ${WORK_ROOT} and the practice library ${LIBRARY_ROOT} (mounted from the PC); the NAS is ${NAS_SHARE}. ` +
      (SATELLITE ? 'The PC owns Telegram, the inbox watchers and the background jobs; you still read mail and send Telegram messages when asked. ' : '') +
      'Reading what is on screen and the Windows window reader are not available here.'

/** The Tailscale CLI, for learning this machine's tailnet name (the Mac app does not put it on PATH). */
export const TAILSCALE =
  [process.env.JARVIS_TAILSCALE, ...(IS_WIN ? ['C:\Program Files\Tailscale\tailscale.exe'] : IS_MAC ? ['/Applications/Tailscale.app/Contents/MacOS/Tailscale', '/opt/homebrew/bin/tailscale'] : [])]
    .filter(Boolean)
    .find((p) => existsSync(p)) ?? 'tailscale'
