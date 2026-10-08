// The speech-to-text settings: what the ⚙ panel offers, and what the server gets (link.ts).
// No React here. The choices are remembered in the browser (localStorage).

import type { TranscriptionSettings } from './link.ts'
import { TEXT } from './uiText.ts'

export type Mode = TranscriptionSettings['mode']

export interface Engine {
  id: string
  label: string
  service: string
  model: string | null
  streams: boolean           // can be used live (mode 1); otherwise only with whole recordings (modes 2 and 3)
  detectsLanguage: boolean   // works without a language
}

// In the order the menu shows them; the texts are in uiText.ts (English or German).
export const MODES: { id: Mode; label: string; hint: string }[] =
  (['recording', 'stream', 'press', 'off'] as const).map((id) => ({ id, ...TEXT.modes[id] }))

export const ENGINES: Engine[] = [
  { id: 'google-long', label: 'Google long', service: 'google', model: 'long', streams: true, detectsLanguage: false },
  { id: 'google-chirp_2', label: 'Google chirp_2', service: 'google', model: 'chirp_2', streams: true, detectsLanguage: true },
  { id: 'whisper', label: 'Whisper', service: 'whisper', model: null, streams: false, detectsLanguage: true },
]

export const LANGUAGES: { id: string; label: string }[] =
  ['de-DE', 'en-US', 'none'].map((id) => ({ id, label: TEXT.languages[id] }))

/** What the panel shows: ids from the lists above. */
export interface Choice {
  mode: Mode
  engine: string
  language: string
  // The dot listens all the time, without holding (only Live and Per utterance, see
  // alwaysOnAllowed). A click on the dot then ends the current line.
  alwaysOn: boolean
}

export const DEFAULT_CHOICE: Choice = { mode: 'stream', engine: 'google-long', language: 'de-DE', alwaysOn: false }

/** "Dot always on" makes sense where lines don't depend on holding: Live and Per utterance. */
export function alwaysOnAllowed(mode: Mode): boolean {
  return mode === 'stream' || mode === 'recording'
}

const engineOf = (choice: Choice): Engine => ENGINES.find((e) => e.id === choice.engine) ?? ENGINES[0]

/** Can this engine / language be picked with the rest of the choice? (for greying out options) */
export function engineAllowed(engine: Engine, mode: Mode): boolean {
  return mode !== 'stream' || engine.streams
}
export function languageAllowed(language: string, choice: Choice): boolean {
  return language !== 'none' || engineOf(choice).detectsLanguage
}

/** Repairs a choice that isn't possible (e.g. Whisper live): picks the nearest one that is. */
export function fixChoice(choice: Choice): Choice {
  const fixed = { ...choice }
  if (!MODES.some((m) => m.id === fixed.mode)) fixed.mode = DEFAULT_CHOICE.mode
  if (!ENGINES.some((e) => e.id === fixed.engine) || !engineAllowed(engineOf(fixed), fixed.mode)) {
    fixed.engine = ENGINES.find((e) => engineAllowed(e, fixed.mode))!.id
  }
  if (!LANGUAGES.some((l) => l.id === fixed.language) || !languageAllowed(fixed.language, fixed)) {
    fixed.language = DEFAULT_CHOICE.language
  }
  fixed.alwaysOn = fixed.alwaysOn === true  // kept when switching to a mode without it, but not used there
  return fixed
}

/** The settings the server gets. */
export function toSettings(choice: Choice): TranscriptionSettings {
  const engine = engineOf(choice)
  return {
    mode: choice.mode,
    service: engine.service,
    model: engine.model,
    language: choice.language === 'none' ? null : choice.language,
  }
}

const STORAGE_KEY = 'reddot.transcription'

export function loadChoice(): Choice {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as Partial<Choice> | null
    return fixChoice({ ...DEFAULT_CHOICE, ...saved })
  } catch {
    return DEFAULT_CHOICE  // nothing saved, or storage blocked (e.g. a private window)
  }
}

export function saveChoice(choice: Choice): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(choice))
  } catch { /* storage blocked: the choice just isn't remembered */ }
}
