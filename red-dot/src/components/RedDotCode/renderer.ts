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

// The clouds' shape and their plastic look, in GLSL, in pixels with y from the bottom. Shared with
// rendererMesh.ts, so both renderers draw the same clouds.
export const CLOUD_GLSL = /* glsl */ `
#define PUFFS ${BUBBLE.puffs}
#define PUFF_SIZE ${BUBBLE.puffSize.toFixed(4)}
#define PUFF_VARIETY ${BUBBLE.puffVariety.toFixed(4)}
#define SHADE ${BUBBLE.shade.toFixed(4)}
#define SHEEN ${BUBBLE.sheen.toFixed(4)}
#define CORE_INSET ${BUBBLE.coreInset.toFixed(4)}
uniform vec3 u_cloudFill, u_cloudEdge;

// Distance to an oval (an approximation, good for ovals that are only a little wider than tall).
float ovalDistance(vec2 p, vec2 r) {
  float k0 = length(p / r);
  float k1 = length(p / (r * r));
  return k1 > 0.0 ? k0 * (k0 - 1.0) / k1 : -min(r.x, r.y);
}

// A smooth minimum: like min(a, b), but blending where a and b are within k of each other.
float smoothMin(float a, float b, float k) {
  float h = max(k - abs(a - b), 0.0) / k;
  return min(a, b) - h * h * k * 0.25;
}

// Distance to a cloud: its oval core and the round puffs around it (cloudPuffs in speechBubbles.ts
// computes the same core and puffs; y is flipped here, hence -sin). < 0: inside.
//   x: the exact outline (for drawing its edge)
//   y: the same, with the parts blended where they meet: for the shading, so the hidden edges
//      where puffs and core overlap inside the cloud don't show as gray creases
vec2 cloudDistance(vec2 p, vec2 c, vec2 r, float seed) {
  float rp = r.y * PUFF_SIZE;
  vec2 ring = max(r - rp, vec2(0.5));                 // the puffs' centres lie on this oval
  float hard = ovalDistance(p - c, max(r - rp * CORE_INSET, vec2(0.5)));
  float soft = hard;
  for (int k = 0; k < PUFFS; k++) {
    float angle = 6.2831853 * float(k) / float(PUFFS) + seed;
    vec2 at = c + ring * vec2(cos(angle), -sin(angle));
    float rk = rp * (1.0 + PUFF_VARIETY * sin(float(k) * 2.3 + seed * 3.0));
    float d = length(p - at) - rk;
    hard = min(hard, d);
    soft = smoothMin(soft, d, rp * 0.6);
  }
  return vec2(hard, soft);
}

// White plastic at p, which is d from the shape's edge (d < 0: inside): gray at the edge, white
// from width inside, and a soft sheen towards the upper left of the shape (centre c, half size r).
vec3 plastic(vec2 p, float d, float width, vec2 c, vec2 r) {
  float depth = clamp(-d / width, 0.0, 1.0);
  vec3 col = mix(u_cloudEdge, u_cloudFill, sqrt(depth));
  vec2 q = (p - c - vec2(-0.35 * r.x, 0.4 * r.y)) / (0.5 * r.y);
  return min(col + SHEEN * exp(-dot(q, q)) * depth, vec3(1.0));
}
`

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
// (trail puff 1's radius, trail puff 2's radius, unused, seed)
uniform int u_bubbleCount;
uniform vec4 u_bubbles[MAX_BUBBLES * 3];
out vec4 outColor;
${CLOUD_GLSL}
// Draw every bubble over col: the cloud, then its trail's puffs, each shaded like white plastic.
vec3 drawBubbles(vec3 col) {
  vec2 p = gl_FragCoord.xy;
  for (int i = 0; i < MAX_BUBBLES; i++) {
    if (i >= u_bubbleCount) break;
    vec4 cloud = u_bubbles[i * 3], trail = u_bubbles[i * 3 + 1], more = u_bubbles[i * 3 + 2];
    vec2 c = cloud.xy, r = max(cloud.zw, vec2(0.5));   // (popping up, it starts at 0)
    // Far from this bubble and its trail: nothing to draw here.
    float reach = max(max(r.x, r.y) * (1.0 + PUFF_VARIETY), max(length(trail.xy - c) + more.x, length(trail.zw - c) + more.y));
    if (length(p - c) > reach + 2.0) continue;
    vec2 d = cloudDistance(p, c, r, more.w);
    col = mix(col, plastic(p, d.y, SHADE * r.y, c, r), 1.0 - smoothstep(-1.0, 1.0, d.x));
    for (int j = 0; j < 2; j++) {
      vec2 t = j == 0 ? trail.xy : trail.zw;
      float tr = max(j == 0 ? more.x : more.y, 0.5);
      float dt = length(p - t) - tr;
      col = mix(col, plastic(p, dt, SHADE * tr, t, vec2(tr)), 1.0 - smoothstep(-1.0, 1.0, dt));
    }
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
  'u_bubbleCount', 'u_bubbles', 'u_cloudFill', 'u_cloudEdge'] as const
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
      const { center: c, radii: [rx, ry], seed, trail: [t1, t2] } = bubbles[i]
      bubbleData.set([...px(c), rx * scale, ry * scale, ...px([t1[0], t1[1]]), ...px([t2[0], t2[1]]),
                      t1[2] * scale, t2[2] * scale, 0, seed], i * 12)
    }
    gl.uniform1i(u.u_bubbleCount, count)
    gl.uniform4fv(u.u_bubbles, bubbleData)
    gl.uniform3fv(u.u_cloudFill, BUBBLE.fill)
    gl.uniform3fv(u.u_cloudEdge, BUBBLE.edge)

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
