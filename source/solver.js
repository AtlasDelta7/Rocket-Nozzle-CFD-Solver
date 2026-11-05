// ============================================================================
// solver.js — WebGL2 GPU solver for the 2-D axisymmetric compressible Euler
// equations + a passive exhaust scalar.
//   * Finite volume, uniform square cells (dx = dr = 1 in grid units)
//   * MUSCL reconstruction of primitives (van Leer limiter)
//   * HLLC Riemann solver, blended to HLL near strong shocks (anti-carbuncle)
//   * SSP-RK2 (Heun) time stepping, CFL time step computed on the GPU
//   * Staircase solid walls via mirror ghost states
// State textures (RGBA32F): A = (rho, rho*u, rho*v, E), B = (rho*Y, 0, 0, 0)
// All quantities are normalised: p/P_REF, rho/RHO_REF, u/U_REF.
// ============================================================================
'use strict';

const GLSL_COMMON = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
uniform ivec2 uN;          // Nx, Nr
uniform float uGamma;
uniform sampler2D uMask;   // r > 0.5 : solid
const float RHO_MIN = 1e-7;
const float P_MIN   = 1e-7;
struct Prim { vec4 w; float y; };   // w = (rho, u, v, p)

bool solidAt(ivec2 c) { return texelFetch(uMask, c, 0).r > 0.5; }

Prim toPrim(vec4 a, float b) {
  float rho = max(a.x, RHO_MIN);
  vec2 vel = a.yz / rho;
  float p = max((uGamma - 1.0) * (a.w - 0.5 * rho * dot(vel, vel)), P_MIN);
  return Prim(vec4(rho, vel, p), clamp(b / rho, 0.0, 1.0));
}
`;

const VS_QUAD = `#version 300 es
in vec2 aPos;
out vec2 vUv;
void main() { vUv = aPos * 0.5 + 0.5; gl_Position = vec4(aPos, 0.0, 1.0); }
`;

// ---------------------------------------------------------------------------
// Primitive pass: writes a PADDED texture of size (Nx+4) x (Nr+4) holding the
// primitive state (rho,u,v,p) of every cell plus a 2-cell halo of boundary
// ghost cells (stagnation inlet, far field, outflow, axis mirror). Wall cells
// are flagged with rho < 0. All boundary branching lives here, once per cell,
// which keeps the flux shaders small and quick to compile.
// ---------------------------------------------------------------------------
const FS_PRIM = GLSL_COMMON + `
uniform sampler2D uA; uniform sampler2D uB;
uniform sampler2D uStep;    // (dt, t_old, t_new, wmax)
uniform int uTimeSel;       // 1 -> t_old, 2 -> t_new
uniform vec4 uAmb;          // freestream primitive (rho, u, v, p), Y = 0
uniform vec3 uRes;          // reservoir: (P0 target, T0 normalised, R_exhaust normalised)
uniform float uPambStart;   // pressure at which the ignition ramp starts
uniform float uRamp;        // ramp duration (grid time units); <= 0 -> instant
uniform float uRcCells;     // chamber radius in cells (reservoir rows)
layout(location = 0) out vec4 oW;
layout(location = 1) out vec4 oWb;
Prim interior(ivec2 c) { return toPrim(texelFetch(uA, c, 0), texelFetch(uB, c, 0).r); }
void main() {
  ivec2 P = ivec2(gl_FragCoord.xy) - 2;
  int i = P.x, j = P.y, Nx = uN.x, Nr = uN.y;
  bool mir = j < 0;
  if (mir) j = -j - 1;
  Prim q = Prim(uAmb, 0.0);
  bool wall = false;
  if (i < 0) {
    // left boundary: injector face (stagnation inlet) / chamber wall / free stream
    if (j < Nr && solidAt(ivec2(0, j))) wall = true;
    else if (float(j) + 0.5 < uRcCells) {
      vec4 st = texelFetch(uStep, ivec2(0), 0);
      float t = uTimeSel == 1 ? st.y : st.z;
      float f = uRamp > 0.0 ? smoothstep(0.0, uRamp, t) : 1.0;
      float P0 = mix(uPambStart, uRes.x, f);
      float T0 = uRes.y, R = uRes.z, g = uGamma;
      vec4 a = texelFetch(uA, ivec2(0, j), 0);
      float u = clamp(a.y / max(a.x, RHO_MIN), 0.0, 0.5 * sqrt(g * R * T0));
      float T = T0 - u * u * (g - 1.0) / (2.0 * g * R);
      float p = P0 * pow(T / T0, g / (g - 1.0));
      q = Prim(vec4(p / (R * T), u, 0.0, p), 1.0);
    }
  } else if (j >= Nr) {
    // top: pressure far field
    ivec2 c = ivec2(min(i, Nx - 1), Nr - 1);
    if (!solidAt(c)) {
      Prim t = interior(c);
      float cs = sqrt(uGamma * t.w.w / t.w.x);
      if (t.w.z >= cs) q = t;
      else if (t.w.z > 0.0) { q = t; q.w.w = uAmb.w; }
    }
  } else if (i >= Nx) {
    // right: supersonic / subsonic outflow
    ivec2 c = ivec2(Nx - 1, j);
    if (!solidAt(c)) {
      Prim t = interior(c);
      float cs = sqrt(uGamma * t.w.w / t.w.x);
      if (t.w.y >= cs) q = t;
      else if (t.w.y > 0.0) { q = t; q.w.w = uAmb.w; }
      else q.w.y = max(q.w.y, 0.0);
    }
  } else {
    if (solidAt(ivec2(i, j))) wall = true; else q = interior(ivec2(i, j));
  }
  if (wall) { oW = vec4(-1.0, 0.0, 0.0, 1.0); oWb = vec4(0.0); return; }
  if (mir) q.w.z = -q.w.z;           // axis of symmetry
  oW = q.w; oWb = vec4(q.y, 0.0, 0.0, 0.0);
}
`;

// ---------------------------------------------------------------------------
// Flux passes (one small program per direction).
//   x-pass: pixel (i,j) of an (Nx+1) x Nr target -> flux through the WEST face of cell (i,j)
//   r-pass: pixel (i,j) of an Nx x (Nr+1) target -> flux through the SOUTH face of cell (i,j)
// ---------------------------------------------------------------------------
function makeFluxShader(dirR) { return GLSL_COMMON + `
#define DIR_R ${dirR ? 1 : 0}
uniform sampler2D uGeoA;    // (V, Am, Ax_west, Ar_south); negative area => first order
uniform sampler2D uW;       // padded primitive (rho, u, v, p); rho < 0 marks a wall cell
uniform sampler2D uWb;      // padded (Y, 0, 0, 0)
uniform float uLimiter;     // 0 = first order, 1 = second order
uniform float uHllBlend;    // sensitivity of HLL blending (0 disables)
layout(location = 0) out vec4 oF;
layout(location = 1) out vec4 oFY;

