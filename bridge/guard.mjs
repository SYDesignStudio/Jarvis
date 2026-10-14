/**
 * The NAS is Salman's record of every job — JARVIS reads it and never
 * changes it. Enforced as a PreToolUse hook, which runs for every tool call
 * (canUseTool is only asked about calls the CLI has not already settled, so it
 * cannot be relied on for this). Writes of JARVIS's own go under
 * D:\APP DEVLOPMENT; Salman files things on the NAS himself.
 */

const NAS = /(?:\\\\|\/\/)192\.168\.0\.105(?:\\|\/)|salman_nas/i
const FILE_WRITERS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])
const SHELLS = new Set(['Bash', 'PowerShell'])
// Shell verbs that change, move or delete files.
const CHANGES = /(^|[\s;&|(])(rm|rmdir|del|erase|mv|move|ren|rename|mkdir|md|touch|tee|truncate|robocopy|xcopy|remove-item|move-item|rename-item|set-content|add-content|out-file|new-item|clear-content|set-itemproperty)(?=[\s;&|)]|$)|>{1,2}/i
const COPIES = /(^|[\s;&|(])(cp|copy|copy-item)(?=\s)/i

/** Quoted or bare path-like arguments of a command, in order. */
const args = (cmd) => [...String(cmd).matchAll(/"([^"]+)"|'([^']+)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3])

/** A reason string if this call would change something on the NAS, else null. */
export function nasWriteViolation(toolName, input = {}) {
  if (FILE_WRITERS.has(toolName)) {
    const p = input.file_path ?? input.notebook_path ?? input.path ?? ''
    return NAS.test(p) ? `${toolName} to the NAS (${p})` : null
  }
  if (SHELLS.has(toolName)) {
    const cmd = String(input.command ?? '')
    if (!NAS.test(cmd)) return null
    if (CHANGES.test(cmd)) return 'a shell command that would change files on the NAS'
    if (COPIES.test(cmd)) {
      // Copying FROM the NAS is reading; copying TO it (NAS path last) is a write.
      const a = args(cmd).filter((x) => /[\\/]/.test(x))
      if (a.length && NAS.test(a[a.length - 1])) return 'a copy onto the NAS'
    }
  }
  return null
}

/**
 * Hostinger holds both websites, the domains, DNS, email and billing. JARVIS
 * may LOOK (list/get/show/check) and may ask for an upload link — the one
 * write he needs, to put an approved Specline social image in
 * site/static/social/posts via publish.mjs. Everything else — deleting a site,
 * DNS, domains, deploys, databases, billing — is Salman's, and is refused
 * whatever the prompt says. (Salman: "I don't want to change anything on my
 * website.")
 */
const HOSTINGER_READ = /^mcp__hostinger__[A-Za-z]+_(list|get|show|check)[A-Z0-9_]/
const HOSTINGER_ALLOWED = new Set(['mcp__hostinger__hosting_generateUploadURLV1'])

export function hostingerViolation(toolName) {
  const t = String(toolName ?? '')
  if (!t.startsWith('mcp__hostinger__')) return null
  if (HOSTINGER_ALLOWED.has(t) || HOSTINGER_READ.test(t)) return null
  return `the Hostinger action ${t.replace('mcp__hostinger__', '')} (website, domain, DNS and billing changes are Salman's to make)`
}

export const NAS_GUARD_HOOKS = {
  PreToolUse: [
    {
      hooks: [
        async (input) => {
          const host = hostingerViolation(input.tool_name)
          if (host) {
            console.log(`[jarvis] blocked ${host}`)
            return {
              hookSpecificOutput: {
                hookEventName: 'PreToolUse',
                permissionDecision: 'deny',
                permissionDecisionReason: `Blocked: ${host}. Tell Salman what change is needed; he makes it himself.`,
              },
            }
          }
          const why = nasWriteViolation(input.tool_name, input.tool_input)
          if (!why) return {}
          console.log(`[jarvis] blocked ${why}`)
          return {
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              permissionDecision: 'deny',
              permissionDecisionReason:
                `Blocked: ${why}. The NAS job folders are read-only for JARVIS. Save it under D:\\APP DEVLOPMENT instead ` +
                'and tell Salman where it is, so he can file it on the NAS himself.',
            },
          }
        },
      ],
    },
  ],
}
