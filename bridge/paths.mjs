import { join } from 'node:path'

/**
 * Where everything JARVIS makes or keeps lives. One place, so nothing drifts.
 *
 * Salman's rule (28 Sep 2026): JARVIS's work goes under D:\APP DEVLOPMENT —
 * never into D:\BUILDING REGULATIONS. That folder is his practice library;
 * JARVIS reads from it (memory, settings) but does not write there.
 */
// On the Mac this is the PC's folder, mounted (see platform.mjs); set JARVIS_WORK_DIR.
export const WORK_ROOT = process.env.JARVIS_WORK_DIR ?? (process.platform === 'win32' ? 'D:\\APP DEVLOPMENT' : '/Volumes/APP DEVLOPMENT')

export const PATHS = {
  projects: process.env.JARVIS_PROJECTS_DIR ?? join(WORK_ROOT, 'PROJECTS'),
  proposals: process.env.JARVIS_PROPOSALS_DIR ?? join(WORK_ROOT, 'FEE PROPOSALS'),
  inbox: process.env.JARVIS_INBOX_DIR ?? join(WORK_ROOT, 'INBOX'),
  guides: join(WORK_ROOT, 'PRACTICE GUIDES'),
}

/** Salman's running jobs list (moved here from D:\BUILDING REGULATIONS on 28 Sep 2026). */
export const JOBS_FILE = process.env.JARVIS_JOBS_FILE ?? join(WORK_ROOT, 'JOBS.md')

export const LOGO_FILE = process.env.JARVIS_LOGO ?? join(PATHS.guides, 'SYDS_Logo_transparent.png')
export const STYLE_GUIDE_FILE = join(PATHS.guides, 'Fee Proposal House Style.md')
export const RESEARCH_METHOD_FILE = join(PATHS.guides, 'Property Research Method.md')
