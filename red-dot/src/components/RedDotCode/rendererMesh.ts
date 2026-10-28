// The same picture as renderer.ts, drawn the "classic" way: shapes are made of triangles
// (meshes) stored on the GPU, the vertex shader positions them with matrices, and the
// fragment shader only colours them. This is how 3D scenes with many objects (spheres,
// boxes, models) are usually drawn; renderer.ts instead computes every shape per pixel.
//
//   const renderer = createOrbRenderer(canvas)   // same interface as renderer.ts
//   renderer.draw(look, phase, center, bubbles)
//   renderer.dispose()
//
// Two meshes and three small shader programs, drawn in this order (later = on top):
//
//   glow     a ring around the dot; its transparency fades outwards; added onto the background
//   dot      a disc (triangle fan); the vertex shader moves its edge points to make the wobble
//   bubbles  per speech bubble (a cloud): the disc again, many times (instancing), as its oval core,
//            its puffs and its trail's puffs. First all of them in the outline colour, then all
//            again, smaller by the outline's thickness, in the fill colour: what's left of the
//            first is the outline, around the whole cloud and between the puffs' bumps.
//
// Coordinates: everything is placed in device pixels (origin bottom left, like WebGL). The
// projection matrix maps pixels to the GPU's clip space (-1..1); each object's model matrix
// moves and scales its mesh from "mesh units" (1.0 = the screen's shorter side) to pixels.
//
// To add a 3D object, e.g. a sphere: build its mesh once (positions + normals from a grid of
// latitude/longitude points), give it a model matrix (where, how big, how rotated), switch the
// projection to a perspective one, turn on gl.DEPTH_TEST so near triangles hide far ones, and
// light it in the fragment shader from the normals: max(dot(normal, toLight), 0.0).

import { BUBBLE } from './looks.ts'
import type { Look, RGB } from './looks.ts'
import type { OrbRenderer } from './renderer.ts'
import { MAX_BUBBLES, cloudPuffs } from './speechBubbles.ts'
import type { BubbleShape, Puff } from './speechBubbles.ts'

const DOT_SEGMENTS = 128   // edge points of the disc: enough for a smooth, wobbling outline
const GLOW_REACH = 0.4     // how far the glow reaches beyond the edge (mesh units); exp(-18 * 0.4) ≈ 0.001
const BACKGROUND = [0.035, 0.035, 0.045] as const

// ---------------- shaders ----------------
// Shared by the glow and the dot: where the wobbling edge is, for a given angle.
const EDGE = /* glsl */ `
uniform float u_radius, u_wobble, u_lobes, u_phase;
float edgeRadius(float angle) {
  return u_radius * (1.0 + u_wobble * sin(u_lobes * angle + u_phase));
}`

// The dot: a fan of triangles around the centre. Each vertex knows its angle and whether it's
// the centre (a_edge = 0) or on the rim (a_edge = 1); the vertex shader puts it in place.
const DOT_VERTEX = /* glsl */ `#version 300 es
layout(location = 0) in float a_angle;
layout(location = 1) in float a_edge;
uniform mat4 u_projection;   // pixels -> clip space
uniform mat4 u_model;        // mesh units -> pixels: the dot's position, size, squash
${EDGE}
void main() {
  vec2 pos = a_edge * edgeRadius(a_angle) * vec2(cos(a_angle), sin(a_angle));
  gl_Position = u_projection * u_model * vec4(pos, 0.0, 1.0);
}`

const DOT_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
uniform vec3 u_color;
out vec4 outColor;
void main() {
  outColor = vec4(u_color, 1.0);   // flat colour; a 3D object would compute lighting here
}`

// The glow: a ring from the dot's edge (a_out = 0) outwards (a_out = 1). The fragment shader
// gets the distance from the edge, interpolated across each triangle, and fades with it.
const GLOW_VERTEX = /* glsl */ `#version 300 es
layout(location = 0) in float a_angle;
layout(location = 1) in float a_out;
uniform mat4 u_projection;
uniform mat4 u_model;
uniform float u_reach;
${EDGE}
out float v_distance;   // distance from the dot's edge, in mesh units
void main() {
  v_distance = a_out * u_reach;
  vec2 pos = (edgeRadius(a_angle) + v_distance) * vec2(cos(a_angle), sin(a_angle));
  gl_Position = u_projection * u_model * vec4(pos, 0.0, 1.0);
}`

const GLOW_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
uniform vec3 u_color;
uniform float u_glow;
in float v_distance;
out vec4 outColor;
void main() {
  float strength = u_glow * 0.35 * exp(-v_distance * 18.0);  // the same fall-off as renderer.ts
  outColor = vec4(u_color, strength);                         // blended additively onto the background
}`

