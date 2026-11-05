// ============================================================================
// render.js — turns the solver state into pictures: derived-field pass,
// colour maps, mirrored display with zoom/pan, sonic line / Mach contours,
// and GPU flow-tracer particles.
// ============================================================================
'use strict';

const FIELDS = [
  { id: 'temp',   label: 'Temperature',      unit: 'K' },
  { id: 'mach',   label: 'Mach number',      unit: '' },
  { id: 'schl',   label: 'Schlieren',        unit: '' },
  { id: 'pres',   label: 'Pressure (log)',   unit: 'Pa' },
  { id: 'dens',   label: 'Density (log)',    unit: 'kg/m³' },
  { id: 'vel',    label: 'Velocity',         unit: 'm/s' },
  { id: 'vort',   label: 'Vorticity',        unit: '1/s' },
  { id: 'exh',    label: 'Exhaust fraction', unit: '' },
  { id: 'flame',  label: 'Flame (visual)',   unit: '' },
  { id: 'turb',   label: 'Eddy viscosity',   unit: '' },
  { id: 'burn',   label: 'Afterburn',        unit: '' },
];

const COLORMAPS = {
  plasma:  { name: 'Workbench blue', stops: [[0, '#040820'], [0.16, '#081a5c'], [0.36, '#0b47b8'], [0.56, '#1690e6'], [0.74, '#26cfe6'], [0.88, '#56f0ae'], [1, '#d6ff6e']] },
  turbo:   { name: 'Turbo', fn: t => [
    0.13572138 + t * (4.61539260 + t * (-42.66032258 + t * (132.13108234 + t * (-152.94239396 + t * 59.28637943)))),
    0.09140261 + t * (2.19418839 + t * (4.84296658 + t * (-14.18503333 + t * (4.27729857 + t * 2.82956604)))),
    0.10667330 + t * (12.64194608 + t * (-60.58204836 + t * (110.36276771 + t * (-89.90310912 + t * 27.34824973))))] },
  inferno: { name: 'Inferno', stops: [[0, '#000004'], [0.14, '#1f0c48'], [0.29, '#550f6d'], [0.43, '#88226a'], [0.57, '#ba3655'], [0.71, '#e35933'], [0.86, '#f98e09'], [1, '#fcffa4']] },
  viridis: { name: 'Viridis', stops: [[0, '#440154'], [0.25, '#3b528b'], [0.5, '#21918c'], [0.75, '#5ec962'], [1, '#fde725']] },
  ice:     { name: 'Ice', stops: [[0, '#02040a'], [0.3, '#10264a'], [0.6, '#3d7fb5'], [0.85, '#a9dcf2'], [1, '#ffffff']] },
  flame:   { name: 'Flame', stops: [[0, '#000000'], [0.18, '#2a0700'], [0.42, '#9c2500'], [0.62, '#f06a00'], [0.82, '#ffc650'], [1, '#fffbea']] },
  grey:    { name: 'Greyscale', stops: [[0, '#000000'], [1, '#ffffff']] },
};

function hexToRgb(h) { const n = parseInt(h.slice(1), 16); return [(n >> 16) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]; }
function lutData(cm) {
  const d = new Uint8Array(256 * 4);
  for (let k = 0; k < 256; k++) {
    const t = k / 255;
    let c;
    if (cm.fn) c = cm.fn(t);
    else {
      const s = cm.stops;
      let a = 0; while (a < s.length - 2 && t > s[a + 1][0]) a++;
      const u = Math.min(1, Math.max(0, (t - s[a][0]) / (s[a + 1][0] - s[a][0])));
      const c0 = hexToRgb(s[a][1]), c1 = hexToRgb(s[a + 1][1]);
      const sm = u * u * (3 - 2 * u) * 0.35 + u * 0.65;
      c = c0.map((v, q) => v + (c1[q] - v) * sm);
    }
    for (let q = 0; q < 3; q++) d[k * 4 + q] = Math.round(255 * Math.min(1, Math.max(0, c[q])));
    d[k * 4 + 3] = 255;
  }
  return d;
}

