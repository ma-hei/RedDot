// Draws the dot with WebGL2. No React: give it a canvas, call draw() every frame.
//
//   const renderer = createOrbRenderer(canvas)
//   renderer.draw(look, phase, center, lines)   // the dot from looks.ts, the lines from utteranceLines.ts
//   renderer.dispose()           // when the canvas goes away

import { LINE } from './looks.ts'
import type { Look } from './looks.ts'
import { MAX_LINES } from './utteranceLines.ts'
import type { UtteranceLine } from './utteranceLines.ts'

export interface OrbRenderer {
  /** center: where the dot is, as a share of the canvas ([0.5, 0.5] = middle, y from the top) */
  draw(look: Look, phase: number, center: [x: number, y: number], lines: readonly UtteranceLine[]): void
  dispose(): void
}

const VERTEX = `#version 300 es
// One triangle that covers the whole screen; no vertex buffer needed.
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`

// The dot and the utterance lines, computed for every pixel: d < 0 is inside a shape.
const FRAGMENT = `#version 300 es
precision highp float;
#define MAX_LINES ${MAX_LINES}
uniform vec2 u_res;       // canvas size in pixels
uniform vec2 u_center;    // where the dot is, in pixels (WebGL counts y from the bottom)
uniform float u_radius, u_wobble, u_lobes, u_phase, u_squash, u_glow;
uniform vec3 u_color;
// The utterance lines (see LINE in looks.ts)
uniform int u_lineCount;
uniform vec4 u_lines[MAX_LINES];  // per line: xy = centre in pixels (y from the bottom), z = wave phase, w = glow 0..1
uniform vec4 u_lineShape;         // half length, wave height, half thickness, waves (lengths: shares of the shorter side)
uniform float u_linePlayAmp;      // wave height factor while playing
uniform vec3 u_lineColor;
out vec4 outColor;

// Draw every line over col: a stroke along y = height * taper * sin(...), tapered to 0 at
// both ends like a vibrating string. "hl" because "half" is a reserved word in GLSL.
vec3 drawLines(vec3 col, float unit) {
  for (int i = 0; i < MAX_LINES; i++) {
    if (i >= u_lineCount) break;
    vec4 L = u_lines[i];
    vec2 q = (gl_FragCoord.xy - L.xy) / unit;           // this pixel, relative to the line's centre
    float hl = u_lineShape.x;
    float x = clamp(q.x, -hl, hl);                       // the nearest point along the line
    float t = x / hl;                                    // -1 .. 1 from end to end
    float height = u_lineShape.y * mix(1.0, u_linePlayAmp, L.w) * (1.0 - t * t);
    float y = height * sin(3.14159265 * u_lineShape.w * t + L.z);
    float d = length(vec2(q.x - x, q.y - y)) - u_lineShape.z;
    float a = 1.0 - smoothstep(-1.0 / unit, 1.0 / unit, d);
    col = mix(col, mix(u_lineColor, vec3(1.0), L.w), a);  // white while playing
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
  outColor = vec4(drawLines(col, unit), 1.0);           // lines on top, so a dragged line stays visible
}`

const UNIFORMS = ['u_res', 'u_center', 'u_radius', 'u_wobble', 'u_lobes', 'u_phase', 'u_squash', 'u_glow', 'u_color',
  'u_lineCount', 'u_lines', 'u_lineShape', 'u_linePlayAmp', 'u_lineColor'] as const
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

  const lineData = new Float32Array(MAX_LINES * 4)  // reused every frame

  function draw(look: Look, phase: number, center: [x: number, y: number], lines: readonly UtteranceLine[]): void {
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

    const count = Math.min(lines.length, MAX_LINES)
    for (let i = 0; i < count; i++) {
      const { center: [x, y], phase: wave, glow } = lines[i]
      lineData.set([x * canvas.width, (1 - y) * canvas.height, wave, glow], i * 4)
    }
    gl.uniform1i(u.u_lineCount, count)
    gl.uniform4fv(u.u_lines, lineData)
    gl.uniform4f(u.u_lineShape, LINE.halfLength, LINE.amplitude, LINE.thickness, LINE.waves)
    gl.uniform1f(u.u_linePlayAmp, LINE.playing.amplitude)
    gl.uniform3fv(u.u_lineColor, LINE.color)

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
