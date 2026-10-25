// How the dot looks, and how it glides from one look to the next. No React, no WebGL.
//
//     offline --(connected)--> idle --(pressed)--> pressed --(speech heard)--> speech

// ---------------- the looks: design the dot here ----------------
export type RGB = [r: number, g: number, b: number]  // each 0..1

export interface Look {
  radius: number  // size, as a share of the shorter screen side
  wobble: number  // how far the edge moves in and out (share of the radius; 0 = perfect circle)
  lobes: number   // how many bumps around the edge
  spin: number    // how fast the bumps travel around (radians per second)
  squash: number  // > 0: wider and flatter, < 0: taller and narrower
  glow: number    // halo around the dot (0 = none)
  color: RGB
}

export type LookName = 'offline' | 'idle' | 'pressed' | 'speech'

const BASE_LOOKS: Record<Exclude<LookName, 'speech'>, Look> = {
  offline: { radius: 0.150, wobble: 0.00, lobes: 3, spin: 0.0, squash: 0.00, glow: 0.0, color: [0.45, 0.45, 0.48] },
  idle:    { radius: 0.160, wobble: 0.00, lobes: 3, spin: 0.0, squash: 0.00, glow: 0.3, color: [0.86, 0.13, 0.13] },
  pressed: { radius: 0.176, wobble: 0.03, lobes: 3, spin: 1.5, squash: 0.06, glow: 0.6, color: [0.92, 0.16, 0.16] },
}
export const LOOKS: Record<LookName, Look> = {
  ...BASE_LOOKS,
  // While speech is heard: the same shape as "pressed", but a more intense red, a stronger
  // glow, and moving five times as fast. Derived from "pressed", so it follows any change
  // you make there.
  speech: {
    ...BASE_LOOKS.pressed,
    spin: BASE_LOOKS.pressed.spin * 5,
    glow: BASE_LOOKS.pressed.glow * 1.6,
    color: [1.00, 0.02, 0.02],
  },
}

// The three things the dot reacts to; each is blended in gradually (see `amount`).
type Blend = 'online' | 'pressed' | 'speech'

// ---------------- the speech bubbles: design them here ----------------
// One bubble per press of the dot: it pops up when the first utterance starts and grows with the
// seconds of speech it holds, up to its full size. A cloud (round puffs around an oval) with a
// trail of small puffs that points at the dot while the press goes on, and keeps that direction
// afterwards. It looks like white plastic: white inside, gray towards its edges, a soft sheen.
// Sizes are shares of the shorter screen side, like the dot's radius.
export const BUBBLE = {
  minRadius: 0.04,                    // half its height when it pops up
  maxRadius: 0.15,                    // half its height at full size
  fullSeconds: 20,                    // this much speech makes it full size (it grows fastest at first)
  aspect: 1.35,                       // width / height
  puffs: 8,                           // round puffs around the cloud's edge
  puffSize: 0.42,                     // a puff's radius (share of its half height)...
  puffVariety: 0.12,                  // ...each a little bigger or smaller, by up to this share
  coreInset: 0.6,                     // the filled oval inside: smaller than the cloud by this share of a puff's radius
  // The trail towards the dot: small puffs, each this far beyond the cloud's edge, this big (both
  // shares of its half height). tail: how far the trail reaches, for keeping room next to the dot.
  trail: [{ at: 0.32, size: 0.16 }, { at: 0.7, size: 0.09 }],
  tail: 0.8,
  tilt: 0.45,                         // a new bubble goes above the dot, this far off straight up (radians, ≈ 25°)
  popSeconds: 0.35,                   // popping up: from nothing to its size, overshooting a little
  breathe: 0.035,                     // while its press goes on, its size swings by this share...
  breatheSpeed: 3,                    // ...this fast (radians per second)
  fill: [0.96, 0.96, 0.97] as RGB,    // inside: (almost) white...
  edge: [0.58, 0.59, 0.63] as RGB,    // ...turning gray towards the edges...
  shade: 0.45,                        // ...over this far in from the edge (share of its half height; a trail puff: of its radius)
  sheen: 0.22,                        // a soft highlight towards the upper left, this bright (0: none)
  pulse: 0.07,                        // while its utterances play, it pulsates: its size swings by this share...
  pulseSpeed: 7,                      // ...this fast (radians per second, about once a second)
}

// How quickly the dot glides to a new look (per second; higher = snappier).
export const EASE: Record<Blend, number> = { online: 4, pressed: 12, speech: 10 }
// A "speech" verdict keeps the speech look for this long, so 100 ms verdicts don't flicker.
export const SPEECH_HOLD_MS = 250

// ---------------- the moving parts ----------------
// Everything the animation needs between frames. Plain data, changed in place.
export interface OrbState {
  online: boolean               // connected to the server
  pressed: boolean              // the dot (or R) is held
  lastSpeechAt: number          // when the server last said "speech" (performance.now())
  level: number                 // loudness of the last chunk, 0..1 (not used by LOOKS yet: yours to design)
  amount: Record<Blend, number> // blend amounts, eased towards 0 or 1
  phase: number                 // where the bumps are; advanced by spin, so speed changes never make them jump
  look: Look                    // the blended look of the current frame
  // Where the dot is, as a share of the canvas: [0, 0] = top left, [0.5, 0.5] = centre,
  // [1, 1] = bottom right. Shares rather than pixels, so the dot keeps its place relative
  // to the screen when the window is resized or the phone is rotated.
  center: [x: number, y: number]
}

export function createOrbState(): OrbState {
  return {
    online: false,
    pressed: false,
    lastSpeechAt: -Infinity,
    level: 0,
    amount: { online: 0, pressed: 0, speech: 0 },
    phase: 0,
    look: LOOKS.offline,
    center: [0.5, 0.5],
  }
}

const mix = (a: number, b: number, t: number): number => a + (b - a) * t

function mixLooks(a: Look, b: Look, t: number): Look {
  return {
    radius: mix(a.radius, b.radius, t), wobble: mix(a.wobble, b.wobble, t), lobes: mix(a.lobes, b.lobes, t),
    spin: mix(a.spin, b.spin, t), squash: mix(a.squash, b.squash, t), glow: mix(a.glow, b.glow, t),
    color: [mix(a.color[0], b.color[0], t), mix(a.color[1], b.color[1], t), mix(a.color[2], b.color[2], t)],
  }
}

// Move the animation forward by dt seconds; afterwards state.look and state.phase describe
// the frame to draw.
export function advance(state: OrbState, dt: number, now: number): void {
  const speaking = state.pressed && now - state.lastSpeechAt < SPEECH_HOLD_MS
  const targets: Record<Blend, boolean> = { online: state.online, pressed: state.pressed, speech: speaking }
  for (const key of Object.keys(targets) as Blend[]) {
    const target = targets[key] ? 1 : 0
    state.amount[key] += (target - state.amount[key]) * (1 - Math.exp(-EASE[key] * dt))
  }
  let look = mixLooks(LOOKS.offline, LOOKS.idle, state.amount.online)
  look = mixLooks(look, LOOKS.pressed, state.amount.pressed)
  state.look = mixLooks(look, LOOKS.speech, state.amount.speech)
  state.phase += state.look.spin * dt
}
