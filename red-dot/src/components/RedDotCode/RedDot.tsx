import { useCallback, useEffect, useRef, useState } from 'react'
import type { MouseEvent, PointerEvent } from 'react'
import { createLabels } from './bubbleLabels.ts'
import type { Labels, LiveText } from './bubbleLabels.ts'
import { LOOKS, advance, createOrbState } from './looks.ts'
import type { Look, LookName, OrbState } from './looks.ts'
import type { LinkStatus } from './link.ts'
import SettingsPanel from './SettingsPanel.tsx'
import { alwaysOnAllowed, loadChoice, saveChoice, toSettings } from './settings.ts'
import type { Choice } from './settings.ts'
import { createOrbRenderer as createSdfRenderer } from './renderer.ts'
import { createOrbRenderer as createMeshRenderer } from './rendererMesh.ts'
import { useVoiceLink } from './useVoiceLink.ts'
import {
  addUtterance, advanceBubbles, bringToFront, bubbleAt, bubbleShape, endUtterance, findUtterance, moveBubble,
  openBubble, placeNewBubble, playBubble, removeBubble,
} from './speechBubbles.ts'
import type { LineText, Size, SpeechBubble } from './speechBubbles.ts'
import './RedDot.css'

// Two renderers draw the same picture: renderer.ts (one shader computes every pixel, the
// default) and rendererMesh.ts (triangles + matrices, the classic way). Compare them with
// ?renderer=mesh in the address bar.
const createOrbRenderer =
  new URLSearchParams(location.search).get('renderer') === 'mesh' ? createMeshRenderer : createSdfRenderer

// The console hook (window.orb) is not part of the browser's own types: declare it.
declare global {
  interface Window {
    orb?: { LOOKS: Record<LookName, Look>; state: OrbState; bubbles: SpeechBubble[] }
  }
}

export interface SpeechOrbProps {
  /** Called whenever the connection status changes, e.g. to show it somewhere. */
  onStatusChange?: (status: LinkStatus) => void
}

export interface RedDotProps {
  /** Called whenever the connection status changes, e.g. to show it somewhere. */
  onStatusChange?: (status: LinkStatus) => void
}

