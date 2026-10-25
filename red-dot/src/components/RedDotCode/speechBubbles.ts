// The speech bubbles: one per press of the dot (with "Dot always on": until the dot is clicked),
// holding that press's utterances and their audio. While its press goes on, a bubble moves with
// the dot and its tail points at the dot; then both stay as they are. No React and no WebGL here:
// the component creates and moves bubbles, the renderers draw their shapes (bubbleShape).
//
//   const bubble = openBubble(bubbles, placeNewBubble(bubbles, dotCenter, dotRadius, size, keepFree))
//   const u = addUtterance(bubble, key, seconds)   // an utterance started: the bubble grows while it's spoken
//   endUtterance(u, seconds, recording)       // ...and ended: its final length and audio
//   bubble.open = false                       // the press is over: the next utterance opens a new bubble
//   advanceBubbles(bubbles, dt, now, size, dotCenter)  // every frame: grow, follow the dot, pop, breathe
//   const shape = bubbleShape(bubble, size)   // what to draw, in CSS pixels
//   bubbleAt(bubbles, x, y, size)             // what's under the pointer (topmost first)
//   moveBubble(bubble, x, y, size)            // dragged: from now on it stays where it's put
//   playBubble(bubble)                        // play all its utterances, one after the other
//   removeBubble(bubbles, bubble)             // gone (dropped on the bin); stops its audio
//
// Sizes: a bubble's `radius` is half its height, as a share of the shorter canvas side (like the
// dot's radius); it eases towards the size its seconds of speech call for (targetRadius).

import { BUBBLE } from './looks.ts'
import type { Recording } from './link.ts'

export const MAX_BUBBLES = 16  // the renderers draw at most this many; older bubbles are dropped

/** What speech-to-text made of an utterance (or of what is still being said). */
export interface LineText {
  text: string                    // "" while waiting for the first result
  final: boolean                  // false: may still change
  confidence: number | null       // 0..1, if the service reports one
}

export interface Utterance {
  key: number                     // the server's name for it: its first chunk number (link.ts)
  seconds: number                 // its length: so far while it's spoken, then its final length
  since: number | null            // while it's spoken: when (performance.now()) it was `seconds` long
  recording: Recording | null     // its audio, once it has ended
  text: LineText | null           // speech-to-text, if it's switched on
}

export interface SpeechBubble {
  id: number
  utterances: Utterance[]         // in the order they were spoken
  open: boolean                   // its press goes on: the next utterance joins it
  center: [x: number, y: number]  // share of the canvas, like the dot ([0.5, 0.5] = middle, y from the top)
  // Until it's dragged: it grows away from the dot, from this point (share of the canvas) in this
  // direction (a unit vector, in pixels), so the dot stays free. While it's open, the point keeps
  // `gap` (share of the shorter side) from the dot's centre, so the bubble moves with the dot.
  // null once it has been dragged.
  growFrom: { at: [x: number, y: number]; dir: [dx: number, dy: number]; gap: number } | null
  tailDir: [dx: number, dy: number]  // where its tail points (a unit vector, in pixels): at the dot while open, then fixed
  radius: number                  // half its height now (eased towards targetRadius)
  age: number                     // seconds since it popped up
  playing: boolean
  glow: number                    // 0..1, eased towards 1 while playing: how much it pulsates
}

/** The canvas size in CSS pixels. */
export interface Size {
  width: number
  height: number
}

/** A circle: centre and radius, in CSS pixels. */
export type Puff = [x: number, y: number, r: number]

/** What the renderers draw for one bubble, in CSS pixels (y from the top): a cloud, i.e. the
 *  round puffs of cloudPuffs(center, radii, seed) around an oval core, and the trail's puffs. */
export interface BubbleShape {
  center: [x: number, y: number]
  radii: [rx: number, ry: number]                       // how far the cloud reaches (its puffs' outer edges)
  seed: number                                          // where its puffs sit (radians): each cloud a little different
  trail: Puff[]                                         // small puffs towards where the tail points
}

/**
 * The cloud's puffs: BUBBLE.puffs circles, evenly around an oval that's smaller than the cloud by
 * a puff's radius, each a little bigger or smaller. The core is a filled oval a little bigger than
 * that (BUBBLE.coreInset), so the cloud is the core plus the puffs. renderer.ts computes the same
 * in its shader (keep both alike).
 */