// ---------------------------------------------------------------------------
const FS_DERIVED = GLSL_COMMON + `
uniform sampler2D uA; uniform sampler2D uB;
uniform int uField;
uniform vec2 uRange;          // display range (after log, if any)
uniform float uReN, uRaN;     // normalised gas constants
uniform vec4 uTscale;         // (T_REF, Tc_K, Ta_K, unused)
uniform float uSchlGain;
uniform float uVelScale;      // U_REF
uniform float uDx;            // cell size (m)
uniform sampler2D uT2;        // (effective viscosity, h, strain, laminar viscosity)
out vec4 o;
Prim P(ivec2 c) {
  c = clamp(c, ivec2(0), uN - 1);
  if (solidAt(c)) c = clamp(c, ivec2(0), uN - 1);
  return toPrim(texelFetch(uA, c, 0), texelFetch(uB, c, 0));
}
float lrho(ivec2 c) {
  ivec2 cc = clamp(c, ivec2(0), uN - 1);
  if (c.y < 0) cc.y = -c.y - 1;
  return log(max(texelFetch(uA, cc, 0).x, 1e-7));
}
void main() {
  ivec2 ij = ivec2(gl_FragCoord.xy);
  if (solidAt(ij)) { o = vec4(0.0, 0.0, 0.0, -1.0); return; }
  Prim q = P(ij);
  float rho = q.w.x, p = q.w.w;
  float c = soundSpeed(q);
  float spd = length(q.w.yz);
  float M = spd / c;
  float Rm = mix(uRaN, uReN, q.s.x);
  float T = p / (rho * Rm) * uTscale.x;
  float v = 0.0;
  if (uField == 0) v = T;
  else if (uField == 1) v = M;
  else if (uField == 2) {
    // numerical schlieren: |grad ln rho|, ignoring wall neighbours
    float l0 = lrho(ij);
    float le = solidAt(clamp(ij + ivec2(1,0), ivec2(0), uN-1)) ? l0 : lrho(ij + ivec2(1, 0));
    float lw = solidAt(clamp(ij - ivec2(1,0), ivec2(0), uN-1)) ? l0 : lrho(ij - ivec2(1, 0));
    float ln = solidAt(clamp(ij + ivec2(0,1), ivec2(0), uN-1)) ? l0 : lrho(ij + ivec2(0, 1));
    float ls = (ij.y > 0 && solidAt(ij - ivec2(0,1))) ? l0 : lrho(ij - ivec2(0, 1));
    float g = length(vec2(le - lw, ln - ls)) * 0.5;
    v = 1.0 - exp(-uSchlGain * g);
  }
  else if (uField == 3) v = log(p * 101325.0) / log(10.0);
  else if (uField == 4) v = log(rho * 1.225) / log(10.0);
  else if (uField == 5) v = spd * uVelScale;
  else if (uField == 6) {
    Prim e = P(ij + ivec2(1, 0)), w = P(ij - ivec2(1, 0)), n = P(ij + ivec2(0, 1));
    Prim s = Prim(vec4(q.w.x, q.w.y, -q.w.z, q.w.w), q.s);
    if (ij.y > 0) s = P(ij - ivec2(0, 1));
    float om = 0.5 * (e.w.z - w.w.z) - 0.5 * (n.w.y - s.w.y);
    v = abs(om) * uVelScale / uDx;
  }
  else if (uField == 7) v = q.s.x;
  else if (uField == 9) { vec4 m = texelFetch(uT2, ij, 0); v = m.w > 0.0 ? log(max(m.x / m.w, 1.0)) / log(10.0) : 0.0; }
  else if (uField == 10) v = q.s.x > 0.003 ? (q.s.x - q.s.y) / q.s.x : 0.0;
  else v = T;
  float t = (v - uRange.x) / (uRange.y - uRange.x);
  if (uField == 2) t = v;
  if (uField == 6) t = log(1.0 + 20.0 * max(v, 0.0) / uRange.y) / log(21.0);
  o = vec4(t, q.s.x, (T - uTscale.z) / max(uTscale.y - uTscale.z, 1.0), M);
}
`;