// A bubble's ovals (core, puffs, trail): the dot's disc mesh, drawn once per oval (instancing),
// each put in place and stretched by its own a_oval (no wobble).
const OVALS_VERTEX = /* glsl */ `#version 300 es
layout(location = 0) in float a_angle;
layout(location = 1) in float a_edge;
layout(location = 2) in vec4 a_oval;   // per instance: centre, half width, half height (pixels)
uniform mat4 u_projection;
void main() {
  vec2 pos = a_oval.xy + a_edge * a_oval.zw * vec2(cos(a_angle), sin(a_angle));
  gl_Position = u_projection * vec4(pos, 0.0, 1.0);
}`

// ---------------- matrices (column-major, as WebGL expects) ----------------
/** Orthographic projection: pixels (0..width, 0..height) -> clip space (-1..1). */
function ortho(width: number, height: number): Float32Array {
  // prettier-ignore
  return new Float32Array([
    2 / width, 0,          0, 0,
    0,         2 / height, 0, 0,
    0,         0,          1, 0,
    -1,        -1,         0, 1,
  ])
}

/** Model matrix: scale by (sx, sy), then move to (tx, ty). */
function translateScale(tx: number, ty: number, sx: number, sy: number): Float32Array {
  // prettier-ignore
  return new Float32Array([
    sx, 0,  0, 0,
    0,  sy, 0, 0,
    0,  0,  1, 0,
    tx, ty, 0, 1,
  ])
}

// ---------------- meshes (built once) ----------------
function dotMesh(): Float32Array {  // triangle fan: centre, then the rim, closed
  const v = [0, 0]  // per vertex: angle, edge
  for (let i = 0; i <= DOT_SEGMENTS; i++) v.push((i / DOT_SEGMENTS) * 2 * Math.PI, 1)
  return new Float32Array(v)
}

function glowMesh(): Float32Array {  // triangle strip: inner and outer point at each angle
  const v: number[] = []  // per vertex: angle, out
  for (let i = 0; i <= DOT_SEGMENTS; i++) {
    const angle = (i / DOT_SEGMENTS) * 2 * Math.PI
    v.push(angle, 0, angle, 1)
  }
  return new Float32Array(v)
}

