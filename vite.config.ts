import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    // Honour PORT so a second instance can run alongside the first. The bridge
    // only accepts sockets from localhost:5173-5199, so stay inside that range
    // or set JARVIS_ALLOWED_ORIGINS to match.
    port: Number(process.env.PORT) || 5173,
    // The bridge's working files live in data/ (mail state, caches) and change
    // while the face is up; none of them is part of the page. Watching them is
    // noise at best — and a locked file in there kills the watcher with EBUSY
    // and stops the whole launcher, which is how JARVIS's Chrome profile took
    // the face down on 1 Oct 2026. bridge/ is server code the page never loads.
    watch: { ignored: ['**/data/**', '**/bridge/**'] },
    // Reachable from Salman's other devices ONLY through Tailscale: the dev server
    // stays on this PC's loopback, and `tailscale serve` puts it on his private
    // tailnet over HTTPS (which is also what lets the Mac's microphone work).
    // 127.0.0.1 rather than "localhost", which Node binds to ::1 alone — and
    // Tailscale forwards to 127.0.0.1.
    host: '127.0.0.1',
    allowedHosts: ['.ts.net'],
    // The page, opened from another device, reaches the bridge here: same
    // origin, so the one certificate covers both. /bridge/x → bridge /x.
    proxy: {
      '/bridge': {
        target: 'http://127.0.0.1:8787',
        ws: true,
        rewrite: (p) => p.replace(/^\/bridge\/?/, '/'),
      },
    },
  },
  optimizeDeps: {
    // kokoro-js pulls in `phonemizer`, which carries espeak-ng as inline WASM.
    // Vite's dependency pre-bundler rewrites that initialisation and the
    // language table ends up empty — the symptom is
    // `Invalid language identifier: "en". Should be one of: .` at generate()
    // time, long after the model has loaded successfully. Serving these
    // untouched fixes it.
    exclude: ['kokoro-js', 'phonemizer', '@huggingface/transformers'],
  },
})