const FS_DISPLAY = `#version 300 es
precision highp float; precision highp int; precision highp sampler2D;
in vec2 vUv;
uniform sampler2D uD;        // derived field (t, Y, Tn, M), a = -1 in walls
uniform sampler2D uD2;       // second field for split view (lower half)
uniform int uSplit;
uniform int uField2;
uniform sampler2D uLUT;
uniform sampler2D uLUT2;     // flame colormap
uniform ivec2 uN;
uniform vec4 uView;          // x0, y0, xw, yh (cells; y signed, r = |y|)
uniform int uField;
uniform int uMirror;
uniform int uSonic;          // 0 none, 1 sonic line, 2 Mach contours
uniform vec3 uBg;
uniform float uFlameGain;
out vec4 o;
bool lowerHalf = false;
vec4 fetchD(ivec2 c) {
  c.x = clamp(c.x, 0, uN.x - 1);
  if (c.y < 0) c.y = -c.y - 1;
  c.y = min(c.y, uN.y - 1);
  return lowerHalf ? texelFetch(uD2, c, 0) : texelFetch(uD, c, 0);
}
void main() {
  float x = uView.x + vUv.x * uView.z;
  float y = uView.y + vUv.y * uView.w;
  float r = abs(y);
  if (x < 0.0 || x > float(uN.x) || r > float(uN.y) || (uMirror == 0 && y < 0.0)) { o = vec4(uBg * 0.6, 1.0); return; }
  lowerHalf = uSplit == 1 && y < 0.0;
  int field = lowerHalf ? uField2 : uField;
  vec2 g = vec2(x, r) - 0.5;
  ivec2 c0 = ivec2(floor(g));
  vec2 f = g - vec2(c0);
  vec4 d00 = fetchD(c0), d10 = fetchD(c0 + ivec2(1, 0)), d01 = fetchD(c0 + ivec2(0, 1)), d11 = fetchD(c0 + ivec2(1, 1));
  float w00 = (1.0 - f.x) * (1.0 - f.y) * step(-0.5, d00.w);
  float w10 = f.x * (1.0 - f.y) * step(-0.5, d10.w);
  float w01 = (1.0 - f.x) * f.y * step(-0.5, d01.w);
  float w11 = f.x * f.y * step(-0.5, d11.w);
  float ws = w00 + w10 + w01 + w11;
  if (ws < 1e-6) { o = vec4(0.10, 0.11, 0.14, 1.0); return; }
  vec4 d = (d00 * w00 + d10 * w10 + d01 * w01 + d11 * w11) / ws;
  vec3 col;
  if (field == 8) {
    float Tn = clamp(d.z, 0.0, 1.2);
    float Y = clamp(d.y, 0.0, 1.0);
    float tn = clamp(Tn, 0.0, 1.0);
    float em = pow(Y, 0.6) * (0.07 + 1.15 * pow(tn, 1.35)) * uFlameGain;
    vec3 fc = texture(uLUT2, vec2(clamp(0.22 + 0.78 * sqrt(tn), 0.0, 1.0), 0.5)).rgb;
    col = uBg + fc * em;
    col = col / (1.0 + 0.35 * col);
  } else {
    col = texture(uLUT, vec2(clamp(d.x, 0.002, 0.998), 0.5)).rgb;
  }
  if (uSonic > 0) {
    float M = d.w;
    float fw = max(fwidth(M), 1e-4);
    float line;
    if (uSonic == 1) line = (1.0 - smoothstep(0.6, 1.6, abs(M - 1.0) / fw)) * step(0.02, fw);
    else {
      float m2 = M * 2.0;
      float fr = abs(fract(m2 + 0.5) - 0.5) / max(fwidth(m2), 1e-3);
      line = (1.0 - smoothstep(0.5, 1.4, fr)) * 0.5 * smoothstep(0.3, 0.45, M);
      line = max(line, 1.0 - smoothstep(0.6, 1.6, abs(M - 1.0) / fw));
    }
    col = mix(col, vec3(1.0, 1.0, 1.0), line * 0.85);
  }
  if (uSplit == 1) { float fy = fwidth(y); col = mix(col, vec3(0.75, 0.8, 0.9), (1.0 - smoothstep(0.0, 1.5 * fy, abs(y))) * 0.35); }
  o = vec4(col, 1.0);
}
`;