export function cloudPuffs([cx, cy]: [number, number], [rx, ry]: [number, number], seed: number): { core: [number, number]; puffs: Puff[] } {
  const r = ry * BUBBLE.puffSize
  const ring: [number, number] = [Math.max(0, rx - r), Math.max(0, ry - r)]   // the puffs' centres lie on this oval
  const core: [number, number] = [Math.max(0, rx - r * BUBBLE.coreInset), Math.max(0, ry - r * BUBBLE.coreInset)]
  const puffs: Puff[] = []
  for (let k = 0; k < BUBBLE.puffs; k++) {
    const angle = (2 * Math.PI * k) / BUBBLE.puffs + seed
    puffs.push([cx + ring[0] * Math.cos(angle), cy + ring[1] * Math.sin(angle),
                r * (1 + BUBBLE.puffVariety * Math.sin(k * 2.3 + seed * 3))])
  }
  return { core, puffs }
}

/** A bubble's seed: from its id, so each cloud is a little different. */
function seedOf(bubble: SpeechBubble): number {
  let h = 0
  for (const c of String(bubble.id)) h = (h * 31 + c.charCodeAt(0)) >>> 0
  return ((h % 1000) / 1000) * ((2 * Math.PI) / BUBBLE.puffs)   // within one puff's spacing
}

let nextId = 1

// ---------------- the bubbles and their utterances ----------------
/** A new bubble (open: its press goes on), on top of the others; drops the oldest if there are too many. */
export function openBubble(bubbles: SpeechBubble[], growFrom: NonNullable<SpeechBubble['growFrom']>): SpeechBubble {
  const bubble: SpeechBubble = {
    id: nextId++, utterances: [], open: true, center: [...growFrom.at], growFrom,
    tailDir: [-growFrom.dir[0], -growFrom.dir[1]], radius: BUBBLE.minRadius, age: 0, playing: false, glow: 0,
  }
  bubbles.push(bubble)
  while (bubbles.length > MAX_BUBBLES) removeBubble(bubbles, bubbles[0])
  return bubble
}

/** An utterance started (or, from an older server, ended without a start) in this bubble. */
export function addUtterance(bubble: SpeechBubble, key: number, seconds: number, speaking = true): Utterance {
  const utterance: Utterance = { key, seconds, since: speaking ? performance.now() : null, recording: null, text: null }
  bubble.utterances.push(utterance)
  return utterance
}

/** The utterance has ended: its final length and audio. */
export function endUtterance(utterance: Utterance, seconds: number, recording: Recording | null): void {
  utterance.seconds = seconds
  utterance.since = null
  utterance.recording = recording
}

/** The bubble and utterance with this key, if there is one. */
export function findUtterance(bubbles: SpeechBubble[], key: number): [SpeechBubble, Utterance] | null {
  for (const bubble of bubbles) {
    const utterance = bubble.utterances.find((u) => u.key === key)
    if (utterance) return [bubble, utterance]
  }
  return null
}

/** How much speech it holds, counting the utterance being spoken up to now. */
export function bubbleSeconds(bubble: SpeechBubble, now = performance.now()): number {
  return bubble.utterances.reduce((sum, u) => sum + u.seconds + (u.since === null ? 0 : (now - u.since) / 1000), 0)
}

/** The size its speech calls for: fast growth at first (square root), full size at BUBBLE.fullSeconds. */
export function targetRadius(bubble: SpeechBubble, now = performance.now()): number {
  const share = Math.min(1, Math.sqrt(bubbleSeconds(bubble, now) / BUBBLE.fullSeconds))
  return BUBBLE.minRadius + (BUBBLE.maxRadius - BUBBLE.minRadius) * share
}

/** Every frame: grow towards the target size, pop, breathe and pulsate (playing); while open, move with the dot
 *  and point the tail at it; keep it away from the dot (while it hasn't been dragged) and on the screen. */
export function advanceBubbles(bubbles: SpeechBubble[], dt: number, now: number, size: Size,
                               dotCenter: [number, number]): void {
  for (const bubble of bubbles) {
    bubble.age += dt
    bubble.radius += (targetRadius(bubble, now) - bubble.radius) * (1 - Math.exp(-6 * dt))
    bubble.glow += ((bubble.playing ? 1 : 0) - bubble.glow) * (1 - Math.exp(-8 * dt))
    const [rx, ry] = shownRadii(bubble, size)
    let x: number, y: number
    if (bubble.growFrom) {        // the edge nearest the dot stays where it is: it grows away from the dot
      const { dir, gap } = bubble.growFrom
      if (bubble.open) {          // its press goes on: it moves with the dot (and stays put once it's over)
        bubble.growFrom.at = [
          dotCenter[0] + (dir[0] * gap * unit(size)) / size.width,
          dotCenter[1] + (dir[1] * gap * unit(size)) / size.height,
        ]
      }
      const { at } = bubble.growFrom
      const reach = ovalReach(dir, rx, ry)
      x = at[0] * size.width + dir[0] * reach
      y = at[1] * size.height + dir[1] * reach
    } else {
      x = bubble.center[0] * size.width
      y = bubble.center[1] * size.height
    }
    const [cx, cy] = clampBubble(x, y, rx, ry, size)
    bubble.center = [cx / size.width, cy / size.height]
    if (bubble.open) {            // the tail points at the dot; once the press is over, it keeps that direction
      const dx = dotCenter[0] * size.width - cx
      const dy = dotCenter[1] * size.height - cy
      const d = Math.hypot(dx, dy)
      if (d > 0) bubble.tailDir = [dx / d, dy / d]
    }
  }
}

