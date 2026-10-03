import { useCallback } from 'react'
import type { LinkStatus } from './link.ts'
import RedDot from './RedDot.tsx'

// /orb: the orb, full screen. The connection status goes into the tab's title.
export default function RedDotPage() {
  // useCallback keeps this function the same between renders, so SpeechOrb's effect that
  // reports the status doesn't re-run for nothing.
  const showStatus = useCallback((status: LinkStatus) => {
    document.title = status === 'connected' ? 'Speech orb' : `Speech orb — ${status}`
  }, [])

  return (
    <main className="reddot-page">
      <RedDot onStatusChange={showStatus} />
    </main>
  )
}

