import { useCallback, useEffect, useRef, useState } from 'react'
import { createLink, type Link, type LinkCallbacks, type LinkStatus, type TranscriptionSettings } from './link.ts'

type Handlers = Pick<LinkCallbacks, 'onVerdict' | 'onRecording' | 'onText' | 'onTranscription' | 'onTextError'>

export interface VoiceLink {
  status: LinkStatus
  press: () => Promise<boolean>
  release: () => void
  cut: () => void
  configure: (settings: TranscriptionSettings) => void
}

export function useVoiceLink(callbacks: Handlers = {}): VoiceLink {
  const [status, setStatus] = useState<LinkStatus>('connecting')
  const linkRef = useRef<Link | null>(null)
  const settingsRef = useRef<TranscriptionSettings | null>(null)  // in case configure() comes before the link exists

  // Always call the newest callbacks, without reconnecting when the component passes new ones.
  const handlers = useRef<Handlers>(callbacks)
  useEffect(() => {
    handlers.current = callbacks
  })

  useEffect(() => {
    const link = createLink({
      onStatus: setStatus,
      onVerdict: (v) => handlers.current.onVerdict?.(v),
      onRecording: (key, u) => handlers.current.onRecording?.(key, u),
      onText: (t) => handlers.current.onText?.(t),
      onTranscription: (available) => handlers.current.onTranscription?.(available),
      onTextError: (message) => handlers.current.onTextError?.(message),
    })
    linkRef.current = link
    if (settingsRef.current) link.configure(settingsRef.current)
    return () => {        // cleanup: runs when the component unmounts
      link.dispose()
      linkRef.current = null
    }
  }, [])                  // [] = only on mount/unmount, not on every render

  // Stable functions (same identity on every render), safe to use in other effects.
  const press = useCallback(() => linkRef.current?.press() ?? Promise.resolve(false), [])
  const release = useCallback(() => linkRef.current?.release(), [])
  const cut = useCallback(() => linkRef.current?.cut(), [])
  const configure = useCallback((s: TranscriptionSettings) => {
    settingsRef.current = s
    linkRef.current?.configure(s)
  }, [])

  return { status, press, release, cut, configure }
}

