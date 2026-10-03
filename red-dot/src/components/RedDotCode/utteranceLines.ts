// The utterance lines: one per finished utterance, each holding that utterance's audio.
// No React and no WebGL here: the component creates and moves lines, the renderer draws them.
//
//   addLine(lines, createLine(recording, placeNewLine(lines, dotCenter, dotRadius, size)))
//   const line = lineAt(lines, x, y, size)    // what's under the pointer (topmost first)
//   playLine(line)                            // play its audio; line.playing is true meanwhile
//   advanceLines(lines, dt)                   // every frame: move the waves

import { LINE } from './looks.ts'
import type { Recording } from './link.ts'

export const MAX_LINES = 24  // the renderer draws at most this many; older lines are dropped

export interface UtteranceLine {
  id: number
  center: [x: number, y: number]  // share of the canvas, like the dot ([0.5, 0.5] = middle, y from the top)
  recording: Recording
  phase: number                   // where the wave is; advanced every frame (starts random, so lines differ)
  playing: boolean
  glow: number                    // 0..1, eased towards 1 while playing (the renderer uses it)
}

/** The canvas size in CSS pixels. */
export interface Size {
  width: number
  height: number
}

let nextId = 1

export function createLine(recording: Recording, center: [number, number]): UtteranceLine {
  return { id: nextId++, center, recording, phase: Math.random() * 2 * Math.PI, playing: false, glow: 0 }
}

/** Add a line, dropping the oldest if there are too many. */
export function addLine(lines: UtteranceLine[], line: UtteranceLine): void {
  lines.push(line)
  while (lines.length > MAX_LINES) lines.shift()
}

/** Every frame: move each wave along (faster while playing) and ease the playing glow. */
export function advanceLines(lines: UtteranceLine[], dt: number): void {
  for (const line of lines) {
    line.glow += ((line.playing ? 1 : 0) - line.glow) * (1 - Math.exp(-8 * dt))
    line.phase += LINE.speed * (1 + line.glow * (LINE.playing.speed - 1)) * dt
  }
}

// ---------------- geometry (CSS pixels) ----------------
function unit(size: Size): number {
  return Math.min(size.width, size.height)
}

/** Half the line's size in CSS pixels: [half length, half height incl. the wave]. */
function halfExtent(size: Size): [number, number] {
  const u = unit(size)
  return [LINE.halfLength * u, (LINE.amplitude * LINE.playing.amplitude + LINE.thickness) * u]
}

/** Keep a centre (CSS pixels) so that the whole line stays on the screen. */
export function clampLine(x: number, y: number, size: Size): [number, number] {
  const [hx, hy] = halfExtent(size)
  const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi)
  return [clamp(x, hx, size.width - hx), clamp(y, hy, size.height - hy)]
}

/** The topmost line under the point (CSS pixels), or null. Lines are a bit easier to hit than they look. */
export function lineAt(lines: UtteranceLine[], x: number, y: number, size: Size): UtteranceLine | null {
  const [hx, hy] = halfExtent(size)
  const pad = 10  // pixels: a thin line needs a generous target, especially for fingers
  for (let i = lines.length - 1; i >= 0; i--) {  // the last one is drawn on top
    const [cx, cy] = lines[i].center
    if (Math.abs(x - cx * size.width) <= hx + pad && Math.abs(y - cy * size.height) <= hy + pad) return lines[i]
  }
  return null
}

/** Move a line to the end of the list, so it's drawn (and hit-tested) on top. */
export function bringToFront(lines: UtteranceLine[], line: UtteranceLine): void {
  const i = lines.indexOf(line)
  if (i >= 0) lines.push(...lines.splice(i, 1))
}

/**
 * Where a new line goes: just below the dot if that's free, else the next free spot around
 * it (below, above, right, left, then the diagonals, then a ring further out).
 */
export function placeNewLine(lines: UtteranceLine[], dotCenter: [number, number], dotRadius: number,
                             size: Size): [number, number] {
  const u = unit(size)
  const [hx, hy] = halfExtent(size)
  const dx = dotCenter[0] * size.width
  const dy = dotCenter[1] * size.height
  const gap = dotRadius * u + hy * 3  // clear of the dot's edge
  const directions = [[0, 1], [0, -1], [1, 0], [-1, 0], [1, 1], [-1, 1], [1, -1], [-1, -1]]
  const candidates: [number, number][] = []
  for (const ring of [1, 2]) {
    for (const [ax, ay] of directions) {
      candidates.push(clampLine(dx + ax * (gap + hx) * ring, dy + ay * gap * ring, size))
    }
  }
  const free = candidates.find(([x, y]) => lines.every(({ center: [cx, cy] }) =>
    Math.abs(x - cx * size.width) > hx * 2 || Math.abs(y - cy * size.height) > hy * 2.5))
  const [x, y] = free ?? candidates[0]
  return [x / size.width, y / size.height]
}

// ---------------- playback ----------------
let audio: AudioContext | null = null
let current: { source: AudioBufferSourceNode; line: UtteranceLine } | null = null

/** Play a line's utterance (stops whatever was playing). Call it from a tap: browsers only
 *  allow starting audio in response to a user action. */
export function playLine(line: UtteranceLine): void {
  audio ??= new AudioContext()
  void audio.resume()
  if (current) {
    current.line.playing = false
    current.source.onended = null
    current.source.stop()
  }
  const { pcm, sampleRate } = line.recording
  const buffer = audio.createBuffer(1, pcm.length, sampleRate)  // the browser resamples 16 kHz for the speakers
  const samples = buffer.getChannelData(0)
  for (let i = 0; i < pcm.length; i++) samples[i] = pcm[i] / 32768  // 16-bit -> -1..1
  const source = audio.createBufferSource()
  source.buffer = buffer
  source.connect(audio.destination)
  source.onended = () => {
    line.playing = false
    if (current?.source === source) current = null
  }
  current = { source, line }
  line.playing = true
  source.start()
}