Prim cellP(int i, int j, out bool s) {
  ivec2 c = ivec2(i + 2, j + 2);
  vec4 w = texelFetch(uW, c, 0);
  s = w.x < 0.0;
  Prim q = Prim(w, texelFetch(uWb, c, 0).r);
#if DIR_R
  q.w.yz = q.w.zy;          // face-normal frame: normal velocity in .y
#endif
  return q;
}
float pAt(int i, int j, float fb) { vec4 w = texelFetch(uW, ivec2(i + 2, j + 2), 0); return w.x < 0.0 ? fb : w.w; }
Prim mirrorN(Prim q) { q.w.y = -q.w.y; return q; }
vec4 vanLeer(vec4 a, vec4 b) {
  vec4 ab = a * b, den = a + b;
  den = mix(den, vec4(1.0), step(abs(den), vec4(1e-30)));
  return 2.0 * max(ab, vec4(0.0)) / den;
}
float vanLeer1(float a, float b) { float ab = a * b; return ab > 0.0 ? 2.0 * ab / (a + b) : 0.0; }
float jumpRatio(float a, float b) { return abs(a - b) / min(a, b); }

void main() {
  ivec2 ij = ivec2(gl_FragCoord.xy);
  int i = ij.x, j = ij.y;
  oF = vec4(0.0); oFY = vec4(0.0);
  vec4 geo = texelFetch(uGeoA, ij, 0);
#if DIR_R
  float area = geo.w;
  if (j == 0 || area == 0.0) return;
  ivec2 d = ivec2(0, 1), t = ivec2(1, 0);
#else
  float area = geo.z;
  if (area == 0.0) return;
  ivec2 d = ivec2(1, 0), t = ivec2(0, 1);
#endif
  bool s0, s1, s2, s3;
  ivec2 k0 = ij - 2 * d, k1 = ij - d, k3 = ij + d;
  Prim c0 = cellP(k0.x, k0.y, s0), c1 = cellP(k1.x, k1.y, s1);
  Prim c2 = cellP(i, j, s2), c3 = cellP(k3.x, k3.y, s3);
  if (s1 && s2) return;
  // HLL blending near strong shocks lying across the face direction (anti-carbuncle)
  float hllw = 0.0;
  if (uHllBlend > 0.0 && !(s1 || s2)) {
    float p1 = c1.w.w, p2 = c2.w.w;
    ivec2 a1 = k1 + t, b1 = k1 - t, a2 = ij + t, b2 = ij - t;
    float jm = max(max(jumpRatio(pAt(a1.x, a1.y, p1), p1), jumpRatio(pAt(b1.x, b1.y, p1), p1)),
                   max(jumpRatio(pAt(a2.x, a2.y, p2), p2), jumpRatio(pAt(b2.x, b2.y, p2), p2)));
    hllw = smoothstep(0.15, 0.6, jm * uHllBlend);
  }
  Prim WL, WR;
  if (s1) { WR = c2; WL = mirrorN(c2); }
  else if (s2) { WL = c1; WR = mirrorN(c1); }
  else {
    if (s0) c0 = mirrorN(c1);
    if (s3) c3 = mirrorN(c2);
    WL = c1; WR = c2;
    if (uLimiter > 0.5 && area > 0.0) {
      vec4 dL = vanLeer(c1.w - c0.w, c2.w - c1.w);
      vec4 dR = vanLeer(c2.w - c1.w, c3.w - c2.w);
      float yL = vanLeer1(c1.y - c0.y, c2.y - c1.y);
      float yR = vanLeer1(c2.y - c1.y, c3.y - c2.y);
      vec4 tL = c1.w + 0.5 * dL, tR = c2.w - 0.5 * dR;
      if (tL.x > 0.0 && tL.w > 0.0 && tR.x > 0.0 && tR.w > 0.0) {
        WL = Prim(tL, clamp(c1.y + 0.5 * yL, 0.0, 1.0));
        WR = Prim(tR, clamp(c2.y - 0.5 * yR, 0.0, 1.0));
      }
    }
  }
  // ---- HLLC Riemann solver (blended to HLL by hllw), face-normal frame
  float g = uGamma;
  float rL = WL.w.x, uL = WL.w.y, vL = WL.w.z, pL = WL.w.w;
  float rR = WR.w.x, uR = WR.w.y, vR = WR.w.z, pR = WR.w.w;
  float cL = sqrt(g * pL / rL), cR = sqrt(g * pR / rR);
  float EL = pL / (g - 1.0) + 0.5 * rL * (uL * uL + vL * vL);
  float ER = pR / (g - 1.0) + 0.5 * rR * (uR * uR + vR * vR);
  float sL = sqrt(rL), sR = sqrt(rR);
  float uT = (sL * uL + sR * uR) / (sL + sR);
  float HT = (sL * (EL + pL) / rL + sR * (ER + pR) / rR) / (sL + sR);
  float vT = (sL * vL + sR * vR) / (sL + sR);
  float cT = sqrt(max((g - 1.0) * (HT - 0.5 * (uT * uT + vT * vT)), 1e-12));
  float SL = min(uL - cL, uT - cT);
  float SR = max(uR + cR, uT + cT);
  vec4 FL = vec4(rL * uL, rL * uL * uL + pL, rL * uL * vL, uL * (EL + pL));
  vec4 FR = vec4(rR * uR, rR * uR * uR + pR, rR * uR * vR, uR * (ER + pR));
  float FYL = rL * uL * WL.y, FYR = rR * uR * WR.y;
  vec4 F; float FY;
  if (SL >= 0.0) { F = FL; FY = FYL; }
  else if (SR <= 0.0) { F = FR; FY = FYR; }
  else {
    vec4 UL = vec4(rL, rL * uL, rL * vL, EL);
    vec4 UR = vec4(rR, rR * uR, rR * vR, ER);
    float inv = 1.0 / (SR - SL);
    vec4 Fhll = (SR * FL - SL * FR + SL * SR * (UR - UL)) * inv;
    float FYhll = (SR * FYL - SL * FYR + SL * SR * (rR * WR.y - rL * WL.y)) * inv;
    float Ss = (pR - pL + rL * uL * (SL - uL) - rR * uR * (SR - uR)) / (rL * (SL - uL) - rR * (SR - uR));
    bool left = Ss >= 0.0;
    float rK = left ? rL : rR, uK = left ? uL : uR, vK = left ? vL : vR, pK = left ? pL : pR;
    float EK = left ? EL : ER, SK = left ? SL : SR, YK = left ? WL.y : WR.y;
    vec4 FK = left ? FL : FR, UK = left ? UL : UR;
    float FYK = left ? FYL : FYR;
    float kk = rK * (SK - uK) / (SK - Ss);
    vec4 Us = kk * vec4(1.0, Ss, vK, EK / rK + (Ss - uK) * (Ss + pK / (rK * (SK - uK))));
    vec4 Fc = FK + SK * (Us - UK);
    float FYc = FYK + SK * (kk * YK - rK * YK);
    F = mix(Fc, Fhll, hllw);
    FY = mix(FYc, FYhll, hllw);
  }
#if DIR_R
  F = vec4(F.x, F.z, F.y, F.w);       // rotate momentum back to (x, r)
#endif
  oF = F; oFY = vec4(FY, 0.0, 0.0, 0.0);
}
`; }
const FS_FLUX_X = makeFluxShader(false);
const FS_FLUX_R = makeFluxShader(true);

// ---------------------------------------------------------------------------
// Update pass: finite-volume update with axisymmetric geometric source.
// ---------------------------------------------------------------------------
const FS_UPDATE = GLSL_COMMON + `
uniform sampler2D uA;     // state at this stage
uniform sampler2D uB;
uniform sampler2D uA0;    // state at t^n (used in stage 2)
uniform sampler2D uB0;
uniform sampler2D uFxA; uniform sampler2D uFxB;
uniform sampler2D uFrA; uniform sampler2D uFrB;
uniform sampler2D uGeoA;  // (V, Am, Ax_west, Ar_south)
uniform sampler2D uGeoG;  // group (V, Am, Wx, Wr)
uniform sampler2D uGeoM;  // (host dx, host dy, slave mask, kappa)
uniform sampler2D uStep;
uniform int uStage;       // 1 or 2
uniform vec4 uAmbCons;    // conserved freestream state written into solid cells
uniform float uVmax;      // velocity clamp (normalised)
layout(location = 0) out vec4 oA;
layout(location = 1) out vec4 oB;

