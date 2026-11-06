// ============================================================================
// spray.js — liquid propellant sprays on the GPU, coupled both ways to the gas.
//
// Parcels live in textures (one texel per parcel):
//   PA = (x, r, u, v)              position in cells, velocity in U_REF
//   PB = (drop diameter m, parcel mass, type 0 fuel / 1 oxidiser, impingement x)
//   PC = (mass evaporated, x momentum, r momentum, 0)   given to the gas this step
// Each step: new parcels overwrite the oldest ones (ring buffer), every parcel feels
// drag (Schiller-Naumann), evaporates (d²-law with a Ranz-Marshall correction) and
// breaks up (Weber number above 12 relaxes to the stable drop size). What parcels give
// up is then drawn as points into a source texture, and one pass applies it to the gas.
// Mass units: m_hat = m / (2 pi rho_ref dx^3), matching the solver's r-weighted volumes.
// ============================================================================
'use strict';

const SPRAY_W = 256, SPRAY_H = 256, SPRAY_N = SPRAY_W * SPRAY_H;
const SPRAY_PER_STEP = 4;      // parcels born each step, so the ring lasts ~16,000 steps

const FS_SPRAY_UPDATE = GLSL_COMMON + `
uniform sampler2D uPA; uniform sampler2D uPB;
uniform sampler2D uW; uniform sampler2D uWb;
uniform sampler2D uStep; uniform sampler2D uTab;
uniform ivec3 uSpawn;     // (head, parcels per step, total)
uniform uint uSeed;
uniform float uMhat;      // total mass flow, normalised per grid time
uniform vec4 uFuel; uniform vec4 uOx;   // (liquid density, boiling T, effective latent heat, surface tension)
uniform vec2 uUnits;      // (seconds per grid time, unused)
uniform vec4 uGas; uniform vec3 uRs;
uniform float uFan;       // half-angle of the fan after impingement
layout(location = 0) out vec4 oA;
layout(location = 1) out vec4 oB;
layout(location = 2) out vec4 oC;
uint pcg(uint v) { uint s = v * 747796405u + 2891336453u; uint w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u; return (w >> 22u) ^ w; }
float rnd(uint a, uint n) { return float(pcg(a + n * 7919u) & 0xffffffu) / 16777216.0; }
bool wallAt(vec2 x) {
  ivec2 c = ivec2(floor(x));
  if (c.x < 0 || c.y < 0 || c.x >= uN.x || c.y >= uN.y) return false;
  return texelFetch(uW, c + 2, 0).x < 0.0;
}
void main() {
  ivec2 c = ivec2(gl_FragCoord.xy);
  vec4 a = texelFetch(uPA, c, 0), b = texelFetch(uPB, c, 0);
  int idx = c.x + c.y * ${SPRAY_W}, rel = idx - uSpawn.x;
  if (rel < 0) rel += uSpawn.z;
  float dt = texelFetch(uStep, ivec2(0), 0).x;
  if (rel < uSpawn.y) {
    // new parcel. Anything still liquid in the old one is handed to the gas, so no mass is lost.
    uint id = uint(idx) ^ (uSeed * 2654435761u);
    int t = int(rnd(id, 1u) * 255.999);
    vec4 e1 = texelFetch(uTab, ivec2(t, 0), 0), e2 = texelFetch(uTab, ivec2(t, 1), 0), e3 = texelFetch(uTab, ivec2(t, 2), 0);
    float ang = e1.z + (rnd(id, 2u) - 0.5) * 2.0 * e2.z;
    float r = max(e1.y + (rnd(id, 3u) - 0.5) * e2.w, 0.05);
    float d = e2.y * exp((rnd(id, 4u) - 0.5) * 1.4);
    oA = vec4(e1.x, r, e1.w * cos(ang), e1.w * sin(ang));
    oB = vec4(d, uMhat * dt / float(uSpawn.y), e2.x, e3.x);
    oC = b.y > 0.0 ? vec4(b.y, b.y * a.zw, 0.0) : vec4(0.0);
    return;
  }
  oA = a; oB = b; oC = vec4(0.0);
  if (b.y <= 0.0) return;
  ivec2 g = clamp(ivec2(floor(a.xy)), ivec2(0), uN - 1);
  vec4 w = texelFetch(uW, g + 2, 0);
  // born inside solid hardware (a baffle or post at the same radius): walk out into the flow
  if (w.x < 0.0) { oA = vec4(a.x + 1.0, max(a.y - 0.5, 0.05), max(a.z, 0.0), a.w); return; }
  vec4 pr = b.z < 0.5 ? uFuel : uOx;
  vec2 v = a.zw;
  float m = b.y, d = b.x, dts = dt * uUnits.x;
  float dn = d, mn = m;
  if (w.x > 0.0) {
    vec4 s = texelFetch(uWb, g + 2, 0);
    float rm = (1.0 - s.x) * uGas.x + s.y * uRs.x + s.w * uRs.y + max(s.x - s.y - s.w, 0.0) * uRs.z;
    float T = w.w / (w.x * rm) * uGas.z;
    float rhoG = w.x * 1.225, Urel = length(w.yz - v) * 287.6 + 1e-3;
    float mu = 1.458e-6 * T * sqrt(T) / (T + 110.4);
    float Re = rhoG * Urel * d / mu;
    float invTau = 18.0 * mu * (1.0 + 0.15 * pow(min(Re, 1000.0), 0.687)) / (pr.x * d * d);
    v = w.yz + (v - w.yz) * exp(-dts * invTau);
    // evaporation: d²-law, heat-transfer driven (Spalding number B)
    float cp = rm * 287.05 * (s.z + 1.0);
    float B = max(cp * (T - pr.y), 0.0) / pr.z;
    float K = 8.0 * (mu / 0.7) / pr.x * log(1.0 + B) * (1.0 + 0.27 * sqrt(Re));
    float d2 = d * d - K * dts;
    dn = d2 > 1e-12 ? sqrt(d2) : 0.0;
    float f = dn / d;
    mn = dn > 0.0 ? m * f * f * f : 0.0;
    // secondary break-up: drops split towards the stable Weber number (mass is unchanged)
    float we = rhoG * Urel * Urel * dn / pr.w;
    if (we > 12.0 && dn > 0.0) {
      float dst = 12.0 * pr.w / (rhoG * Urel * Urel);
      float tb = 3.0 * dn / Urel * sqrt(pr.x / rhoG);
      dn = mix(dn, max(dst, 2e-6), 1.0 - exp(-dts / tb));
    }
  }
  float xi = b.w;
  // impingement: the jets collide and shatter into a fine fan
  if (xi > 0.0 && a.x >= xi) {
    uint id = uint(idx) ^ (uSeed * 2654435761u);
    float sp = length(v), phi = (rnd(id, 5u) - 0.5) * 2.0 * uFan;
    v = sp * vec2(cos(phi), sin(phi));
    dn *= 0.25; xi = 0.0;
  }
  vec2 x = a.xy + v * dt;
  if (x.y < 0.0) { x.y = -x.y; v.y = -v.y; }
  if (x.x < 0.0) { x.x = -x.x; v.x = abs(v.x) * 0.3; }
  if (wallAt(x)) {                     // hits a wall: stays nearby as a slowed, film-like parcel
    bool hx = wallAt(vec2(x.x, a.y)), hr = wallAt(vec2(a.x, x.y));
    if (hx) { v.x *= -0.3; x.x = a.x; }
    if (hr) { v.y *= -0.3; x.y = a.y; }
    if (!hx && !hr) { x = a.xy; v *= -0.3; }
  }
  float dm = m - mn;
  vec2 dp = mn * (a.zw - v) + dm * a.zw;
  oC = vec4(dm, dp, 0.0);
  if (x.x >= float(uN.x) || x.y >= float(uN.y) || mn <= 0.0) {
    oA = vec4(-1.0, -1.0, 0.0, 0.0);
    oB = vec4(0.0);
    return;
  }
  oA = vec4(x, v);
  oB = vec4(dn, mn, b.z, xi);
}
`;

