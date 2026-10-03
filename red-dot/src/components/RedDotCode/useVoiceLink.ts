import { useCallback, useEffect, useRef, useState } from 'react'
import { createLink, type Link, type LinkCallbacks, type LinkStatus } from './link.ts'

type Handlers = Pick<LinkCallbacks, 'onVerdict' | 'onRecording'>

export interface VoiceLink {
  status: LinkStatus
  press: () => Promise<boolean>
  release: () => void
}

export function useVoiceLink({ onVerdict, onRecording }: Handlers = {}): VoiceLink {
  const [status, setStatus] = useState<LinkStatus>('connecting')
  const linkRef = useRef<Link | null>(null)

  // Always call the newest callbacks, without reconnecting when the component passes new ones.
  const handlers = useRef<Handlers>({ onVerdict, onRecording })
  useEffect(() => {
    handlers.current = { onVerdict, onRecording }
  })

  useEffect(() => {
    const link = createLink({
      onStatus: setStatus,
      onVerdict: (v) => handlers.current.onVerdict?.(v),
      onRecording: (u) => handlers.current.onRecording?.(u),
    })
    linkRef.current = link
    return () => {        // cleanup: runs when the component unmounts
      link.dispose()
      linkRef.current = null
    }
  }, [])                  // [] = only on mount/unmount, not on every render

  // Stable functions (same identity on every render), safe to use in other effects.
  const press = useCallback(() => linkRef.current?.press() ?? Promise.resolve(false), [])
  const release = useCallback(() => linkRef.current?.release(), [])

  return { status, press, release }
}