// net flux (r-weighted areas) out of one member cell
void memberFlux(ivec2 c, inout vec4 L, inout float LY) {
  vec4 g = texelFetch(uGeoA, c, 0);
  float aw = abs(g.z), ae = abs(texelFetch(uGeoA, c + ivec2(1, 0), 0).z);
  float as_ = abs(g.w), an = abs(texelFetch(uGeoA, c + ivec2(0, 1), 0).w);
  L  -= ae * texelFetch(uFxA, c + ivec2(1, 0), 0) - aw * texelFetch(uFxA, c, 0);
  L  -= an * texelFetch(uFrA, c + ivec2(0, 1), 0) - as_ * texelFetch(uFrA, c, 0);
  LY -= ae * texelFetch(uFxB, c + ivec2(1, 0), 0).r - aw * texelFetch(uFxB, c, 0).r;
  LY -= an * texelFetch(uFrB, c + ivec2(0, 1), 0).r - as_ * texelFetch(uFrB, c, 0).r;
}
// pressure on a slip wall from the reflected Riemann problem
float wallPressure(Prim q, float un) {
  float g = uGamma, p = q.w.w, rho = q.w.x, c = sqrt(g * p / rho);
  if (un > 0.0) { float a = 0.25 * (g + 1.0) * un; return p + rho * un * (a + sqrt(a * a + c * c)); }
  float f = max(1.0 + 0.5 * (g - 1.0) * un / c, 0.0);
  return p * pow(f, 2.0 * g / (g - 1.0));
}