// what each parcel gave up this step, drawn as a point into the gas cell it started in
const VS_SPRAY_DEP = `#version 300 es
precision highp float; precision highp int; precision highp sampler2D;
uniform sampler2D uPA; uniform sampler2D uPB; uniform sampler2D uPC;
uniform sampler2D uGeoM;
uniform ivec2 uN;
out vec4 vS;
void main() {
  ivec2 t = ivec2(gl_VertexID % ${SPRAY_W}, gl_VertexID / ${SPRAY_W});
  vec4 a = texelFetch(uPA, t, 0), c = texelFetch(uPC, t, 0);
  gl_PointSize = 1.0;
  vS = vec4(0.0);
  if (a.x < 0.0 || (c.x == 0.0 && c.y == 0.0 && c.z == 0.0)) { gl_Position = vec4(2.0, 2.0, 0.0, 1.0); return; }
  float type = texelFetch(uPB, t, 0).z;
  ivec2 g = clamp(ivec2(floor(a.xy)), ivec2(0), uN - 1);
  g += ivec2(round(texelFetch(uGeoM, g, 0).xy));
  vS = vec4(c.x * (1.0 - type), c.x * type, c.y, c.z);
  gl_Position = vec4((vec2(g) + 0.5) / vec2(uN) * 2.0 - 1.0, 0.0, 1.0);
}
`;
const FS_SPRAY_DEP = `#version 300 es
precision highp float;
in vec4 vS;
out vec4 o;
void main() { o = vS; }
`;
const FS_SPRAY_APPLY = GLSL_COMMON + `
uniform sampler2D uA; uniform sampler2D uB;
uniform sampler2D uSrc;   // (fuel vapour, oxidiser vapour, x momentum, r momentum)
uniform sampler2D uGeoG; uniform sampler2D uGeoM;
uniform vec3 uE;          // (energy of fuel vapour, of oxidiser vapour, G of the engine gases)
uniform vec4 uAmbCons; uniform vec4 uAmbB;
layout(location = 0) out vec4 oA;
layout(location = 1) out vec4 oB;
void main() {
  ivec2 ij = ivec2(gl_FragCoord.xy);
  if (solidAt(ij)) { oA = uAmbCons; oB = uAmbB; return; }
  ivec2 H = ij + ivec2(round(texelFetch(uGeoM, ij, 0).xy));
  vec4 src = texelFetch(uSrc, H, 0);
  vec4 A = texelFetch(uA, H, 0), B = texelFetch(uB, H, 0);
  float invV = 1.0 / max(texelFetch(uGeoG, ij, 0).x, 1e-6);
  float dm = src.x + src.y;
  if (dm == 0.0 && src.z == 0.0 && src.w == 0.0) { oA = A; oB = B; return; }
  vec2 vel = A.yz / max(A.x, RHO_MIN);
  float rn = A.x + dm * invV;
  vec2 mom = A.yz + src.zw * invV;
  float E = A.w + (src.x * uE.x + src.y * uE.y + dot(vel, src.zw)) * invV;
  float phi = min(dm * invV / rn, 1.0);
  float Gn = mix(B.z, uE.z, phi);
  vec2 vn = mom / rn;
  // evaporation may not take the gas below a small positive internal energy
  E = max(E, 0.02 * A.w + 0.5 * rn * dot(vn, vn) + P_MIN * Gn);
  oA = vec4(rn, mom, E);
  oB = vec4(B.x + dm * invV, B.y + src.x * invV, Gn, B.w + src.y * invV);
}
`;
// droplets drawn over the flow field
const VS_SPRAY_DRAW = `#version 300 es
precision highp float; precision highp int; precision highp sampler2D;
uniform sampler2D uPA; uniform sampler2D uPB;
uniform vec4 uView;
uniform float uDrop;       // pixels per metre of drop diameter (exaggerated)
uniform float uPx;
out vec4 vC;
void main() {
  int n = ${SPRAY_N};
  float sgn = gl_VertexID < n ? 1.0 : -1.0;
  int id = gl_VertexID < n ? gl_VertexID : gl_VertexID - n;
  ivec2 t = ivec2(id % ${SPRAY_W}, id / ${SPRAY_W});
  vec4 a = texelFetch(uPA, t, 0), b = texelFetch(uPB, t, 0);
  if (a.x < 0.0 || b.y <= 0.0) { gl_Position = vec4(2.0, 2.0, 0.0, 1.0); gl_PointSize = 1.0; vC = vec4(0.0); return; }
  vec2 uv = vec2((a.x - uView.x) / uView.z, (sgn * a.y - uView.y) / uView.w);
  gl_Position = vec4(uv * 2.0 - 1.0, 0.0, 1.0);
  gl_PointSize = clamp(b.x * uDrop, 1.2, 6.0) * uPx;
  vC = b.z < 0.5 ? vec4(1.0, 0.62, 0.15, 0.9) : vec4(0.35, 0.85, 1.0, 0.9);
}
`;
const FS_SPRAY_DRAW = `#version 300 es
precision highp float;
in vec4 vC;
out vec4 o;
void main() {
  float m = 1.0 - smoothstep(0.25, 0.5, length(gl_PointCoord - 0.5));
  o = vec4(vC.rgb * m * vC.a, m * vC.a);
}
`;