// ---------------- geometry (CSS pixels) ----------------
function unit(size: Size): number {
  return Math.min(size.width, size.height)
}

/** Popping up: 0 -> 1 with a small overshoot ("ease out back"). */
function popScale(age: number): number {
  const t = Math.min(1, age / BUBBLE.popSeconds) - 1
  const s = 1.7
  return 1 + t * t * ((s + 1) * t + s)
}

/** Its oval's half width and height as shown now: size, popping up, breathing while open,
 *  pulsating while it plays. */
function shownRadii(bubble: SpeechBubble, size: Size): [rx: number, ry: number] {
  const breathe = bubble.open ? 1 + BUBBLE.breathe * Math.sin(bubble.age * BUBBLE.breatheSpeed) : 1
  const pulse = 1 + BUBBLE.pulse * bubble.glow * Math.sin(bubble.age * BUBBLE.pulseSpeed)
  const ry = bubble.radius * unit(size) * popScale(bubble.age) * breathe * pulse
  return [ry * BUBBLE.aspect, ry]
}

/** How far the oval's edge is from its centre in direction dir (a unit vector). */
function ovalReach([dx, dy]: [number, number], rx: number, ry: number): number {
  return 1 / Math.hypot(dx / rx, dy / ry)
}

/** Keep a centre so that the whole cloud stays on the screen (its bigger puffs reach a little beyond rx, ry). */
function clampBubble(x: number, y: number, rx: number, ry: number, size: Size): [number, number] {
  const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), Math.max(lo, hi))
  const pad = ry * BUBBLE.puffSize * BUBBLE.puffVariety
  return [clamp(x, rx + pad, size.width - rx - pad), clamp(y, ry + pad, size.height - ry - pad)]
}

/** The bubble as the renderers draw it: a cloud, its trail pointing in bubble.tailDir. */
export function bubbleShape(bubble: SpeechBubble, size: Size): BubbleShape {
  const [rx, ry] = shownRadii(bubble, size)
  const cx = bubble.center[0] * size.width
  const cy = bubble.center[1] * size.height
  const [dx, dy] = bubble.tailDir
  const reach = ovalReach([dx, dy], rx, ry)    // the cloud's edge in that direction (about)
  return {
    center: [cx, cy],
    radii: [rx, ry],
    seed: seedOf(bubble),
    trail: BUBBLE.trail.map(({ at, size: r }): Puff => [cx + dx * (reach + at * ry), cy + dy * (reach + at * ry), r * ry]),
  }
}

/** The topmost bubble under the point (CSS pixels), or null. A little easier to hit than it looks. */
export function bubbleAt(bubbles: SpeechBubble[], x: number, y: number, size: Size): SpeechBubble | null {
  const pad = 8
  for (let i = bubbles.length - 1; i >= 0; i--) {  // the last one is drawn on top
    const [rx, ry] = shownRadii(bubbles[i], size)
    const dx = (x - bubbles[i].center[0] * size.width) / (rx + pad)
    const dy = (y - bubbles[i].center[1] * size.height) / (ry + pad)
    if (dx * dx + dy * dy <= 1) return bubbles[i]
  }
  return null
}

/** The bubble was picked up: from now on it stays where it's put, and grows around its centre. */
export function moveBubble(bubble: SpeechBubble, x: number, y: number, size: Size): void {
  bubble.growFrom = null
  const [rx, ry] = shownRadii(bubble, size)
  const [cx, cy] = clampBubble(x, y, rx, ry, size)
  bubble.center = [cx / size.width, cy / size.height]
}

/**
 * Where a new bubble starts, and which way it grows: above the dot if a full-size bubble fits
 * there (a little to the right of straight up, a little to the left, then the upper diagonals);
 * only if all of that is taken (by older bubbles, or the screen's edge), below the dot, the same
 * way mirrored; straight right or left last. If none is free, the side farthest from the other
 * bubbles.
 * keepFree: CSS pixels at the bottom a new bubble shouldn't grow into (the bin's strip; dragging
 * a bubble there is still possible).
 */
