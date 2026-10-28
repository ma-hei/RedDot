// Draws the dot with WebGL2. No React: give it a canvas, call draw() every frame.
//
//   const renderer = createOrbRenderer(canvas)
//   renderer.draw(look, phase, center, bubbles)  // the dot from looks.ts, the bubbles' shapes from speechBubbles.ts
//   renderer.dispose()           // when the canvas goes away

import { BUBBLE } from './looks.ts'
import type { Look } from './looks.ts'
import { MAX_BUBBLES } from './speechBubbles.ts'
import type { BubbleShape } from './speechBubbles.ts'

export interface OrbRenderer {
  /** center: where the dot is, as a share of the canvas ([0.5, 0.5] = middle, y from the top);
   *  bubbles: in CSS pixels (bubbleShape), drawn in this order (the last on top) */
  draw(look: Look, phase: number, center: [x: number, y: number], bubbles: readonly BubbleShape[]): void
  dispose(): void
}

const VERTEX = `#version 300 es
// One triangle that covers the whole screen; no vertex buffer needed.
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`

// The dot and the speech bubbles, computed for every pixel: d < 0 is inside a shape.
const FRAGMENT = `#version 300 es
precision highp float;
#define MAX_BUBBLES ${MAX_BUBBLES}
uniform vec2 u_res;       // canvas size in pixels
uniform vec2 u_center;    // where the dot is, in pixels (WebGL counts y from the bottom)
uniform float u_radius, u_wobble, u_lobes, u_phase, u_squash, u_glow;
uniform vec3 u_color;
// The speech bubbles (see BUBBLE in looks.ts), in pixels with y from the bottom; three per bubble:
// (centre, how far the cloud reaches across and up), (trail puff 1's centre, trail puff 2's centre),
// (trail puff 1's radius, trail puff 2's radius, glow 0..1, seed)
#define PUFFS ${BUBBLE.puffs}
#define PUFF_SIZE ${BUBBLE.puffSize.toFixed(4)}
#define PUFF_VARIETY ${BUBBLE.puffVariety.toFixed(4)}
uniform int u_bubbleCount;
uniform vec4 u_bubbles[MAX_BUBBLES * 3];
uniform float u_bubbleOutline;   // in pixels
uniform vec3 u_bubbleColor, u_bubbleFill, u_bubblePlayingFill;
out vec4 outColor;

// Distance to an oval (an approximation, good for ovals that are only a little wider than tall).
float ovalDistance(vec2 p, vec2 r) {
  float k0 = length(p / r);
  float k1 = length(p / (r * r));
  return k1 > 0.0 ? k0 * (k0 - 1.0) / k1 : -min(r.x, r.y);
}

// Distance to a cloud: its oval core and the round puffs around it (cloudPuffs in speechBubbles.ts
// computes the same puffs; y is flipped here, hence -sin). grow: make it bigger (< 0: smaller).
float cloudDistance(vec2 p, vec2 c, vec2 r, float seed, float grow) {
  float rp = r.y * PUFF_SIZE;
  vec2 core = max(r - rp, vec2(0.5));
  float d = ovalDistance(p - c, core) - grow;
  for (int k = 0; k < PUFFS; k++) {
    float angle = 6.2831853 * float(k) / float(PUFFS) + seed;
    vec2 at = c + core * vec2(cos(angle), -sin(angle));
    float rk = rp * (1.0 + PUFF_VARIETY * sin(float(k) * 2.3 + seed * 3.0));
    d = min(d, length(p - at) - rk - grow);
  }
  return d;
}

// Draw every bubble over col: the cloud and its trail in the outline colour, and the same shapes,
// smaller by the outline's thickness, in the fill colour on top.
vec3 drawBubbles(vec3 col) {
  vec2 p = gl_FragCoord.xy;
  float t = u_bubbleOutline;
  for (int i = 0; i < MAX_BUBBLES; i++) {
    if (i >= u_bubbleCount) break;
    vec4 cloud = u_bubbles[i * 3], trail = u_bubbles[i * 3 + 1], more = u_bubbles[i * 3 + 2];
    vec2 c = cloud.xy, r = max(cloud.zw, vec2(0.5));   // (popping up, it starts at 0)
    // Far from this bubble and its trail: nothing to draw here.
    float reach = max(max(r.x, r.y) * (1.0 + PUFF_VARIETY), max(length(trail.xy - c) + more.x, length(trail.zw - c) + more.y));
    if (length(p - c) > reach + 2.0) continue;
    float trailD = min(length(p - trail.xy) - more.x, length(p - trail.zw) - more.y);
    float outer = min(cloudDistance(p, c, r, more.w, 0.0), trailD);
    float inner = min(cloudDistance(p, c, r, more.w, -t), trailD + t);
    col = mix(col, mix(u_bubbleColor, vec3(1.0), more.z), 1.0 - smoothstep(-1.0, 1.0, outer));  // white while playing
    col = mix(col, mix(u_bubbleFill, u_bubblePlayingFill, more.z), 1.0 - smoothstep(-1.0, 1.0, inner));
  }
  return col;
}

void main() {
  float unit = min(u_res.x, u_res.y);
  vec2 p = (gl_FragCoord.xy - u_center) / unit;          // (0,0) = the dot's centre, 1.0 = shorter side
  p *= vec2(1.0 - u_squash, 1.0 + u_squash);              // squash / stretch
  float angle = atan(p.y, p.x);
  float edge = u_radius * (1.0 + u_wobble * sin(u_lobes * angle + u_phase));
  float d = length(p) - edge;                             // < 0 inside the dot
  float fill = 1.0 - smoothstep(-1.0 / unit, 1.0 / unit, d);  // soft 2-pixel edge
  float halo = u_glow * 0.35 * exp(-max(d, 0.0) * 18.0);
  vec3 background = vec3(0.035, 0.035, 0.045);
  vec3 col = mix(background + u_color * halo, u_color, fill);
  outColor = vec4(drawBubbles(col), 1.0);               // bubbles on top, so a dragged bubble stays visible
}`

