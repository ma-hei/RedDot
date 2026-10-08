// The settings menu's texts, in English and German. Which one is chosen when the page is built
// (not in the page itself): VITE_UI_LANGUAGE=de in red-dot/.env.production (or .env.local for
// development); anything else, or nothing, is English. Service names (Google long, Whisper) and
// error messages from the server aren't translated.

import type { Mode } from './settings.ts'

export type UiLanguage = 'en' | 'de'

export const UI_LANGUAGE: UiLanguage = import.meta.env.VITE_UI_LANGUAGE === 'de' ? 'de' : 'en'

interface Texts {
  title: string                                  // the menu's heading, and the button's label
  mode: string
  service: string
  language: string
  modes: Record<Mode, { label: string; hint: string }>
  languages: Record<string, string>              // by id in settings.ts LANGUAGES
  alwaysOn: string
  alwaysOnHint: { stream: string; recording: string }
  alwaysOnUnavailable: string
  engineUnavailable: string
  languageUnavailable: string
  serverOff: string
}

const TEXTS: Record<UiLanguage, Texts> = {
  en: {
    title: 'Speech-to-text',
    mode: 'Mode',
    service: 'Service',
    language: 'Language',
    modes: {
      recording: { label: 'Per utterance', hint: 'transcribe on speech pause' },
      stream: { label: 'Live', hint: 'transcribe immediately' },
      press: { label: 'Per press', hint: 'transcribe when letting go of dot' },
      off: { label: 'Off', hint: 'no speech-to-text' },
    },
    languages: { 'de-DE': 'German', 'en-US': 'English', none: 'Detect' },
    alwaysOn: 'Dot always on',
    alwaysOnHint: {
      stream: 'the dot always listens',
      recording: 'the dot always listens',
    },
    alwaysOnUnavailable: 'only with Per utterance or Live',
    engineUnavailable: "can't stream: only per utterance or per press",
    languageUnavailable: "this service can't detect the language",
    serverOff: 'Off on the server: start the backend with RECORDING_TO_TEXT_URL set.',
  },
  de: {
    title: 'Spracherkennung',
    mode: 'Modus',
    service: 'Dienst',
    language: 'Sprache',
    modes: {
      recording: { label: 'Pro Äußerung', hint: 'bei Sprechpause transkribieren' },
      stream: { label: 'Live', hint: 'sofort transkribieren' },
      press: { label: 'Pro Druck', hint: 'beim Loslassen des Punkts transkribieren' },
      off: { label: 'Aus', hint: 'keine Spracherkennung' },
    },
    languages: { 'de-DE': 'Deutsch', 'en-US': 'Englisch', none: 'Automatisch erkennen' },
    alwaysOn: 'Punkt immer an',
    alwaysOnHint: {
      stream: 'Punkt hört immer zu',
      recording: 'Punkt hört immer zu',
    },
    alwaysOnUnavailable: 'nur mit „Pro Äußerung“ oder „Live“',
    engineUnavailable: 'kann nicht streamen: nur pro Äußerung oder pro Druck',
    languageUnavailable: 'dieser Dienst kann die Sprache nicht erkennen',
    serverOff: 'Auf dem Server aus: das Backend mit RECORDING_TO_TEXT_URL starten.',
  },
}

export const TEXT = TEXTS[UI_LANGUAGE]