export function placeNewBubble(bubbles: SpeechBubble[], dotCenter: [number, number], dotRadius: number,
                               size: Size, keepFree = 0): NonNullable<SpeechBubble['growFrom']> {
  const u = unit(size)
  const maxRy = BUBBLE.maxRadius * u
  const maxRx = maxRy * BUBBLE.aspect
  const dx = dotCenter[0] * size.width
  const dy = dotCenter[1] * size.height
  const gap = dotRadius * u * 1.15 + maxRy * BUBBLE.tail   // clear of the dot's edge, room for the trail
  const tilt = Math.tan(BUBBLE.tilt)   // how far off straight up the first two choices are
  const directions: [number, number][] = [
    [tilt, -1], [-tilt, -1], [1, -1], [-1, -1],   // above
    [tilt, 1], [-tilt, 1], [1, 1], [-1, 1],       // below
    [1, 0], [-1, 0],                              // beside
  ]
  let best: { at: [number, number]; dir: [number, number]; score: number } | null = null
  for (const [ax, ay] of directions) {
    const dir: [number, number] = [ax / Math.hypot(ax, ay), ay / Math.hypot(ax, ay)]
    const at: [number, number] = [dx + dir[0] * gap, dy + dir[1] * gap]
    // Where it would be at full size, and how much of it the screen would cut off (clamping moves it).
    const reach = ovalReach(dir, maxRx, maxRy)
    const fx = at[0] + dir[0] * reach
    const fy = at[1] + dir[1] * reach
    const [kx, ky] = clampBubble(fx, fy, maxRx, maxRy, { width: size.width, height: size.height - keepFree })
    const pushed = Math.hypot(kx - fx, ky - fy)
    // The nearest other bubble, in units of "touching": < 1 means they would overlap.
    const nearest = Math.min(Infinity, ...bubbles.map((b) => {
      const [rx, ry] = shownRadii(b, size)
      return Math.hypot((kx - b.center[0] * size.width) / (rx + maxRx), (ky - b.center[1] * size.height) / (ry + maxRy))
    }))
    const free = nearest >= 1 && pushed < maxRy * 0.5
    const score = (free ? 10 : 0) + Math.min(nearest, 3) - pushed / maxRy
    if (free) return { at: [at[0] / size.width, at[1] / size.height], dir, gap: gap / u }
    if (!best || score > best.score) best = { at, dir, score }
  }
  return { at: [best!.at[0] / size.width, best!.at[1] / size.height], dir: best!.dir, gap: gap / u }
}

/** Take a bubble away for good (dropped on the bin). Its text goes with it: bubbleLabels.ts only
 *  shows labels of bubbles in the list. */
export function removeBubble(bubbles: SpeechBubble[], bubble: SpeechBubble): void {
  const i = bubbles.indexOf(bubble)
  if (i >= 0) bubbles.splice(i, 1)
  if (current?.bubble === bubble) {
    current.source.onended = null
    current.source.stop()
    current = null
  }
}

/** Move a bubble to the end of the list, so it's drawn (and hit-tested) on top. */
export function bringToFront(bubbles: SpeechBubble[], bubble: SpeechBubble): void {
  const i = bubbles.indexOf(bubble)
  if (i >= 0) bubbles.push(...bubbles.splice(i, 1))
}

// ---------------- playback ----------------
const GAP_SECONDS = 0.25   // silence between two utterances of a bubble
let audio: AudioContext | null = null
let current: { source: AudioBufferSourceNode; bubble: SpeechBubble } | null = null

/** Play all of a bubble's utterances, one after the other (stops whatever was playing). Call it
 *  from a tap: browsers only allow starting audio in response to a user action. */
export function playBubble(bubble: SpeechBubble): void {
  const recordings = bubble.utterances.flatMap((u) => (u.recording ? [u.recording] : []))
  if (recordings.length === 0) return   // nothing has ended yet
  audio ??= new AudioContext()
  void audio.resume()
  if (current) {
    current.bubble.playing = false
    current.source.onended = null
    current.source.stop()
  }
  const sampleRate = recordings[0].sampleRate
  const gap = Math.round(GAP_SECONDS * sampleRate)
  const length = recordings.reduce((n, r) => n + r.pcm.length, 0) + gap * (recordings.length - 1)
  const buffer = audio.createBuffer(1, length, sampleRate)  // the browser resamples 16 kHz for the speakers
  const samples = buffer.getChannelData(0)
  let offset = 0
  for (const { pcm } of recordings) {
    for (let i = 0; i < pcm.length; i++) samples[offset + i] = pcm[i] / 32768  // 16-bit -> -1..1
    offset += pcm.length + gap
  }
  const source = audio.createBufferSource()
  source.buffer = buffer
  source.connect(audio.destination)
  source.onended = () => {
    bubble.playing = false
    if (current?.source === source) current = null
  }
  current = { source, bubble }
  bubble.playing = true
  source.start()
}