const UNIFORMS = ['u_res', 'u_center', 'u_radius', 'u_wobble', 'u_lobes', 'u_phase', 'u_squash', 'u_glow', 'u_color',
  'u_bubbleCount', 'u_bubbles', 'u_bubbleOutline', 'u_bubbleColor', 'u_bubbleFill', 'u_bubblePlayingFill'] as const
type Uniform = (typeof UNIFORMS)[number]

export function createOrbRenderer(canvas: HTMLCanvasElement): OrbRenderer {
  const context = canvas.getContext('webgl2', { antialias: true })
  if (!context) throw new Error('WebGL2 is not available in this browser')
  // A new name with a non-null type: the narrowing above wouldn't reach into the function
  // declarations below (draw, dispose), because those are hoisted.
  const gl: WebGL2RenderingContext = context

  const shaders = [compile(gl, gl.VERTEX_SHADER, VERTEX), compile(gl, gl.FRAGMENT_SHADER, FRAGMENT)]
  const program = gl.createProgram()
  shaders.forEach((s) => gl.attachShader(program, s))
  gl.linkProgram(program)
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) ?? 'link failed')
  const u = Object.fromEntries(UNIFORMS.map((name) => [name, gl.getUniformLocation(program, name)])) as Record<
    Uniform,
    WebGLUniformLocation | null
  >

  function resize() {
    const dpr = window.devicePixelRatio || 1
    const w = Math.round(canvas.clientWidth * dpr)
    const h = Math.round(canvas.clientHeight * dpr)
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w
      canvas.height = h
    }
    gl.viewport(0, 0, w, h)
  }

  const bubbleData = new Float32Array(MAX_BUBBLES * 12)  // reused every frame

  function draw(look: Look, phase: number, center: [x: number, y: number], bubbles: readonly BubbleShape[]): void {
    resize()
    gl.useProgram(program)
    gl.uniform2f(u.u_res, canvas.width, canvas.height)
    // Shares of the canvas -> pixels; flip y, because the page counts from the top and WebGL from the bottom.
    gl.uniform2f(u.u_center, center[0] * canvas.width, (1 - center[1]) * canvas.height)
    gl.uniform1f(u.u_radius, look.radius)
    gl.uniform1f(u.u_wobble, look.wobble)
    gl.uniform1f(u.u_lobes, Math.round(look.lobes))  // whole numbers, or the edge would have a seam
    gl.uniform1f(u.u_phase, phase)
    gl.uniform1f(u.u_squash, look.squash)
    gl.uniform1f(u.u_glow, look.glow)
    gl.uniform3fv(u.u_color, look.color)

    // CSS pixels (y from the top) -> device pixels (y from the bottom)
    const scale = canvas.width / Math.max(1, canvas.clientWidth)
    const px = ([x, y]: [number, number]): [number, number] => [x * scale, canvas.height - y * scale]
    const count = Math.min(bubbles.length, MAX_BUBBLES)
    for (let i = 0; i < count; i++) {
      const { center: c, radii: [rx, ry], seed, trail: [t1, t2], glow } = bubbles[i]
      bubbleData.set([...px(c), rx * scale, ry * scale, ...px([t1[0], t1[1]]), ...px([t2[0], t2[1]]),
                      t1[2] * scale, t2[2] * scale, glow, seed], i * 12)
    }
    gl.uniform1i(u.u_bubbleCount, count)
    gl.uniform4fv(u.u_bubbles, bubbleData)
    gl.uniform1f(u.u_bubbleOutline, (bubbles[0]?.outline ?? 1) * scale)   // the same for every bubble
    gl.uniform3fv(u.u_bubbleColor, BUBBLE.color)
    gl.uniform3fv(u.u_bubbleFill, BUBBLE.fill)
    gl.uniform3fv(u.u_bubblePlayingFill, BUBBLE.playingFill)

    gl.drawArrays(gl.TRIANGLES, 0, 3)
  }

  function dispose() {
    shaders.forEach((s) => gl.deleteShader(s))
    gl.deleteProgram(program)
  }

  return { draw, dispose }
}

function compile(gl: WebGL2RenderingContext, type: GLenum, source: string): WebGLShader {
  const shader = gl.createShader(type)
  if (!shader) throw new Error('could not create a shader')
  gl.shaderSource(shader, source)
  gl.compileShader(shader)
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) ?? 'compile failed')
  return shader
}