// ---------------------------------------------------------------------------
// Particles: state texture (x, r, age, seed); advected with the local velocity
// ---------------------------------------------------------------------------
const FS_PART_ADVECT = GLSL_COMMON + `
uniform sampler2D uP;         // particle state
uniform sampler2D uA;
uniform float uDt;            // grid-time advanced since last frame
uniform float uFrame;
uniform vec4 uSpawn;          // chamber length (cells), Rc (cells), exhaust spawn share, maxAge
out vec4 o;
float hash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
vec2 vel(vec2 pos) {
  ivec2 c = ivec2(clamp(pos, vec2(0.0), vec2(uN) - 1.0));
  if (solidAt(c)) return vec2(0.0);
  vec4 a = texelFetch(uA, c, 0);
  return a.yz / max(a.x, 1e-7);
}
void main() {
  ivec2 ij = ivec2(gl_FragCoord.xy);
  vec4 s = texelFetch(uP, ij, 0);
  vec2 pos = s.xy;
  float age = s.z + 1.0;
  // RK2 advection in grid units
  vec2 v1 = vel(pos);
  vec2 mid = pos + 0.5 * uDt * v1;
  mid.y = abs(mid.y);
  vec2 v2 = vel(mid);
  pos += uDt * v2;
  pos.y = abs(pos.y);
  bool dead = age > uSpawn.w || pos.x < 0.0 || pos.x >= float(uN.x) || pos.y >= float(uN.y)
           || solidAt(ivec2(clamp(pos, vec2(0.0), vec2(uN) - 1.0)));
  if (dead || s.w == 0.0) {
    float h1 = hash(vec2(ij) + uFrame * 0.731), h2 = hash(vec2(ij).yx * 1.37 + uFrame * 0.129);
    float h3 = hash(vec2(ij) * 0.77 + uFrame * 1.913);
    if (h3 < uSpawn.z) pos = vec2(h1 * uSpawn.x, sqrt(h2) * uSpawn.y * 0.95);
    else pos = vec2(h1 * float(uN.x), sqrt(h2) * float(uN.y));
    age = floor(hash(vec2(ij) * 3.1 + uFrame) * uSpawn.w * 0.5);
  }
  float sgn = s.w == 0.0 ? (hash(vec2(ij) * 9.1) < 0.5 ? -1.0 : 1.0) : sign(s.w);
  o = vec4(pos, age, sgn * (1.0 + min(length(v2), 1e4)));
}
`;
const VS_PART = `#version 300 es
precision highp float; precision highp sampler2D;
uniform sampler2D uP;
uniform ivec2 uPN;
uniform vec4 uView;
uniform int uMirror;
uniform float uSize;
uniform float uMaxAge;
uniform vec2 uSpd;
out float vA;
void main() {
  ivec2 c = ivec2(gl_VertexID % uPN.x, gl_VertexID / uPN.x);
  vec4 s = texelFetch(uP, c, 0);
  float y = s.y * (uMirror == 1 ? sign(s.w) : 1.0);
  float spd = abs(s.w) - 1.0;
  vec2 uv = vec2((s.x - uView.x) / uView.z, (y - uView.y) / uView.w);
  gl_Position = vec4(uv * 2.0 - 1.0, 0.0, 1.0);
  gl_PointSize = uSize;
  float a = s.z / uMaxAge;
  vA = smoothstep(0.0, 0.08, a) * (1.0 - smoothstep(0.75, 1.0, a)) * (0.08 + 0.92 * smoothstep(uSpd.x, uSpd.y, spd));
  if (s.w == 0.0) vA = 0.0;
}
`;
const FS_PART = `#version 300 es
precision highp float;
in float vA;
uniform vec3 uColor;
out vec4 o;
void main() {
  vec2 d = gl_PointCoord - 0.5;
  float m = 1.0 - smoothstep(0.2, 0.5, length(d));
  o = vec4(uColor * m * vA, 1.0);
}
`;