// ---------------- the renderer ----------------
export function createOrbRenderer(canvas: HTMLCanvasElement): OrbRenderer {
  const context = canvas.getContext('webgl2', { antialias: true })  // antialias: the GPU smooths triangle edges (MSAA)
  if (!context) throw new Error('WebGL2 is not available in this browser')
  const gl: WebGL2RenderingContext = context  // non-null name, reachable from the hoisted functions below

  const dot = makeProgram(gl, DOT_VERTEX, DOT_FRAGMENT)
  const glow = makeProgram(gl, GLOW_VERTEX, GLOW_FRAGMENT)
  const ovals = makeProgram(gl, OVALS_VERTEX, DOT_FRAGMENT)

  // A VAO (vertex array object) remembers which buffers feed which shader inputs, so drawing
  // an object later only needs bindVertexArray + draw.
  const dotData = dotMesh()
  const dotVao = makeVao(gl, dotData)
  const glowData = glowMesh()
  const glowVao = makeVao(gl, glowData)
  // The bubbles' ovals: the disc mesh again, in its own VAO, plus one oval per instance
  // (vertexAttribDivisor = 1: read once per oval instead of once per vertex).
  const ovalsVao = makeVao(gl, dotData)
  const OVALS_PER_BUBBLE = 1 + BUBBLE.puffs + BUBBLE.trail.length
  const ovalData = new Float32Array(OVALS_PER_BUBBLE * 4)
  const ovalBuffer = gl.createBuffer()
  gl.bindVertexArray(ovalsVao.vao)
  gl.bindBuffer(gl.ARRAY_BUFFER, ovalBuffer)
  gl.bufferData(gl.ARRAY_BUFFER, ovalData.byteLength, gl.DYNAMIC_DRAW)
  gl.enableVertexAttribArray(2)
  gl.vertexAttribPointer(2, 4, gl.FLOAT, false, 0, 0)
  gl.vertexAttribDivisor(2, 1)
  gl.bindVertexArray(null)

  function resize(): void {
    const dpr = window.devicePixelRatio || 1
    const w = Math.round(canvas.clientWidth * dpr)
    const h = Math.round(canvas.clientHeight * dpr)
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w
      canvas.height = h
    }
    gl.viewport(0, 0, w, h)
  }

  function draw(look: Look, phase: number, center: [x: number, y: number], bubbles: readonly BubbleShape[]): void {
    resize()
    const { width, height } = canvas
    const unit = Math.min(width, height)
    const projection = ortho(width, height)

    gl.clearColor(BACKGROUND[0], BACKGROUND[1], BACKGROUND[2], 1)
    gl.clear(gl.COLOR_BUFFER_BIT)
    // 2D picture in one plane: no depth test, later draws simply cover earlier ones.
    // (A 3D scene would clear gl.DEPTH_BUFFER_BIT too and enable gl.DEPTH_TEST.)

    // The dot's model matrix: to its centre (y flipped: the page counts from the top), scaled
    // from mesh units to pixels, and squashed (the inverse of renderer.ts's p *= ... squash).
    const model = translateScale(
      center[0] * width, (1 - center[1]) * height,
      unit / (1 - look.squash), unit / (1 + look.squash),
    )

    // 1. the glow, added onto the background: colour * alpha + what's already there
    if (look.glow > 0) {
      gl.enable(gl.BLEND)
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE)
      useShape(glow, projection, model, look, phase)
      gl.uniform1f(glow.u('u_reach'), GLOW_REACH)
      gl.uniform1f(glow.u('u_glow'), look.glow)
      gl.bindVertexArray(glowVao.vao)
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, glowData.length / 2)
      gl.disable(gl.BLEND)
    }

    // 2. the dot, opaque, over the glow's inner part
    useShape(dot, projection, model, look, phase)
    gl.bindVertexArray(dotVao.vao)
    gl.drawArrays(gl.TRIANGLE_FAN, 0, dotData.length / 2)

    // 3. the bubbles, in order (the last on top): outline shape, then the fill shape over it.
    // The shapes are in CSS pixels (y from the top); drawOvals turns them into device pixels (y from the bottom).
    const scale = width / Math.max(1, canvas.clientWidth)
    for (const bubble of bubbles.slice(-MAX_BUBBLES)) {
      const { core, puffs } = cloudPuffs(bubble.center, bubble.radii, bubble.seed)
      const circles: Puff[] = [...puffs, ...bubble.trail]
      const t = bubble.outline
      const mix = (from: RGB, to: RGB): RGB => [0, 1, 2].map((i) => from[i] + (to[i] - from[i]) * bubble.glow) as RGB
      // Outline colour (white while playing), then the same shapes smaller by t in the fill colour.
      drawOvals(projection, scale, bubble.center, core, circles, 0, mix(BUBBLE.color, [1, 1, 1]))
      drawOvals(projection, scale, bubble.center, core, circles, t, mix(BUBBLE.fill, BUBBLE.playingFill))
    }
    gl.bindVertexArray(null)
  }

  // One bubble's core and circles (CSS pixels), each smaller by `shrink`, in one colour: one instanced draw.
  function drawOvals(projection: Float32Array, scale: number, center: [number, number], core: [number, number],
                     circles: Puff[], shrink: number, color: RGB): void {
    const { height } = canvas
    const put = (i: number, x: number, y: number, rx: number, ry: number) =>
      ovalData.set([x * scale, height - y * scale, Math.max(0, rx - shrink) * scale, Math.max(0, ry - shrink) * scale], i * 4)
    put(0, center[0], center[1], core[0], core[1])
    circles.forEach(([x, y, r], i) => put(i + 1, x, y, r, r))
    gl.useProgram(ovals.program)
    gl.uniformMatrix4fv(ovals.u('u_projection'), false, projection)
    gl.uniform3fv(ovals.u('u_color'), color)
    gl.bindVertexArray(ovalsVao.vao)
    gl.bindBuffer(gl.ARRAY_BUFFER, ovalBuffer)
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, ovalData, 0, (circles.length + 1) * 4)
    gl.drawArraysInstanced(gl.TRIANGLE_FAN, 0, dotData.length / 2, circles.length + 1)
  }

  // The uniforms the glow and the dot share: matrices, the wobbling edge, the colour.
  function useShape(p: Program, projection: Float32Array, model: Float32Array, look: Look, phase: number): void {
    gl.useProgram(p.program)
    gl.uniformMatrix4fv(p.u('u_projection'), false, projection)
    gl.uniformMatrix4fv(p.u('u_model'), false, model)
    gl.uniform1f(p.u('u_radius'), look.radius)
    gl.uniform1f(p.u('u_wobble'), look.wobble)
    gl.uniform1f(p.u('u_lobes'), Math.round(look.lobes))  // whole numbers, or the edge would have a seam
    gl.uniform1f(p.u('u_phase'), phase)
    gl.uniform3fv(p.u('u_color'), look.color)
  }

  function dispose(): void {
    for (const p of [dot, glow, ovals]) p.dispose()
    for (const v of [dotVao, glowVao, ovalsVao]) v.dispose()
    gl.deleteBuffer(ovalBuffer)
  }

  return { draw, dispose }
}