export default function RedDot({ onStatusChange }: RedDotProps) {
	
  	// ---- speech-to-text: the settings (⚙), and the text of what is still being said ----
  	const [choice, setChoice] = useState<Choice>(loadChoice)
  	const choiceRef = useRef(choice)       // for the animation loop, which runs outside React
  	const [available, setAvailable] = useState<boolean | null>(null)
  	const availableRef = useRef(available)  // for the animation loop, like choiceRef
  	const [textError, setTextError] = useState<string | null>(null)
  	// What is being said right now (Live mode), shown with the bubble it belongs to.
  	const live = useRef<LiveText | null>(null)
  	// Text for an utterance the page doesn't know yet (in case it arrives first), by its key.
  	const early = useRef(new Map<number, LineText>())

  	// ---- the speech bubbles: one per press ----
  	// The bubble of the current press, which the next utterance joins; null: the next one opens a new bubble.
  	const openRef = useRef<SpeechBubble | null>(null)
  	const closeBubble = useCallback(() => {
    		if (openRef.current) openRef.current.open = false
    		openRef.current = null
  	}, [])
  	// The current press's bubble, opened (popping up next to the dot) if there is none.
  	const currentBubble = (): SpeechBubble | null => {
    		const canvas = canvasRef.current
    		if (!canvas) return null
    		if (!openRef.current) {
      			const size = { width: canvas.clientWidth, height: canvas.clientHeight }
      			const binStrip = binRef.current ? canvas.getBoundingClientRect().bottom - binRef.current.getBoundingClientRect().top + 8 : 0
      			openRef.current = openBubble(bubbles.current,
        				placeNewBubble(bubbles.current, orb.current.center, LOOKS.pressed.radius, size, binStrip))
    		}
    		return openRef.current
  	}

  	// ---- the server connection ----
  	const { status, press, release, cut, configure } = useVoiceLink({
    		onVerdict: (v) => {
      			if (v.speech) orb.current.lastSpeechAt = performance.now()
      			orb.current.level = Math.min(1, v.rms / 3000)
    		},
    		// An utterance started: it joins the press's bubble (the first one makes it pop up), which
    		// grows while it's spoken. Ended: its final length and audio. Discarded (a click, a cough): gone.
    		onUtterance: (u) => {
      			const found = findUtterance(bubbles.current, u.key)
      			if (u.event === 'started') {
        				const bubble = currentBubble()
        				if (!bubble || found) return
        				const utterance = addUtterance(bubble, u.key, u.seconds)
        				utterance.text = early.current.get(u.key) ?? null
        				early.current.delete(u.key)
      			} else if (u.event === 'ended') {
        				let utterance = found?.[1]
        				if (!utterance) {          // an older server, without "started": it joins the press's bubble now
          				const bubble = currentBubble()
          				if (!bubble) return
          				utterance = addUtterance(bubble, u.key, u.seconds, false)
          				utterance.text = early.current.get(u.key) ?? null
          				early.current.delete(u.key)
        				}
        				endUtterance(utterance, u.seconds, u.recording)
      			} else if (found) {
        				const [bubble, utterance] = found
        				bubble.utterances.splice(bubble.utterances.indexOf(utterance), 1)
        				if (bubble.utterances.length === 0) {   // it held nothing else: it goes again
          				if (openRef.current === bubble) openRef.current = null
          				removeBubble(bubbles.current, bubble)
        				}
      			}
    		},
    		// Speech-to-text: for an utterance (by its key), or for what is still being said (line: null).
    		onText: ({ line: key, text, final, confidence }) => {
      			const value = { text, final, confidence }
      			if (text) setTextError(null)
      			if (key === null) {
        				// It belongs to the press's bubble, or (just let go) the one that press made.
        				const bubble = openRef.current ?? live.current?.bubble ?? bubbles.current.at(-1)
        				live.current = bubble ? { bubble, text: value } : null
        				return
      			}
      			const found = findUtterance(bubbles.current, key)
      			if (!found) {
        				early.current.set(key, value)
        				return
      			}
      			found[1].text = value
      			if (live.current?.bubble === found[0]) live.current = null   // now part of the utterance's own text
    		},
    		onTranscription: (yes) => {
      			availableRef.current = yes
      			setAvailable(yes)
    		},
    		onTextError: setTextError,
  	})

  	// "Dot always on" (Live and Per utterance): the dot listens all the time ("hands-free"), no
  	// holding; a click on the dot (or R) ends the current line. Otherwise: hold the dot (or R) to talk.
  	const handsFree = choice.alwaysOn && alwaysOnAllowed(choice.mode) && available === true
  	const handsFreeRef = useRef(handsFree)  // for the event handlers below

  	const stopTalking = useCallback(() => {
    		if (handsFreeRef.current) return    // listening doesn't stop by letting go
    		if (drag.current?.kind === 'dot') drag.current = null  // letting go also puts the dot down
    		const s = orb.current
    		if (!s.pressed) return
    		s.pressed = false
    		release()
    		closeBubble()                     // the press is over: its bubble is complete
  	}, [release, closeBubble])

  	// Hands-free: a click on the dot (or R) ends the current line, and with it the bubble.
  	const endLine = useCallback(() => {
    		cut()
    		closeBubble()
  	}, [cut, closeBubble])

	// ---- talking: pressing the dot or R ----
	const startTalking = useCallback(() => {
		const s = orb.current
    		if (s.pressed || handsFreeRef.current) return
    		s.pressed = true                  // change the look right away, even while the mic starts
    		live.current = null               // a new press: no text yet
    		closeBubble()                     // (in case a press didn't end cleanly) a new press, a new bubble
    		press().then((ok) => { if (!ok) s.pressed = false })
	}, [press, closeBubble])

  	const canvasRef = useRef<HTMLCanvasElement>(null)
  	const labelsRef = useRef<HTMLDivElement>(null)   // the text inside the bubbles, over the canvas
  	const labelsApi = useRef<Labels | null>(null)    // what places that text (bubbleLabels.ts), for the wheel
  	const binRef = useRef<HTMLDivElement>(null)      // the bin at the bottom: a bubble dropped on it is removed
  	const orb = useRef<OrbState>(createOrbState())
  	// The speech bubbles, oldest first (the last one is drawn on top).
  	const bubbles = useRef<SpeechBubble[]>([])
  	// What is being held: the dot, or a bubble. It follows the pointer. grabX/grabY: where on it
  	// it was picked up (pointer minus its centre, in CSS pixels), so it moves without jumping.
  	// Also when and where it was pressed, to tell a tap (play, or end the line) from a drag.
  	const drag = useRef<
    		| { kind: 'dot'; pointerId: number; grabX: number; grabY: number
        		downAt: number; downX: number; downY: number; moved: boolean }
    		| { kind: 'bubble'; bubble: SpeechBubble; pointerId: number; grabX: number; grabY: number
        		downAt: number; downX: number; downY: number; moved: boolean }
    		| null
  	>(null)

	useEffect(() => {
    		orb.current.online = status === 'connected'
    		onStatusChange?.(status)
  	}, [status, onStatusChange])

  	// The settings go to the server (again after every reconnect: link.ts) and are remembered.
  	useEffect(() => {
    		choiceRef.current = choice
    		configure(toSettings(choice))
    		saveChoice(choice)
  	}, [choice, configure])
  	const changeChoice = useCallback((next: Choice) => {
    		setChoice(next)
    		setTextError(null)   // a problem with the old settings doesn't apply to the new ones
    		closeBubble()        // while listening, the server ends the current line: the bubble ends with it
  	}, [closeBubble])

  	// Hands-free: listen whenever the page is connected and visible. A hidden tab doesn't listen
  	// (privacy, and Google bills every streamed second, silence included).
  	useEffect(() => {
    		handsFreeRef.current = handsFree
    		const s = orb.current
    		const stop = () => {
      			if (!s.pressed) return
      			s.pressed = false
      			release()
      			closeBubble()
    		}
    		if (!handsFree) {
      			stop()                       // e.g. switched to another mode: back to holding
      			return
    		}
    		const update = () => {
      			if (document.hidden || status !== 'connected') {
        				stop()                     // after a reconnect, update() starts listening again
      			} else if (!s.pressed) {
        				s.pressed = true
        				live.current = null
        				press().then((ok) => { if (!ok) s.pressed = false })
      			}
    		}
    		update()
    		document.addEventListener('visibilitychange', update)
    		return () => document.removeEventListener('visibilitychange', update)
  	}, [handsFree, status, press, release, closeBubble])

  	// ---- the animation loop: starts when the canvas appears, stops when it goes away ----
  	useEffect(() => {
    		const canvas = canvasRef.current
    		const labelBox = labelsRef.current
    		if (!canvas || !labelBox) return        // React sets the refs before effects run; this satisfies TypeScript
    		const renderer = createOrbRenderer(canvas)
    		const labels = createLabels(labelBox)
    		labelsApi.current = labels
    		let frameId = 0
    		let last = performance.now()
    		const frame = (now: number) => {
      			const dt = Math.min(0.1, (now - last) / 1000)
      			last = now
      			const size = { width: canvas.clientWidth, height: canvas.clientHeight }
      			advance(orb.current, dt, now)
      			advanceBubbles(bubbles.current, dt, now, size, orb.current.center)
      			const shapes = bubbles.current.map((b) => bubbleShape(b, size))
      			renderer.draw(orb.current.look, orb.current.phase, orb.current.center, shapes)
      			// The text inside each bubble (with what is being said, in Live mode).
      			const on = choiceRef.current.mode !== 'off' && availableRef.current === true
      			labels.sync(on ? bubbles.current : [], live.current, size)
      			frameId = requestAnimationFrame(frame)
    		}
    		frameId = requestAnimationFrame(frame)
    		window.orb = { LOOKS, state: orb.current, bubbles: bubbles.current }  // for experimenting in the browser console
    		return () => {
      			cancelAnimationFrame(frameId)
      			renderer.dispose()
      			labels.dispose()
    		}
  	}, [])

  	useEffect(() => {
    		// Not while typing or choosing in the settings panel.
    		const inForm = (e: KeyboardEvent) => e.target instanceof HTMLElement && e.target.closest('input, select, textarea, button') !== null
    		const isTalkKey = (e: KeyboardEvent) => e.key.toLowerCase() === 'r' && !e.ctrlKey && !e.metaKey && !e.altKey && !inForm(e)
    		const onKeyDown = (e: KeyboardEvent) => {
      			if (!isTalkKey(e) || e.repeat) return
      			if (handsFreeRef.current) endLine()   // hands-free: R ends the current line, like a click on the dot
      			else startTalking()
    		}
    		const onKeyUp = (e: KeyboardEvent) => { if (e.key.toLowerCase() === 'r') stopTalking() }
    		document.addEventListener('keydown', onKeyDown)
    		document.addEventListener('keyup', onKeyUp)
    		window.addEventListener('blur', stopTalking)  // switched window while holding: count as let go
    		return () => {
      			document.removeEventListener('keydown', onKeyDown)
      			document.removeEventListener('keyup', onKeyUp)
      			window.removeEventListener('blur', stopTalking)
    		}
  	}, [startTalking, stopTalking, endLine])

  	// The pointer on the canvas, in CSS pixels, and the canvas size.
  	const pointer = (e: MouseEvent<HTMLCanvasElement>): [x: number, y: number, size: Size] => {
    		const rect = e.currentTarget.getBoundingClientRect()
    		return [e.clientX - rect.left, e.clientY - rect.top, { width: rect.width, height: rect.height }]
  	}

  	// The pointer relative to the dot's centre, in CSS pixels.
  	const fromDot = (e: PointerEvent<HTMLCanvasElement>): [dx: number, dy: number] => {
    		const rect = e.currentTarget.getBoundingClientRect()
    		const [cx, cy] = orb.current.center
    		return [e.clientX - rect.left - cx * rect.width, e.clientY - rect.top - cy * rect.height]
  	}

  	// Is the pointer on the dot? (a little generous, easier to hit)
  	const isOnDot = (e: PointerEvent<HTMLCanvasElement>): boolean => {
    		const rect = e.currentTarget.getBoundingClientRect()
    		return Math.hypot(...fromDot(e)) <= orb.current.look.radius * Math.min(rect.width, rect.height) * 1.3
  	}

  	// While held: put the dot under the pointer (minus where it was grabbed), but keep all of it
  	// on the screen, so it can always be picked up again.
  	const moveDot = (e: PointerEvent<HTMLCanvasElement>) => {
    		const d = drag.current
    		if (d?.kind !== 'dot' || d.pointerId !== e.pointerId) return
    		const rect = e.currentTarget.getBoundingClientRect()
    		if (Math.hypot(e.clientX - rect.left - d.downX, e.clientY - rect.top - d.downY) > TAP_MOVE_PX) d.moved = true
    		const { radius, wobble } = orb.current.look
    		const r = radius * (1 + wobble) * Math.min(rect.width, rect.height)  // the dot's outermost edge
    		const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi)
    		const x = clamp(e.clientX - rect.left - d.grabX, r, rect.width - r)
    		const y = clamp(e.clientY - rect.top - d.grabY, r, rect.height - r)
    		orb.current.center = [x / rect.width, y / rect.height]
  	}

  	// A bubble: a short tap plays it, anything else drags it (like the dot, but without recording).
  	const TAP_MS = 400       // pressed for less than this...
  	const TAP_MOVE_PX = 8    // ...and moved less than this: a tap

  	// Is the pointer over the bin? (a little generous, like the bubbles: easier to hit with a finger)
  	const overBin = (e: PointerEvent<HTMLCanvasElement>): boolean => {
    		const r = binRef.current?.getBoundingClientRect()
    		const pad = 12
    		return !!r && e.clientX >= r.left - pad && e.clientX <= r.right + pad && e.clientY >= r.top - pad && e.clientY <= r.bottom + pad
  	}
  	const showBinTarget = (on: boolean) => binRef.current?.classList.toggle('target', on)

  	const dragBubble = (e: PointerEvent<HTMLCanvasElement>) => {
    		const d = drag.current
    		if (d?.kind !== 'bubble' || d.pointerId !== e.pointerId) return
    		const [x, y, size] = pointer(e)
    		if (Math.hypot(x - d.downX, y - d.downY) > TAP_MOVE_PX) d.moved = true
    		if (!d.moved) return             // don't shift it by a pixel or two during a tap
    		moveBubble(d.bubble, x - d.grabX, y - d.grabY, size)
    		showBinTarget(overBin(e))        // the bin lights up: letting go here removes the bubble
  	}

  	const isOnSomething = (e: PointerEvent<HTMLCanvasElement>): boolean => {
    		const [x, y, size] = pointer(e)
    		return bubbleAt(bubbles.current, x, y, size) !== null || isOnDot(e)
  	}

  	const letGo = (e: PointerEvent<HTMLCanvasElement>) => {
    		const d = drag.current
    		if (d?.kind === 'bubble') {
      			drag.current = null
      			showBinTarget(false)
      			const tap = !d.moved && performance.now() - d.downAt < TAP_MS
      			if (tap && e.type === 'pointerup') playBubble(d.bubble)  // a tap: play its utterances
      			else if (d.moved && e.type === 'pointerup' && overBin(e)) {   // dropped on the bin
        				if (openRef.current === d.bubble) openRef.current = null   // still talking: the next utterance opens a new one
        				if (live.current?.bubble === d.bubble) live.current = null
        				removeBubble(bubbles.current, d.bubble)
      			}
    		} else if (d?.kind === 'dot' && handsFreeRef.current) {
      			drag.current = null
      			const tap = !d.moved && performance.now() - d.downAt < TAP_MS
      			if (tap && e.type === 'pointerup') endLine()  // hands-free: a click on the dot ends the current line
    		} else {
      			stopTalking()                    // the dot: stop recording, which also ends its drag
    		}
    		e.currentTarget.style.cursor = isOnSomething(e) ? 'grab' : 'default'
  	}

	return (
    		<div className="reddot-wrap">
    		<canvas
      			ref={canvasRef}
      			className="reddot"
      			onPointerDown={(e) => {
        			// Bubbles first: they are drawn on top of the dot.
        			const [x, y, size] = pointer(e)
        			const bubble = bubbleAt(bubbles.current, x, y, size)
        			if (bubble) {
          				e.currentTarget.setPointerCapture(e.pointerId)
          				bringToFront(bubbles.current, bubble)
          				drag.current = {
            					kind: 'bubble', bubble, pointerId: e.pointerId,
            					grabX: x - bubble.center[0] * size.width, grabY: y - bubble.center[1] * size.height,
            					downAt: performance.now(), downX: x, downY: y, moved: false,
          				}
          				e.currentTarget.style.cursor = 'grabbing'
          				return
        			}
        			if (!isOnDot(e)) return
        			e.currentTarget.setPointerCapture(e.pointerId)  // keep getting moves and pointerup even off the dot
        			const [grabX, grabY] = fromDot(e)
        			drag.current = {                                // lift the dot...
          				kind: 'dot', pointerId: e.pointerId, grabX, grabY,
          				downAt: performance.now(), downX: x, downY: y, moved: false,
        			}
        			e.currentTarget.style.cursor = 'grabbing'
        			startTalking()                                  // ...and start recording (not hands-free: it listens already)
      			}}
      			onPointerUp={letGo}
      			onPointerCancel={letGo}
      			// Holding the dot is a long press, which phones answer with a context menu ("Save
      			// image") and a short vibration, and which can cancel the touch (= letting go).
      			onContextMenu={(e) => e.preventDefault()}
      			// The wheel over a bubble scrolls its text (the text itself lets the pointer through).
      			onWheel={(e) => {
        			const [x, y, size] = pointer(e)
        			const bubble = bubbleAt(bubbles.current, x, y, size)
        			if (bubble) labelsApi.current?.scrollBy(bubble, e.deltaY)
      			}}
      			onPointerMove={(e) => {
        			if (drag.current?.kind === 'dot') moveDot(e)    // held: the dot follows
        			else if (drag.current?.kind === 'bubble') dragBubble(e)
        			else e.currentTarget.style.cursor = isOnSomething(e) ? 'grab' : 'default'
      			}}
    		/>
    		<div ref={labelsRef} className="reddot-labels" aria-live="polite" />
    		<div ref={binRef} className="reddot-bin" aria-hidden="true">
      			<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
        				{/* a bin: lid with handle, and the can with three ribs */}
        				<path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13M10 11v6M14 11v6" fill="none" stroke="currentColor"
              				strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      			</svg>
    		</div>
    		<SettingsPanel choice={choice} onChange={changeChoice} available={available} error={available === false ? null : textError} />
    		</div>
  	)
};
