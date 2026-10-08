import { useCallback, useEffect, useRef, useState } from 'react'
import type { PointerEvent } from 'react'
import { createLabels } from './lineLabels.ts'
import { LOOKS, advance, createOrbState } from './looks.ts'
import type { Look, LookName, OrbState } from './looks.ts'
import type { LinkStatus } from './link.ts'
import SettingsPanel from './SettingsPanel.tsx'
import { alwaysOnAllowed, loadChoice, saveChoice, toSettings } from './settings.ts'
import type { Choice } from './settings.ts'
import { createOrbRenderer as createSdfRenderer } from './renderer.ts'
import { createOrbRenderer as createMeshRenderer } from './rendererMesh.ts'
import { useVoiceLink } from './useVoiceLink.ts'
import { addLine, advanceLines, bringToFront, clampLine, createLine, lineAt, placeNewLine, playLine } from './utteranceLines.ts'
import type { LineText, Size, UtteranceLine } from './utteranceLines.ts'
import './RedDot.css'

// Two renderers draw the same picture: renderer.ts (one shader computes every pixel, the
// default) and rendererMesh.ts (triangles + matrices, the classic way). Compare them with
// ?renderer=mesh in the address bar.
const createOrbRenderer =
  new URLSearchParams(location.search).get('renderer') === 'mesh' ? createMeshRenderer : createSdfRenderer