void main() {
  ivec2 ij = ivec2(gl_FragCoord.xy);
  if (solidAt(ij)) { oA = uAmbCons; oB = vec4(0.0); return; }
  vec4 gm = texelFetch(uGeoM, ij, 0);
  ivec2 H = ij + ivec2(round(gm.xy));
  vec4 gg = texelFetch(uGeoG, ij, 0);
  vec4 A = texelFetch(uA, H, 0);
  float B = texelFetch(uB, H, 0).r;
  Prim q = toPrim(A, B);
  vec4 L = vec4(0.0); float LY = 0.0;
  memberFlux(H, L, LY);
  int sm = int(round(texelFetch(uGeoM, H, 0).z));
  if ((sm & 1) != 0) memberFlux(H + ivec2(-1, 0), L, LY);
  if ((sm & 2) != 0) memberFlux(H + ivec2(1, 0), L, LY);
  if ((sm & 4) != 0) memberFlux(H + ivec2(0, -1), L, LY);
  if ((sm & 8) != 0) memberFlux(H + ivec2(0, 1), L, LY);
  // embedded wall: pressure force along the (r-weighted) wall vector
  vec2 Wv = gg.zw;
  float wl = length(Wv);
  if (wl > 1e-6) {
    vec2 n = Wv / wl;
    float pw = wallPressure(q, dot(q.w.yz, n));
    L.yz -= Wv * pw;
  }
  L.z += q.w.w * gg.y;             // axisymmetric geometric source  p * Am
  float invV = 1.0 / max(gg.x, 1e-6);
  float dt = texelFetch(uStep, ivec2(0), 0).x;
  vec4 U; float UY;
  if (uStage == 1) { U = A + dt * invV * L; UY = B + dt * invV * LY; }
  else {
    vec4 A0 = texelFetch(uA0, H, 0); float B0 = texelFetch(uB0, H, 0).r;
    U = 0.5 * (A0 + A + dt * invV * L); UY = 0.5 * (B0 + B + dt * invV * LY);
  }
  // positivity / robustness fixes
  float rho = max(U.x, RHO_MIN);
  vec2 vel = U.yz / max(U.x, RHO_MIN);
  float sp = length(vel);
  if (sp > uVmax) vel *= uVmax / sp;
  if (!(rho < 1e30) || !(vel.x < 1e30 && vel.x > -1e30)) { oA = uAmbCons; oB = vec4(0.0); return; } // NaN guard
  float ke = 0.5 * rho * dot(vel, vel);
  float E = max(U.w, P_MIN / (uGamma - 1.0) + ke);
  oA = vec4(rho, rho * vel, E);
  oB = vec4(clamp(UY, 0.0, rho), 0.0, 0.0, 0.0);
}
`;

// ---------------------------------------------------------------------------
// Reduction passes for the CFL wave speed and the step info texture.
// ---------------------------------------------------------------------------
const FS_REDUCE1 = GLSL_COMMON + `
uniform sampler2D uA;
out vec4 o;
void main() {
  ivec2 b = ivec2(gl_FragCoord.xy) * 4;
  float w = 0.0;
  for (int dy = 0; dy < 4; dy++) for (int dx = 0; dx < 4; dx++) {
    ivec2 c = b + ivec2(dx, dy);
    if (c.x < uN.x && c.y < uN.y && !solidAt(c)) {
      Prim q = toPrim(texelFetch(uA, c, 0), 0.0);
      w = max(w, abs(q.w.y) + abs(q.w.z) + 2.0 * sqrt(uGamma * q.w.w / q.w.x));
    }
  }
  o = vec4(w, 0.0, 0.0, 0.0);
}
`;
const FS_REDUCE2 = `#version 300 es
precision highp float; precision highp int; precision highp sampler2D;
uniform sampler2D uIn; uniform ivec2 uInSize;
out vec4 o;
void main() {
  ivec2 b = ivec2(gl_FragCoord.xy) * 4;
  float w = 0.0;
  for (int dy = 0; dy < 4; dy++) for (int dx = 0; dx < 4; dx++) {
    ivec2 c = b + ivec2(dx, dy);
    if (c.x < uInSize.x && c.y < uInSize.y) w = max(w, texelFetch(uIn, c, 0).r);
  }
  o = vec4(w, 0.0, 0.0, 0.0);
}
`;
const FS_STEPINFO = `#version 300 es
precision highp float; precision highp int; precision highp sampler2D;
uniform sampler2D uIn;
uniform sampler2D uPrev;
uniform float uCFL; uniform float uDtMax; uniform float uWfloor;
out vec4 o;
void main() {
  float w = max(uWfloor, texelFetch(uIn, ivec2(0), 0).r);
  vec4 prev = texelFetch(uPrev, ivec2(0), 0);
  float dt = min(uCFL / w, uDtMax);
  if (prev.x > 0.0) dt = min(dt, prev.x * 1.2);
  o = vec4(dt, prev.z, prev.z + dt, w);
}
`;

// ---------------------------------------------------------------------------
// Ambient rescale: when altitude / flight speed change, pure-ambient cells
// (exhaust fraction < threshold) are rescaled so the change is felt at once
// instead of waiting for waves to cross the whole domain.
// ---------------------------------------------------------------------------
const FS_RESCALE = GLSL_COMMON + `
uniform sampler2D uA; uniform sampler2D uB;
uniform vec4 uScale;      // (pressure factor, temperature factor, delta u, Y threshold)
uniform vec4 uAmbCons;
layout(location = 0) out vec4 oA;
layout(location = 1) out vec4 oB;
void main() {
  ivec2 ij = ivec2(gl_FragCoord.xy);
  vec4 A = texelFetch(uA, ij, 0); float B = texelFetch(uB, ij, 0).r;
  if (solidAt(ij)) { oA = uAmbCons; oB = vec4(0.0); return; }
  Prim q = toPrim(A, B);
  float w = 1.0 - smoothstep(0.0, uScale.w, q.y);
  float rho = q.w.x * mix(1.0, uScale.x / uScale.y, w);
  float p = q.w.w * mix(1.0, uScale.x, w);
  vec2 vel = q.w.yz + vec2(uScale.z * w, 0.0);
  oA = vec4(rho, rho * vel, p / (uGamma - 1.0) + 0.5 * rho * dot(vel, vel));
  oB = vec4(rho * q.y, 0.0, 0.0, 0.0);
}
`;

// ---------------------------------------------------------------------------
class GPUSolver {
  constructor(gl) {
    this.gl = gl;
    if (!gl.getExtension('EXT_color_buffer_float')) throw new Error('EXT_color_buffer_float not supported');
    this.progFluxX = this._program(VS_QUAD, FS_FLUX_X);
    this.progFluxR = this._program(VS_QUAD, FS_FLUX_R);
    this.progPrim = this._program(VS_QUAD, FS_PRIM);
    this.progUpdate = this._program(VS_QUAD, FS_UPDATE);
    this.progRed1 = this._program(VS_QUAD, FS_REDUCE1);
    this.progRed2 = this._program(VS_QUAD, FS_REDUCE2);
    this.progStep = this._program(VS_QUAD, FS_STEPINFO);
    this.progRescale = this._program(VS_QUAD, FS_RESCALE);
    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    this.Nx = 0; this.Nr = 0;
    this.stepCount = 0;
  }

  _shader(type, src) {
    const gl = this.gl, s = gl.createShader(type);
    gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(s);
      const lines = src.split('\n').map((l, k) => (k + 1) + ': ' + l).join('\n');
      console.error(log + '\n' + lines);
      throw new Error('Shader compile error: ' + log);
    }
    return s;
  }
  _program(vs, fs) {
    const gl = this.gl, p = gl.createProgram();
    gl.attachShader(p, this._shader(gl.VERTEX_SHADER, vs));
    gl.attachShader(p, this._shader(gl.FRAGMENT_SHADER, fs));
    gl.bindAttribLocation(p, 0, 'aPos');
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('Link error: ' + gl.getProgramInfoLog(p));
    const uniforms = {};
    const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let k = 0; k < n; k++) {
      const info = gl.getActiveUniform(p, k);
      uniforms[info.name] = gl.getUniformLocation(p, info.name);
    }
    return { p, u: uniforms };
  }
  _tex(w, h, internal, format, type, data = null) {
    const gl = this.gl, t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, format, type, data);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }
  _fbo(texs) {
    const gl = this.gl, f = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, f);
    texs.forEach((t, k) => gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + k, gl.TEXTURE_2D, t, 0));
    gl.drawBuffers(texs.map((_, k) => gl.COLOR_ATTACHMENT0 + k));
    const st = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (st !== gl.FRAMEBUFFER_COMPLETE) throw new Error('FBO incomplete: ' + st);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return f;
  }
  _free() {
    const gl = this.gl;
    for (const t of this._texList || []) gl.deleteTexture(t);
    for (const f of this._fboList || []) gl.deleteFramebuffer(f);
    this._texList = []; this._fboList = [];
  }

  resize(Nx, Nr) {
    const gl = this.gl;
    this.cancelAsync();
    this._free();
    this.Nx = Nx; this.Nr = Nr;
    const T = (w, h) => { const t = this._tex(w, h, gl.RGBA32F, gl.RGBA, gl.FLOAT); this._texList.push(t); return t; };
    const F = (ts) => { const f = this._fbo(ts); this._fboList.push(f); return f; };
    this.S = [0, 1, 2].map(() => { const A = T(Nx, Nr), B = T(Nx, Nr); return { A, B, fbo: F([A, B]) }; });
    this.flux = { FxA: T(Nx + 1, Nr + 1), FxB: T(Nx + 1, Nr + 1), FrA: T(Nx + 1, Nr + 1), FrB: T(Nx + 1, Nr + 1) };
    this.flux.fboX = F([this.flux.FxA, this.flux.FxB]);
    this.flux.fboR = F([this.flux.FrA, this.flux.FrB]);
    this.prim = { W: T(Nx + 4, Nr + 4), Wb: T(Nx + 4, Nr + 4) };
    this.prim.fbo = F([this.prim.W, this.prim.Wb]);
    // CFL reduction chain: 4x4 blocks per level down to a single texel
    this.red = [];
    let w = Nx, h = Nr;
    do { w = Math.ceil(w / 4); h = Math.ceil(h / 4); const t = T(w, h); this.red.push({ t, fbo: F([t]), w, h }); } while (w > 1 || h > 1);
    this.stepTex = [T(1, 1), T(1, 1)];
    this.stepFbo = this.stepTex.map(t => F([t]));
    this.stepIdx = 0;
    this.mask = this._tex(Nx, Nr, gl.R8, gl.RED, gl.UNSIGNED_BYTE);
    this._texList.push(this.mask);
    this.geoA = T(Nx + 1, Nr + 1); this.geoG = T(Nx, Nr); this.geoM = T(Nx, Nr);
    this.cur = 0;
    this.readFbo = gl.createFramebuffer(); this._fboList.push(this.readFbo);
  }

  setMask(u8) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.mask);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    const up = new Uint8Array(u8.length);
    for (let k = 0; k < u8.length; k++) up[k] = u8[k] ? 255 : 0;   // R8 is normalised: 255 -> 1.0
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, this.Nx, this.Nr, gl.RED, gl.UNSIGNED_BYTE, up);
    this.maskData = u8;
  }

  setGeometry(geo) {
    const gl = this.gl;
    this.setMask(geo.mask);
    gl.bindTexture(gl.TEXTURE_2D, this.geoA);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, this.Nx + 1, this.Nr + 1, gl.RGBA, gl.FLOAT, geo.geoA);
    gl.bindTexture(gl.TEXTURE_2D, this.geoG);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, this.Nx, this.Nr, gl.RGBA, gl.FLOAT, geo.geoG);
    gl.bindTexture(gl.TEXTURE_2D, this.geoM);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, this.Nx, this.Nr, gl.RGBA, gl.FLOAT, geo.geoM);
  }

  setState(A, B) {
    const gl = this.gl;
    for (const s of this.S) {
      gl.bindTexture(gl.TEXTURE_2D, s.A);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, this.Nx, this.Nr, gl.RGBA, gl.FLOAT, A);
      gl.bindTexture(gl.TEXTURE_2D, s.B);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, this.Nx, this.Nr, gl.RGBA, gl.FLOAT, B);
    }
    const z = new Float32Array(4);
    for (const t of this.stepTex) { gl.bindTexture(gl.TEXTURE_2D, t); gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 1, 1, gl.RGBA, gl.FLOAT, z); }
    this.cur = 0; this.stepIdx = 0; this.stepCount = 0;
  }

  _bindTex(prog, name, tex, unit) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    if (prog.u[name] !== undefined) gl.uniform1i(prog.u[name], unit);
  }
  _draw(fbo, w, h) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.viewport(0, 0, w, h);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
  _common(prog, P) {
    const gl = this.gl;
    gl.useProgram(prog.p);
    if (prog.u.uN) gl.uniform2i(prog.u.uN, this.Nx, this.Nr);
    if (prog.u.uGamma) gl.uniform1f(prog.u.uGamma, P.gamma);
  }

  // P = normalised parameters (see app.js: simParams())
  step(n, P) {
    const gl = this.gl;
    gl.bindVertexArray(this.vao);
    gl.disable(gl.BLEND);
    for (let k = 0; k < n; k++) {
      const S0 = this.S[this.cur], S1 = this.S[(this.cur + 1) % 3], S2 = this.S[(this.cur + 2) % 3];
      // ---- CFL reduction -> step info
      let pr = this.progRed1; this._common(pr, P);
      this._bindTex(pr, 'uA', S0.A, 0); this._bindTex(pr, 'uMask', this.mask, 1);
      this._draw(this.red[0].fbo, this.red[0].w, this.red[0].h);
      pr = this.progRed2; gl.useProgram(pr.p);
      for (let l = 1; l < this.red.length; l++) {
        this._bindTex(pr, 'uIn', this.red[l - 1].t, 0); gl.uniform2i(pr.u.uInSize, this.red[l - 1].w, this.red[l - 1].h);
        this._draw(this.red[l].fbo, this.red[l].w, this.red[l].h);
      }
      pr = this.progStep; gl.useProgram(pr.p);
      this._bindTex(pr, 'uIn', this.red[this.red.length - 1].t, 0);
      this._bindTex(pr, 'uPrev', this.stepTex[this.stepIdx], 1);
      gl.uniform1f(pr.u.uCFL, P.cfl); gl.uniform1f(pr.u.uDtMax, P.dtMax); gl.uniform1f(pr.u.uWfloor, P.wFloor);
      this._draw(this.stepFbo[1 - this.stepIdx], 1, 1);
      this.stepIdx = 1 - this.stepIdx;
      const stepTex = this.stepTex[this.stepIdx];
      // ---- RK stage 1:  S1 = S0 + dt L(S0)
      this._fluxPass(S0, stepTex, 1, P);
      this._updatePass(S0, S0, stepTex, 1, S1, P);
      // ---- RK stage 2:  S2 = 0.5 (S0 + S1 + dt L(S1))
      this._fluxPass(S1, stepTex, 2, P);
      this._updatePass(S1, S0, stepTex, 2, S2, P);
      this.cur = (this.cur + 2) % 3;
      this.stepCount++;
      gl.flush();          // keep GPU command batches small (avoids driver watchdog resets)
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  _fluxPass(S, stepTex, timeSel, P) {
    const gl = this.gl;
    // padded primitive variables + boundary ghost cells
    const pp = this.progPrim;
    this._common(pp, P);
    this._bindTex(pp, 'uA', S.A, 0); this._bindTex(pp, 'uB', S.B, 1); this._bindTex(pp, 'uMask', this.mask, 2);
    this._bindTex(pp, 'uStep', stepTex, 3);
    gl.uniform1i(pp.u.uTimeSel, timeSel);
    gl.uniform4fv(pp.u.uAmb, P.amb);
    gl.uniform3fv(pp.u.uRes, P.res);
    gl.uniform1f(pp.u.uPambStart, P.pStart);
    gl.uniform1f(pp.u.uRamp, P.ramp);
    gl.uniform1f(pp.u.uRcCells, P.RcCells);
    this._draw(this.prim.fbo, this.Nx + 4, this.Nr + 4);
    for (const dirR of [false, true]) {
      const pr = dirR ? this.progFluxR : this.progFluxX;
      this._common(pr, P);
      this._bindTex(pr, 'uW', this.prim.W, 0); this._bindTex(pr, 'uWb', this.prim.Wb, 1);
      this._bindTex(pr, 'uGeoA', this.geoA, 2);
      gl.uniform1f(pr.u.uLimiter, P.order2 ? 1 : 0);
      gl.uniform1f(pr.u.uHllBlend, P.hllBlend);
      if (dirR) this._draw(this.flux.fboR, this.Nx, this.Nr + 1);
      else this._draw(this.flux.fboX, this.Nx + 1, this.Nr);
    }
  }
  _updatePass(S, S0, stepTex, stage, out, P) {
    const gl = this.gl, pr = this.progUpdate;
    this._common(pr, P);
    this._bindTex(pr, 'uA', S.A, 0); this._bindTex(pr, 'uB', S.B, 1);
    this._bindTex(pr, 'uA0', S0.A, 2); this._bindTex(pr, 'uB0', S0.B, 3);
    this._bindTex(pr, 'uFxA', this.flux.FxA, 4); this._bindTex(pr, 'uFxB', this.flux.FxB, 5);
    this._bindTex(pr, 'uFrA', this.flux.FrA, 6); this._bindTex(pr, 'uFrB', this.flux.FrB, 7);
    this._bindTex(pr, 'uStep', stepTex, 8); this._bindTex(pr, 'uMask', this.mask, 9);
    this._bindTex(pr, 'uGeoA', this.geoA, 10); this._bindTex(pr, 'uGeoG', this.geoG, 11); this._bindTex(pr, 'uGeoM', this.geoM, 12);
    gl.uniform1i(pr.u.uStage, stage);
    gl.uniform4fv(pr.u.uAmbCons, P.ambCons);
    gl.uniform1f(pr.u.uVmax, P.vMax);
    this._draw(out.fbo, this.Nx, this.Nr);
  }

  rescaleAmbient(fp, fT, du, P) {
    const gl = this.gl, pr = this.progRescale;
    gl.bindVertexArray(this.vao);
    this._common(pr, P);
    const S0 = this.S[this.cur], S1 = this.S[(this.cur + 1) % 3];
    this._bindTex(pr, 'uA', S0.A, 0); this._bindTex(pr, 'uB', S0.B, 1); this._bindTex(pr, 'uMask', this.mask, 2);
    gl.uniform4f(pr.u.uScale, fp, fT, du, 0.03);
    gl.uniform4fv(pr.u.uAmbCons, P.ambCons);
    this._draw(S1.fbo, this.Nx, this.Nr);
    this.cur = (this.cur + 1) % 3;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  get state() { return this.S[this.cur]; }
  get stepInfoTex() { return this.stepTex[this.stepIdx]; }

  // ---- read-back helpers (synchronous; call sparingly)
  _readRect(tex, x, y, w, h) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.readFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.readBuffer(gl.COLOR_ATTACHMENT0);
    const out = new Float32Array(w * h * 4);
    gl.readPixels(x, y, w, h, gl.RGBA, gl.FLOAT, out);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return out;
  }
  // ---- asynchronous read-back (pixel-pack buffer + fence): never stalls the GPU.
  // reqs: [{ name, tex, x, y, w, h }]. Returns false if a read is still in flight.
  requestAsync(reqs, tag) {
    const gl = this.gl;
    if (this._async) return false;
    let floats = 0;
    const offs = reqs.map(r => { const o = floats; floats += r.w * r.h * 4; return o; });
    const pbo = gl.createBuffer();          // fresh buffer per read keeps the browser's fast read-back path
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pbo);
    gl.bufferData(gl.PIXEL_PACK_BUFFER, floats * 4, gl.STREAM_READ);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.readFbo);
    reqs.forEach((r, k) => {
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, r.tex, 0);
      gl.readBuffer(gl.COLOR_ATTACHMENT0);
      gl.readPixels(r.x, r.y, r.w, r.h, gl.RGBA, gl.FLOAT, offs[k] * 4);
    });
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    const fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    gl.flush();
    this._async = { fence, reqs, offs, floats, tag, pbo };
    return true;
  }
  // Returns { tag, data: { name: Float32Array } } once the GPU has finished, else null.
  pollAsync() {
    const gl = this.gl, a = this._async;
    if (!a) return null;
    const st = gl.getSyncParameter(a.fence, gl.SYNC_STATUS);
    if (st !== gl.SIGNALED) return null;
    gl.deleteSync(a.fence);
    const all = new Float32Array(a.floats);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, a.pbo);
    gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, all);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    gl.deleteBuffer(a.pbo);
    this._async = null;
    const data = {};
    a.reqs.forEach((r, k) => { data[r.name] = all.subarray(a.offs[k], a.offs[k] + r.w * r.h * 4); });
    return { tag: a.tag, data, probe: a.probe };
  }
  cancelAsync() {
    if (!this._async) return;
    try { this.gl.deleteSync(this._async.fence); this.gl.deleteBuffer(this._async.pbo); } catch (e) {}
    this._async = null;
  }

  readStepInfo() { return this._readRect(this.stepInfoTex, 0, 0, 1, 1); }
  readColumn(i) { return { A: this._readRect(this.state.A, i, 0, 1, this.Nr), B: this._readRect(this.state.B, i, 0, 1, this.Nr) }; }
  readCell(i, j) { return { A: this._readRect(this.state.A, i, j, 1, 1), B: this._readRect(this.state.B, i, j, 1, 1) }; }
  readAll() { return { A: this._readRect(this.state.A, 0, 0, this.Nx, this.Nr), B: this._readRect(this.state.B, 0, 0, this.Nx, this.Nr) }; }
}

if (typeof module !== 'undefined') module.exports = { GPUSolver, GLSL_COMMON, VS_QUAD };