class GPUSpray {
  constructor(solver) {
    this.s = solver;
    const gl = solver.gl;
    this.blendOk = !!gl.getExtension('EXT_float_blend');
    this.progUpdate = solver._program(VS_QUAD, FS_SPRAY_UPDATE);
    this.progDep = solver._program(VS_SPRAY_DEP, FS_SPRAY_DEP);
    this.progApply = solver._program(VS_QUAD, FS_SPRAY_APPLY);
    this.progDraw = solver._program(VS_SPRAY_DRAW, FS_SPRAY_DRAW);
    this.emptyVao = gl.createVertexArray();
    this.head = 0; this.seed = 1;
    this.ready = false;
  }
  resize() {
    const s = this.s, gl = s.gl;
    const T = (w, h) => { const t = s._tex(w, h, gl.RGBA32F, gl.RGBA, gl.FLOAT); s._texList.push(t); return t; };
    const F = (ts) => { const f = s._fbo(ts); s._fboList.push(f); return f; };
    this.P = [0, 1].map(() => { const A = T(SPRAY_W, SPRAY_H), B = T(SPRAY_W, SPRAY_H), C = T(SPRAY_W, SPRAY_H); return { A, B, C, fbo: F([A, B, C]) }; });
    this.src = T(s.Nx, s.Nr);
    this.srcFbo = F([this.src]);
    this.tab = T(256, 3);
    this.cur = 0;
    this.ready = true;
    this.reset();
  }
  setInjector(inj) {
    if (!inj || !this.ready) return;
    const gl = this.s.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.tab);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 256, 3, gl.RGBA, gl.FLOAT, inj.tab);
  }
  reset() {
    if (!this.ready) return;
    const gl = this.s.gl;
    const dead = new Float32Array(SPRAY_N * 4);
    for (let k = 0; k < SPRAY_N; k++) { dead[k * 4] = -1; dead[k * 4 + 1] = -1; }
    const zero = new Float32Array(SPRAY_N * 4);
    for (const p of this.P) {
      gl.bindTexture(gl.TEXTURE_2D, p.A); gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, SPRAY_W, SPRAY_H, gl.RGBA, gl.FLOAT, dead);
      gl.bindTexture(gl.TEXTURE_2D, p.B); gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, SPRAY_W, SPRAY_H, gl.RGBA, gl.FLOAT, zero);
      gl.bindTexture(gl.TEXTURE_2D, p.C); gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, SPRAY_W, SPRAY_H, gl.RGBA, gl.FLOAT, zero);
    }
    this.head = 0;
  }
  // S: gas state now, out: where the updated gas state goes
  step(S, stepTex, out, P) {
    const s = this.s, gl = s.gl, d = P.injData;
    const from = this.P[this.cur], to = this.P[1 - this.cur];
    // ---- parcels
    let pr = this.progUpdate;
    s._common(pr, P);
    s._bindTex(pr, 'uPA', from.A, 0); s._bindTex(pr, 'uPB', from.B, 1);
    s._bindTex(pr, 'uW', s.prim.W, 2); s._bindTex(pr, 'uWb', s.prim.Wb, 3);
    s._bindTex(pr, 'uStep', stepTex, 4); s._bindTex(pr, 'uTab', this.tab, 5); s._bindTex(pr, 'uMask', s.mask, 6);
    gl.uniform3i(pr.u.uSpawn, this.head, SPRAY_PER_STEP, SPRAY_N);
    gl.uniform1ui(pr.u.uSeed, this.seed);
    gl.uniform1f(pr.u.uMhat, P.spray.mhat);
    gl.uniform4fv(pr.u.uFuel, d.fuelVec); gl.uniform4fv(pr.u.uOx, d.oxVec);
    gl.uniform2f(pr.u.uUnits, P.spray.tScale, 0);
    gl.uniform4fv(pr.u.uGas, P.gas); gl.uniform3fv(pr.u.uRs, P.Rs);
    gl.uniform1f(pr.u.uFan, 25 * Math.PI / 180);
    s._draw(to.fbo, SPRAY_W, SPRAY_H);
    // ---- deposit
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.srcFbo);
    gl.viewport(0, 0, s.Nx, s.Nr);
    gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
    pr = this.progDep;
    gl.useProgram(pr.p);
    gl.bindVertexArray(this.emptyVao);
    gl.uniform2i(pr.u.uN, s.Nx, s.Nr);
    s._bindTex(pr, 'uPA', from.A, 0); s._bindTex(pr, 'uPB', from.B, 1); s._bindTex(pr, 'uPC', to.C, 2); s._bindTex(pr, 'uGeoM', s.geoM, 3);
    gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE);
    gl.drawArrays(gl.POINTS, 0, SPRAY_N);
    gl.disable(gl.BLEND);
    gl.bindVertexArray(s.vao);
    // ---- gas sources
    pr = this.progApply;
    s._common(pr, P);
    s._bindTex(pr, 'uA', S.A, 0); s._bindTex(pr, 'uB', S.B, 1); s._bindTex(pr, 'uSrc', this.src, 2);
    s._bindTex(pr, 'uGeoG', s.geoG, 3); s._bindTex(pr, 'uGeoM', s.geoM, 4); s._bindTex(pr, 'uMask', s.mask, 5);
    gl.uniform3f(pr.u.uE, d.eF, d.eO, d.Ge);
    gl.uniform4fv(pr.u.uAmbCons, P.ambCons); gl.uniform4fv(pr.u.uAmbB, P.ambB);
    s._draw(out.fbo, s.Nx, s.Nr);
    this.cur = 1 - this.cur;
    this.head = (this.head + SPRAY_PER_STEP) % SPRAY_N;
    this.seed = (this.seed + 1) >>> 0;
  }
  // overlay of liquid drops onto the current framebuffer
  draw(view, mirror, dropScale, px) {
    const s = this.s, gl = s.gl, pr = this.progDraw;
    gl.useProgram(pr.p);
    gl.bindVertexArray(this.emptyVao);
    s._bindTex(pr, 'uPA', this.P[this.cur].A, 0); s._bindTex(pr, 'uPB', this.P[this.cur].B, 1);
    gl.uniform4fv(pr.u.uView, view);
    gl.uniform1f(pr.u.uDrop, dropScale);
    gl.uniform1f(pr.u.uPx, px);
    gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.drawArrays(gl.POINTS, 0, mirror ? 2 * SPRAY_N : SPRAY_N);
    gl.disable(gl.BLEND);
  }
  // liquid still in the chamber, by type: { fuel, ox, parcels, meanD } (synchronous; for tests and occasional read-outs)
  stats(P) {
    const s = this.s, b = s._readRect(this.P[this.cur].B, 0, 0, SPRAY_W, SPRAY_H);
    let f = 0, o = 0, n = 0, dS = 0;
    for (let k = 0; k < SPRAY_N; k++) {
      const m = b[k * 4 + 1];
      if (m > 0) { n++; dS += b[k * 4]; if (b[k * 4 + 2] < 0.5) f += m; else o += m; }
    }
    return { fuel: f, ox: o, parcels: n, meanD: n ? dS / n : 0 };
  }
}
