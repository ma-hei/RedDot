/// <reference types="vite/client" />

// The build-time settings (red-dot/.env.production, or .env.local for development). Vite writes
// their values into the built page; they can't be changed in the page itself.
interface ImportMetaEnv {
  readonly VITE_BACKEND_URL?: string   // the backend's public address; empty: the page's own (development)
  readonly VITE_UI_LANGUAGE?: string   // "de": the settings menu in German; anything else: English
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