// ---------------- WebGL helpers ----------------
interface Program {
  program: WebGLProgram
  u(name: string): WebGLUniformLocation | null  // uniform location, looked up once and cached
  dispose(): void
}

function makeProgram(gl: WebGL2RenderingContext, vertexSource: string, fragmentSource: string): Program {
  const shaders = [compile(gl, gl.VERTEX_SHADER, vertexSource), compile(gl, gl.FRAGMENT_SHADER, fragmentSource)]
  const program = gl.createProgram()
  shaders.forEach((s) => gl.attachShader(program, s))
  gl.linkProgram(program)
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) ?? 'link failed')
  const cache = new Map<string, WebGLUniformLocation | null>()
  return {
    program,
    u(name) {
      if (!cache.has(name)) cache.set(name, gl.getUniformLocation(program, name))
      return cache.get(name) ?? null
    },
    dispose() {
      shaders.forEach((s) => gl.deleteShader(s))
      gl.deleteProgram(program)
    },
  }
}

/** A VAO for a mesh with two floats per vertex, fed to the shader inputs at locations 0 and 1. */
function makeVao(gl: WebGL2RenderingContext, data: Float32Array): { vao: WebGLVertexArrayObject; dispose(): void } {
  const vao = gl.createVertexArray()
  const buffer = gl.createBuffer()
  gl.bindVertexArray(vao)
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
  gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW)   // uploaded once; the GPU keeps it
  gl.enableVertexAttribArray(0)
  gl.vertexAttribPointer(0, 1, gl.FLOAT, false, 8, 0)    // first float of each vertex
  gl.enableVertexAttribArray(1)
  gl.vertexAttribPointer(1, 1, gl.FLOAT, false, 8, 4)    // second float
  gl.bindVertexArray(null)
  return {
    vao,
    dispose() {
      gl.deleteVertexArray(vao)
      gl.deleteBuffer(buffer)
    },
  }
}

function compile(gl: WebGL2RenderingContext, type: GLenum, source: string): WebGLShader {
  const shader = gl.createShader(type)
  if (!shader) throw new Error('could not create a shader')
  gl.shaderSource(shader, source)
  gl.compileShader(shader)
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) ?? 'compile failed')
  return shader
}