// ---------------------------------------------------------------------------
// Glow (bloom) post-process
// ---------------------------------------------------------------------------
const FS_BRIGHT = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uS; uniform vec2 uTexel; uniform float uThr;
out vec4 o;
void main() {
  vec3 c = vec3(0.0);
  c += texture(uS, vUv + uTexel * vec2(-1.0, -1.0)).rgb;
  c += texture(uS, vUv + uTexel * vec2( 1.0, -1.0)).rgb;
  c += texture(uS, vUv + uTexel * vec2(-1.0,  1.0)).rgb;
  c += texture(uS, vUv + uTexel * vec2( 1.0,  1.0)).rgb;
  c *= 0.25;
  float l = max(c.r, max(c.g, c.b));
  o = vec4(c * smoothstep(uThr, uThr + 0.35, l), 1.0);
}
`;
const FS_BLUR = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uS; uniform vec2 uDir;
out vec4 o;
void main() {
  vec3 c = texture(uS, vUv).rgb * 0.2270270;
  c += texture(uS, vUv + uDir * 1.3846154).rgb * 0.3162162;
  c += texture(uS, vUv - uDir * 1.3846154).rgb * 0.3162162;
  c += texture(uS, vUv + uDir * 3.2307692).rgb * 0.0702703;
  c += texture(uS, vUv - uDir * 3.2307692).rgb * 0.0702703;
  o = vec4(c, 1.0);
}
`;
const FS_COMBINE = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uS; uniform sampler2D uB1; uniform sampler2D uB2; uniform float uK;
out vec4 o;
void main() {
  vec3 c = texture(uS, vUv).rgb + uK * (0.6 * texture(uB1, vUv).rgb + 0.9 * texture(uB2, vUv).rgb);
  // soft shoulder above 0.8 only, so unbloomed colours are untouched
  vec3 hi = 0.8 + 0.2 * (1.0 - exp(-(c - 0.8) / 0.2));
  c = mix(c, hi, step(0.8, c));
  o = vec4(c, 1.0);
}
`;

class Renderer {
  constructor(gl, solver) {
    this.gl = gl; this.solver = solver;
    this.progDerived = solver._program(VS_QUAD, FS_DERIVED);
    this.progDisplay = solver._program(VS_QUAD, FS_DISPLAY);
    this.progAdvect = solver._program(VS_QUAD, FS_PART_ADVECT);
    this.progPart = solver._program(VS_PART, FS_PART);
    this.lut = this._lutTex(); this.lut2 = this._lutTex();
    this.setColormap('plasma');
    this._setLut(this.lut2, COLORMAPS.flame);
    this.PN = [128, 64];
    this.frame = 0;
    this.progBright = solver._program(VS_QUAD, FS_BRIGHT);
    this.progBlur = solver._program(VS_QUAD, FS_BLUR);
    this.progCombine = solver._program(VS_QUAD, FS_COMBINE);
    this.post = null;
  }
  _rt(w, h) {
    const gl = this.gl, t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const f = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, f);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { t, f, w, h };
  }
  _ensurePost(W, H) {
    const gl = this.gl;
    if (this.post && this.post.W === W && this.post.H === H) return;
    if (this.post) for (const r of this.post.all) { gl.deleteTexture(r.t); gl.deleteFramebuffer(r.f); }
    const w2 = Math.max(1, W >> 2), h2 = Math.max(1, H >> 2), w3 = Math.max(1, W >> 3), h3 = Math.max(1, H >> 3);
    const scene = this._rt(W, H), a = this._rt(w2, h2), b = this._rt(w2, h2), c = this._rt(w3, h3), d = this._rt(w3, h3);
    this.post = { W, H, scene, a, b, c, d, all: [scene, a, b, c, d] };
  }
  _pass(prog, target, binds, uni) {
    const gl = this.gl, s = this.solver;
    gl.useProgram(prog.p);
    let unit = 0;
    for (const [name, tex] of binds) s._bindTex(prog, name, tex, unit++);
    uni && uni(prog);
    gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.f : null);
    gl.viewport(0, 0, target ? target.w : this.post.W, target ? target.h : this.post.H);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
  _lutTex() {
    const gl = this.gl, t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }
  _setLut(tex, cm) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 256, 1, gl.RGBA, gl.UNSIGNED_BYTE, lutData(cm));
  }
  setColormap(id) { this._setLut(this.lut, COLORMAPS[id] || COLORMAPS.plasma); this.cmap = id; }

  resize(Nx, Nr) {
    const gl = this.gl, s = this.solver;
    if (this.derived) { gl.deleteTexture(this.derived); gl.deleteFramebuffer(this.derivedFbo); }
    if (this.derived2) { gl.deleteTexture(this.derived2); gl.deleteFramebuffer(this.derivedFbo2); }
    this.derived = s._tex(Nx, Nr, gl.RGBA32F, gl.RGBA, gl.FLOAT);
    this.derivedFbo = s._fbo([this.derived]);
    this.derived2 = s._tex(Nx, Nr, gl.RGBA32F, gl.RGBA, gl.FLOAT);
    this.derivedFbo2 = s._fbo([this.derived2]);
    if (!this.pTex) {
      this.pTex = [0, 1].map(() => s._tex(this.PN[0], this.PN[1], gl.RGBA32F, gl.RGBA, gl.FLOAT));
      this.pFbo = this.pTex.map(t => s._fbo([t]));
      this.pIdx = 0;
    }
    this.resetParticles();
  }
  resetParticles() {
    const gl = this.gl, z = new Float32Array(this.PN[0] * this.PN[1] * 4);
    for (const t of this.pTex) { gl.bindTexture(gl.TEXTURE_2D, t); gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, this.PN[0], this.PN[1], gl.RGBA, gl.FLOAT, z); }
  }

  // V: view/display parameters from the app
  derive(V, second = false) {
    const gl = this.gl, s = this.solver, pr = this.progDerived;
    if (second) V = Object.assign({}, V, { fieldIndex: V.fieldIndex2, range: V.range2 });
    gl.bindVertexArray(s.vao);
    gl.useProgram(pr.p);
    gl.uniform2i(pr.u.uN, s.Nx, s.Nr);
    s._bindTex(pr, 'uA', s.state.A, 0); s._bindTex(pr, 'uB', s.state.B, 1); s._bindTex(pr, 'uMask', s.mask, 2); s._bindTex(pr, 'uT2', s.vis.T2, 3);
    gl.uniform1i(pr.u.uField, V.fieldIndex === 8 ? 0 : V.fieldIndex);
    gl.uniform2f(pr.u.uRange, V.range[0], V.range[1]);
    gl.uniform1f(pr.u.uReN, V.ReN); gl.uniform1f(pr.u.uRaN, V.RaN);
    gl.uniform4f(pr.u.uTscale, T_REF, V.Tc, V.Ta, 0);
    gl.uniform1f(pr.u.uSchlGain, V.schlGain);
    gl.uniform1f(pr.u.uVelScale, U_REF);
    gl.uniform1f(pr.u.uDx, V.dx);
    s._draw(second ? this.derivedFbo2 : this.derivedFbo, s.Nx, s.Nr);
  }

  advectParticles(dtGrid, spawn) {
    const gl = this.gl, s = this.solver, pr = this.progAdvect;
    gl.bindVertexArray(s.vao);
    gl.useProgram(pr.p);
    gl.uniform2i(pr.u.uN, s.Nx, s.Nr);
    s._bindTex(pr, 'uP', this.pTex[this.pIdx], 0); s._bindTex(pr, 'uA', s.state.A, 1); s._bindTex(pr, 'uMask', s.mask, 2);
    gl.uniform1f(pr.u.uDt, dtGrid);
    gl.uniform1f(pr.u.uFrame, (this.frame++ % 997) + 1);
    gl.uniform4fv(pr.u.uSpawn, spawn);
    this.pIdx = 1 - this.pIdx;
    s._draw(this.pFbo[this.pIdx], this.PN[0], this.PN[1]);
  }

  display(V, width, height) {
    const gl = this.gl, s = this.solver, pr = this.progDisplay;
    gl.bindVertexArray(s.vao);
    if (V.glow) { this._ensurePost(width, height); gl.bindFramebuffer(gl.FRAMEBUFFER, this.post.scene.f); }
    else gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, width, height);
    gl.disable(gl.BLEND);
    gl.useProgram(pr.p);
    s._bindTex(pr, 'uD', this.derived, 0); s._bindTex(pr, 'uLUT', this.lut, 1); s._bindTex(pr, 'uLUT2', this.lut2, 2);
    s._bindTex(pr, 'uD2', V.split ? this.derived2 : this.derived, 3);
    gl.uniform1i(pr.u.uSplit, V.split ? 1 : 0);
    gl.uniform1i(pr.u.uField2, V.fieldIndex2);
    gl.uniform2i(pr.u.uN, s.Nx, s.Nr);
    gl.uniform4fv(pr.u.uView, V.view);
    gl.uniform1i(pr.u.uField, V.fieldIndex);
    gl.uniform1i(pr.u.uMirror, V.mirror ? 1 : 0);
    gl.uniform1i(pr.u.uSonic, V.sonic);
    gl.uniform3fv(pr.u.uBg, V.bg);
    gl.uniform1f(pr.u.uFlameGain, V.flameGain);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    if (V.particles) {
      const pp = this.progPart;
      if (!this.emptyVao) this.emptyVao = gl.createVertexArray();
      gl.bindVertexArray(this.emptyVao);
      gl.useProgram(pp.p);
      gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE);
      s._bindTex(pp, 'uP', this.pTex[this.pIdx], 0);
      gl.uniform2i(pp.u.uPN, this.PN[0], this.PN[1]);
      gl.uniform4fv(pp.u.uView, V.view);
      gl.uniform1i(pp.u.uMirror, V.mirror ? 1 : 0);
      gl.uniform1f(pp.u.uSize, V.particleSize);
      gl.uniform1f(pp.u.uMaxAge, V.particleAge);
      gl.uniform2f(pp.u.uSpd, V.spdRef * 0.04, V.spdRef * 0.4);
      gl.uniform3f(pp.u.uColor, 0.6, 0.66, 0.72);
      gl.drawArrays(gl.POINTS, 0, this.PN[0] * this.PN[1]);
      gl.disable(gl.BLEND);
    }
    if (V.glow) {
      const P = this.post;
      gl.bindVertexArray(s.vao);
      this._pass(this.progBright, P.a, [['uS', P.scene.t]], pr => { gl.uniform2f(pr.u.uTexel, 1 / P.W, 1 / P.H); gl.uniform1f(pr.u.uThr, V.glowThr); });
      this._pass(this.progBlur, P.b, [['uS', P.a.t]], pr => gl.uniform2f(pr.u.uDir, 1 / P.a.w, 0));
      this._pass(this.progBlur, P.a, [['uS', P.b.t]], pr => gl.uniform2f(pr.u.uDir, 0, 1 / P.a.h));
      this._pass(this.progBlur, P.c, [['uS', P.a.t]], pr => gl.uniform2f(pr.u.uDir, 1.5 / P.a.w, 0));
      this._pass(this.progBlur, P.d, [['uS', P.c.t]], pr => gl.uniform2f(pr.u.uDir, 2 / P.c.w, 0));
      this._pass(this.progBlur, P.c, [['uS', P.d.t]], pr => gl.uniform2f(pr.u.uDir, 0, 2 / P.c.h));
      this._pass(this.progCombine, null, [['uS', P.scene.t], ['uB1', P.a.t], ['uB2', P.c.t]], pr => gl.uniform1f(pr.u.uK, V.glowK));
    }
  }
}

if (typeof module !== 'undefined') module.exports = { Renderer, FIELDS, COLORMAPS };
