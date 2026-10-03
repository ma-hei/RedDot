import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// Development only: where the red dot backend (src/components/RedDotCode/redDotServer) runs.
// The built app (npm run build) doesn't use this proxy: it calls VITE_BACKEND_URL directly.
const BACKEND = 'http://localhost:8090'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    // The page comes from Vite (port 5173) and calls "/ws" and "/healthz" on its own address;
    // these are forwarded to the backend. Without this, Vite would answer /healthz with the
    // page itself (so the page thinks the backend is up) and the WebSocket would go nowhere.
    proxy: {
      '/ws': { target: BACKEND, ws: true },  // the WebSocket: microphone audio, verdicts, utterances
      '/healthz': BACKEND,                    // polled while the backend is down
    },
  },
})
