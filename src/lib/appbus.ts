/**
 * How a JARVIS-built app hands JARVIS a request.
 *
 * Apps run in sandboxed iframes with no way to reach the agent socket; the one
 * thing they may do is ask the face to put words in front of JARVIS, exactly
 * as if Salman had typed them. The App component registers the handler once;
 * the app blade calls it.
 */
let handler: ((text: string) => void) | null = null

export function setAskHandler(fn: ((text: string) => void) | null): void {
  handler = fn
}

export function askFromApp(text: string): boolean {
  if (!handler) return false
  handler(text)
  return true
}
