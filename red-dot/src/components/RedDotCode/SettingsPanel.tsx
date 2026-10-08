import { useState } from 'react'
import { ENGINES, LANGUAGES, MODES, alwaysOnAllowed, engineAllowed, fixChoice, languageAllowed } from './settings.ts'
import type { Choice } from './settings.ts'

export interface SettingsPanelProps {
  choice: Choice
  onChange: (choice: Choice) => void
  available: boolean | null     // does the server offer speech-to-text? null: not known yet
  error: string | null          // the last speech-to-text problem, if any
}

/** The small ⚙ button in the corner, and the speech-to-text settings it opens. */
export default function SettingsPanel({ choice, onChange, available, error }: SettingsPanelProps) {
  const [open, setOpen] = useState(false)
  // A change can make another choice impossible (e.g. Live with Whisper): fixChoice repairs it.
  const set = (change: Partial<Choice>) => onChange(fixChoice({ ...choice, ...change }))

  return (
    <div className="reddot-settings">
      {open && (
        <div className="panel" role="dialog" aria-label="Speech-to-text settings">
          <h2>Speech-to-text</h2>
          {available === false ? (
            <p className="note">Off on the server: start the backend with RECORDING_TO_TEXT_URL set.</p>
          ) : (
            <>
              <fieldset>
                <legend>Mode</legend>
                {MODES.map((m) => (
                  <label key={m.id} title={m.hint}>
                    <input type="radio" name="mode" checked={choice.mode === m.id} onChange={() => set({ mode: m.id })} />
                    {m.label} <span className="hint">{m.hint}</span>
                  </label>
                ))}
                <label className={`checkbox${alwaysOnAllowed(choice.mode) ? '' : ' unavailable'}`}
                       title={alwaysOnAllowed(choice.mode) ? '' : 'only with Per utterance or Live'}>
                  <input type="checkbox" checked={choice.alwaysOn && alwaysOnAllowed(choice.mode)}
                         disabled={!alwaysOnAllowed(choice.mode)} onChange={(e) => set({ alwaysOn: e.target.checked })} />
                  Dot always on <span className="hint">
                    {choice.mode === 'stream' ? 'listens without holding; click the dot for a new line'
                      : 'record while holding'}
                  </span>
                </label>
              </fieldset>
              <fieldset disabled={choice.mode === 'off'}>
                <legend>Service</legend>
                {ENGINES.map((e) => (
                  <label key={e.id} className={engineAllowed(e, choice.mode) ? '' : 'unavailable'}
                         title={engineAllowed(e, choice.mode) ? '' : "can't stream: only per utterance or per press"}>
                    <input type="radio" name="engine" checked={choice.engine === e.id}
                           disabled={!engineAllowed(e, choice.mode)} onChange={() => set({ engine: e.id })} />
                    {e.label}
                  </label>
                ))}
              </fieldset>
              <fieldset disabled={choice.mode === 'off'}>
                <legend>Language</legend>
                {LANGUAGES.map((l) => (
                  <label key={l.id} className={languageAllowed(l.id, choice) ? '' : 'unavailable'}
                         title={languageAllowed(l.id, choice) ? '' : "this service can't detect the language"}>
                    <input type="radio" name="language" checked={choice.language === l.id}
                           disabled={!languageAllowed(l.id, choice)} onChange={() => set({ language: l.id })} />
                    {l.label}
                  </label>
                ))}
              </fieldset>
            </>
          )}
          {error && <p className="error">{error}</p>}
        </div>
      )}
      <button type="button" className={`toggle${error ? ' has-error' : ''}`} aria-expanded={open}
              aria-label="Speech-to-text settings" title="Speech-to-text settings" onClick={() => setOpen(!open)}>
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
          {/* three sliders */}
          <path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          <circle cx="16" cy="6" r="2" fill="none" stroke="currentColor" strokeWidth="2" />
          <circle cx="10" cy="12" r="2" fill="none" stroke="currentColor" strokeWidth="2" />
          <circle cx="18" cy="18" r="2" fill="none" stroke="currentColor" strokeWidth="2" />
        </svg>
      </button>
    </div>
  )
}