// The console hook (window.orb) is not part of the browser's own types: declare it.
declare global {
  interface Window {
    orb?: { LOOKS: Record<LookName, Look>; state: OrbState; lines: UtteranceLine[] }
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
	
  	// ---- speech-to-text: the settings (⚙), and the text of the line still being spoken ----
  	const [choice, setChoice] = useState<Choice>(loadChoice)
  	const choiceRef = useRef(choice)       // for the animation loop, which runs outside React
  	const [available, setAvailable] = useState<boolean | null>(null)
  	const availableRef = useRef(available)  // for the animation loop, like choiceRef
  	const [textError, setTextError] = useState<string | null>(null)
  	const pending = useRef<LineText | null>(null)
  	// Text for a line that doesn't exist yet (in case it arrives first), by the line's key.
  	const early = useRef(new Map<number, LineText>())

  	// ---- the server connection ----
  	const { status, press, release, cut, configure } = useVoiceLink({
    		onVerdict: (v) => {
      			if (v.speech) orb.current.lastSpeechAt = performance.now()
      			orb.current.level = Math.min(1, v.rms / 3000)
    		},
    		// An utterance is finished: a new line next to the dot, holding its audio.
    		onRecording: (key, recording) => {
      			const canvas = canvasRef.current
      			if (!canvas) return
      			const size = { width: canvas.clientWidth, height: canvas.clientHeight }
      			const at = placeNewLine(lines.current, orb.current.center, LOOKS.pressed.radius, size)
      			const line = createLine(key, recording, at)
      			line.text = early.current.get(key) ?? null
      			early.current.delete(key)
      			addLine(lines.current, line)
    		},
    		// Speech-to-text: for a line (by its key), or for the one still being spoken (line: null).
    		onText: ({ line: key, text, final, confidence }) => {
      			const value = { text, final, confidence }
      			if (text) setTextError(null)
      			if (key === null) {
        				pending.current = value
        				return
      			}
      			const line = lines.current.find((l) => l.key === key)
      			if (line) line.text = value
      			else early.current.set(key, value)
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
  	}, [release])

	// ---- talking: pressing the dot or R ----
	const startTalking = useCallback(() => {
		const s = orb.current
    		if (s.pressed || handsFreeRef.current) return
    		s.pressed = true                  // change the look right away, even while the mic starts
    		pending.current = null            // a new press: no text yet
    		press().then((ok) => { if (!ok) s.pressed = false })
	}, [press])

  	const canvasRef = useRef<HTMLCanvasElement>(null)
  	const labelsRef = useRef<HTMLDivElement>(null)   // the text under the lines, over the canvas
  	const orb = useRef<OrbState>(createOrbState())
  	// The utterance lines, oldest first (the last one is drawn on top).
  	const lines = useRef<UtteranceLine[]>([])
  	// What is being held: the dot, or a line. It follows the pointer. grabX/grabY: where on it
  	// it was picked up (pointer minus its centre, in CSS pixels), so it moves without jumping.
  	// For a line, also when and where it was pressed, to tell a tap (play) from a drag.
  	const drag = useRef<
    		| { kind: 'dot'; pointerId: number; grabX: number; grabY: number
        		downAt: number; downX: number; downY: number; moved: boolean }
    		| { kind: 'line'; line: UtteranceLine; pointerId: number; grabX: number; grabY: number
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
  	}, [])

  	// Hands-free: listen whenever the page is connected and visible. A hidden tab doesn't listen
  	// (privacy, and Google bills every streamed second, silence included).
  	useEffect(() => {
    		handsFreeRef.current = handsFree
    		const s = orb.current
    		const stop = () => {
      			if (!s.pressed) return
      			s.pressed = false
      			release()
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
        				pending.current = null
        				press().then((ok) => { if (!ok) s.pressed = false })
      			}
    		}
    		update()
    		document.addEventListener('visibilitychange', update)
    		return () => document.removeEventListener('visibilitychange', update)
  	}, [handsFree, status, press, release])

  	// ---- the animation loop: starts when the canvas appears, stops when it goes away ----
  	useEffect(() => {
    		const canvas = canvasRef.current
    		const labelBox = labelsRef.current
    		if (!canvas || !labelBox) return        // React sets the refs before effects run; this satisfies TypeScript
    		const renderer = createOrbRenderer(canvas)
    		const labels = createLabels(labelBox)
    		let frameId = 0
    		let last = performance.now()
    		const frame = (now: number) => {
      			const dt = Math.min(0.1, (now - last) / 1000)
      			last = now
      			advance(orb.current, dt, now)
      			advanceLines(lines.current, dt)
      			renderer.draw(orb.current.look, orb.current.phase, orb.current.center, lines.current)
      			// The text of the line being spoken, where that line will appear: "…" while the dot is
      			// held, and in live mode the service's guesses until the line exists.
      			const size = { width: canvas.clientWidth, height: canvas.clientHeight }
      			const on = choiceRef.current.mode !== 'off' && availableRef.current === true
      			const text = pending.current?.text ? pending.current : orb.current.pressed ? { text: '', final: false, confidence: null } : null
      			labels.sync(lines.current, on && text ? {
        				text, at: placeNewLine(lines.current, orb.current.center, LOOKS.pressed.radius, size),
      			} : null, size)
      			frameId = requestAnimationFrame(frame)
    		}
    		frameId = requestAnimationFrame(frame)
    		window.orb = { LOOKS, state: orb.current, lines: lines.current }  // for experimenting in the browser console
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
      			if (handsFreeRef.current) cut()   // hands-free: R ends the current line, like a click on the dot
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
  	}, [startTalking, stopTalking, cut])

  	// The pointer on the canvas, in CSS pixels, and the canvas size.
  	const pointer = (e: PointerEvent<HTMLCanvasElement>): [x: number, y: number, size: Size] => {
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

  	// A line: a short tap plays it, anything else drags it (like the dot, but without recording).
  	const TAP_MS = 400       // pressed for less than this...
  	const TAP_MOVE_PX = 8    // ...and moved less than this: a tap

  	const moveLine = (e: PointerEvent<HTMLCanvasElement>) => {
    		const d = drag.current
    		if (d?.kind !== 'line' || d.pointerId !== e.pointerId) return
    		const [x, y, size] = pointer(e)
    		if (Math.hypot(x - d.downX, y - d.downY) > TAP_MOVE_PX) d.moved = true
    		if (!d.moved) return             // don't shift it by a pixel or two during a tap
    		const [cx, cy] = clampLine(x - d.grabX, y - d.grabY, size)
    		d.line.center = [cx / size.width, cy / size.height]
  	}

  	const isOnSomething = (e: PointerEvent<HTMLCanvasElement>): boolean => {
    		const [x, y, size] = pointer(e)
    		return lineAt(lines.current, x, y, size) !== null || isOnDot(e)
  	}

  	const letGo = (e: PointerEvent<HTMLCanvasElement>) => {
    		const d = drag.current
    		if (d?.kind === 'line') {
      			drag.current = null
      			const tap = !d.moved && performance.now() - d.downAt < TAP_MS
      			if (tap && e.type === 'pointerup') playLine(d.line)  // a tap: play its utterance
    		} else if (d?.kind === 'dot' && handsFreeRef.current) {
      			drag.current = null
      			const tap = !d.moved && performance.now() - d.downAt < TAP_MS
      			if (tap && e.type === 'pointerup') cut()  // hands-free: a click on the dot ends the current line
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
        			// Lines first: they are drawn on top of the dot.
        			const [x, y, size] = pointer(e)
        			const line = lineAt(lines.current, x, y, size)
        			if (line) {
          				e.currentTarget.setPointerCapture(e.pointerId)
          				bringToFront(lines.current, line)
          				drag.current = {
            					kind: 'line', line, pointerId: e.pointerId,
            					grabX: x - line.center[0] * size.width, grabY: y - line.center[1] * size.height,
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
      			onPointerMove={(e) => {
        			if (drag.current?.kind === 'dot') moveDot(e)    // held: the dot follows
        			else if (drag.current?.kind === 'line') moveLine(e)
        			else e.currentTarget.style.cursor = isOnSomething(e) ? 'grab' : 'default'
      			}}
    		/>
    		<div ref={labelsRef} className="reddot-labels" aria-live="polite" />
    		<SettingsPanel choice={choice} onChange={changeChoice} available={available} error={available === false ? null : textError} />
    		</div>
  	)
};
