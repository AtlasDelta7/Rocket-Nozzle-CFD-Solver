// ============================================================================
// physics.js — atmosphere, 1-D isentropic nozzle theory, nozzle contour,
// propellant + engine presets. All SI units unless stated.
// ============================================================================
'use strict';

const G0 = 9.80665;
const RU = 8314.462618;          // J/(kmol K)
const R_AIR = 287.053;           // J/(kg K)
// Normalisation used by the GPU solver (keeps float32 well-conditioned)
const P_REF = 101325.0;
const T_REF = 288.15;
const R_REF = R_AIR;
const RHO_REF = P_REF / (R_REF * T_REF);   // 1.225 kg/m^3
const U_REF = Math.sqrt(P_REF / RHO_REF);  // ~287.6 m/s

// ---------------------------------------------------------------------------
// US Standard Atmosphere 1976 (geopotential approx, 0–86 km)
// ---------------------------------------------------------------------------
const ISA_LAYERS = [
  // h_base (m), T_base (K), lapse (K/m), p_base (Pa)
  [0, 288.15, -0.0065, 101325.0],
  [11000, 216.65, 0.0, 22632.06],
  [20000, 216.65, 0.001, 5474.889],
  [32000, 228.65, 0.0028, 868.0187],
  [47000, 270.65, 0.0, 110.9063],
  [51000, 270.65, -0.0028, 66.93887],
  [71000, 214.65, -0.002, 3.956420],
  [86000, 186.87, 0.0, 0.3734],
];
function atmosphere(h) {
  h = Math.max(0, Math.min(h, 120000));
  let L = ISA_LAYERS[0];
  for (const layer of ISA_LAYERS) if (h >= layer[0]) L = layer;
  const [hb, Tb, lapse, pb] = L;
  const k = G0 / R_AIR; // 0.034163 K/m
  let T, p;
  if (Math.abs(lapse) < 1e-12) {
    T = Tb;
    p = pb * Math.exp(-k * (h - hb) / Tb);
  } else {
    T = Tb + lapse * (h - hb);
    p = pb * Math.pow(Tb / T, k / lapse);
  }
  return { T, p, rho: p / (R_AIR * T), a: Math.sqrt(1.4 * R_AIR * T) };
}

// ---------------------------------------------------------------------------
// Isentropic relations
// ---------------------------------------------------------------------------
function areaRatioFromMach(M, g) {
  const t = (2 / (g + 1)) * (1 + 0.5 * (g - 1) * M * M);
  return Math.pow(t, (g + 1) / (2 * (g - 1))) / M;
}
function machFromAreaRatio(eps, g, supersonic = true) {
  if (eps <= 1.0) return 1.0;
  let lo = supersonic ? 1.0 : 1e-6, hi = supersonic ? 100.0 : 1.0;
  for (let k = 0; k < 200; k++) {
    const mid = 0.5 * (lo + hi);
    const f = areaRatioFromMach(mid, g) - eps;
    if (supersonic) { if (f > 0) hi = mid; else lo = mid; }
    else { if (f > 0) lo = mid; else hi = mid; }
  }
  return 0.5 * (lo + hi);
}
function machFromPressureRatio(p0_over_p, g) {
  return Math.sqrt(Math.max(0, (Math.pow(p0_over_p, (g - 1) / g) - 1) * 2 / (g - 1)));
}

// Ideal (1-D, isentropic, frozen-gamma) rocket nozzle performance
function nozzleTheory(o) {
  // o: { Pc, Tc, gamma, Mw, Dt, De, pa }
  const g = o.gamma, R = RU / o.Mw;
  const At = Math.PI * 0.25 * o.Dt * o.Dt;
  const Ae = Math.PI * 0.25 * o.De * o.De;
  const eps = Ae / At;
  const Me = machFromAreaRatio(eps, g, true);
  const fT = 1 + 0.5 * (g - 1) * Me * Me;
  const pe = o.Pc * Math.pow(fT, -g / (g - 1));
  const Te = o.Tc / fT;
  const ue = Me * Math.sqrt(g * R * Te);
  const Gam = Math.sqrt(g) * Math.pow(2 / (g + 1), (g + 1) / (2 * (g - 1)));
  const cstar = Math.sqrt(R * o.Tc) / Gam;
  const mdot = o.Pc * At / cstar;
  const F = mdot * ue + (pe - o.pa) * Ae;
  const Fvac = mdot * ue + pe * Ae;
  const Mopt = machFromPressureRatio(o.Pc / Math.max(o.pa, 1e-3), g);
  const epsOpt = o.pa > 1 ? areaRatioFromMach(Math.max(Mopt, 1.0001), g) : Infinity;
  const ratio = pe / Math.max(o.pa, 1e-9);
  let state;
  if (o.pa < 1) state = 'vacuum';
  else if (ratio > 1.08) state = 'under-expanded';
  else if (ratio < 0.92) state = 'over-expanded';
  else state = 'near-ideal';
  const separation = (o.pa > 1) && pe < 0.4 * o.pa; // Summerfield criterion
  const uLim = Math.sqrt(2 * g / (g - 1) * R * o.Tc);
  return {
    At, Ae, eps, Me, pe, Te, ue, cstar, mdot, F, Fvac, Cf: F / (o.Pc * At),
    Isp: F / (mdot * G0), IspVac: Fvac / (mdot * G0), epsOpt, ratio, state, separation,
    c0: Math.sqrt(g * R * o.Tc), uLim, R,
  };
}

// ---------------------------------------------------------------------------
// Nozzle contour (inner wall radius vs axial position). Rao-style thrust-
// optimised parabola (quadratic Bezier) or straight cone.
// ---------------------------------------------------------------------------
function raoAngles(eps, pct) {
  // Fits to the classic Rao charts (80% bell), shifted for other lengths.
  const le = Math.log10(Math.max(eps, 2));
  let thn = 14.5 + 11.0 * le;     // ~21.5° @ ε=4, ~33° @ ε=50
  let the = 16.5 - 5.3 * le;      // ~13° @ ε=4, ~7.5° @ ε=50
  const d = 80 - pct;
  thn += d * 0.30; the += d * 0.22;
  thn = Math.min(Math.max(thn, 12), 48);
  the = Math.min(Math.max(the, 2), thn - 4);
  return { thn: thn * Math.PI / 180, the: the * Math.PI / 180 };
}

function buildContour(o) {
  // o: { Dt, De, type:'bell'|'cone', bellPct, coneAngle (deg), CR, chamberLen (×Rc) }
  const Rt = 0.5 * o.Dt, Re = Math.max(0.5 * o.De, Rt * 1.001);
  const Rc = Rt * Math.sqrt(Math.max(o.CR, 1.5));
  const Lc = Math.max(o.chamberLen * Rc, 1.5 * Rt);
  const thc = 35 * Math.PI / 180;           // converging half-angle
  const Ru = 1.5 * Rt;                      // upstream throat radius of curvature
  const Rf = Math.min(0.6 * Rc, 1.0 * Rt * 1.5); // chamber fillet
  const pts = [];
  const push = (x, r) => { if (!pts.length || x > pts[pts.length - 1][0] + 1e-12) pts.push([x, r]); };
  // chamber cylinder
  push(0, Rc); push(Lc, Rc);
  // fillet (chamber -> cone)
  const nA = 24;
  for (let k = 1; k <= nA; k++) {
    const ph = thc * k / nA;
    push(Lc + Rf * Math.sin(ph), Rc - Rf * (1 - Math.cos(ph)));
  }
  let [x1, r1] = pts[pts.length - 1];
  const r2 = Rt + Ru * (1 - Math.cos(thc));
  if (r1 > r2) {
    const x2 = x1 + (r1 - r2) / Math.tan(thc);
    push(x2, r2); x1 = x2; r1 = r2;
  }
  // upstream throat arc
  const xt = x1 + Ru * Math.sin(thc);
  for (let k = 1; k <= nA; k++) {
    const ph = thc * (1 - k / nA);
    push(xt - Ru * Math.sin(ph), Rt + Ru * (1 - Math.cos(ph)));
  }
  // downstream throat arc
  const Rd = 0.382 * Rt;
  const eps = (Re * Re) / (Rt * Rt);
  let thn, the, xe;
  if (o.type === 'cone') {
    thn = (o.coneAngle || 15) * Math.PI / 180; the = thn;
  } else {
    const a = raoAngles(eps, o.bellPct || 80); thn = a.thn; the = a.the;
  }
  for (let k = 1; k <= nA; k++) {
    const ph = thn * k / nA;
    push(xt + Rd * Math.sin(ph), Rt + Rd * (1 - Math.cos(ph)));
  }
  const [xN, rN] = pts[pts.length - 1];
  if (o.type === 'cone') {
    xe = xN + (Re - rN) / Math.tan(thn);
    const n = 40;
    for (let k = 1; k <= n; k++) push(xN + (xe - xN) * k / n, rN + (Re - rN) * k / n);
  } else {
    const L15 = (Re - Rt) / Math.tan(15 * Math.PI / 180);
    xe = xt + (o.bellPct || 80) / 100 * L15;
    xe = Math.max(xe, xN + (Re - rN) / Math.tan(thn) * 1.02);
    const tn = Math.tan(thn), te = Math.tan(the);
    let qx = (Re - rN + xN * tn - xe * te) / (tn - te);
    qx = Math.min(Math.max(qx, xN + 1e-6), xe - 1e-6);
    let qr = rN + tn * (qx - xN);
    qr = Math.min(Math.max(qr, rN), Re * 1.2);
    const n = 80;
    for (let k = 1; k <= n; k++) {
      const s = k / n, a = (1 - s) * (1 - s), b = 2 * s * (1 - s), c = s * s;
      push(a * xN + b * qx + c * xe, a * rN + b * qr + c * Re);
    }
  }
  xe = pts[pts.length - 1][0];
  // fast lookup: radius at x (linear interpolation, x monotone)
  const xs = pts.map(p => p[0]), rs = pts.map(p => p[1]);
  function radiusAt(x) {
    if (x <= 0) return Rc;
    if (x >= xe) return Re;
    let lo = 0, hi = xs.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (xs[m] <= x) lo = m; else hi = m; }
    const t = (x - xs[lo]) / (xs[hi] - xs[lo]);
    return rs[lo] + t * (rs[hi] - rs[lo]);
  }
  return { pts, Rt, Re, Rc, Lc, xt, xe, eps, radiusAt, thn, the };
}

// ---------------------------------------------------------------------------
// Presets
// ---------------------------------------------------------------------------
const PROPELLANTS = {
  kerolox:  { name: 'LOX / RP-1 (kerolox)',  Tc: 3670, gamma: 1.22, Mw: 22.0 },
  methalox: { name: 'LOX / CH4 (methalox)',  Tc: 3550, gamma: 1.21, Mw: 20.5 },
  hydrolox: { name: 'LOX / LH2 (hydrolox)',  Tc: 3400, gamma: 1.20, Mw: 13.5 },
  hybrid:   { name: 'N2O / HTPB (hybrid)',   Tc: 3150, gamma: 1.23, Mw: 26.0 },
  solid:    { name: 'APCP (solid motor)',    Tc: 3100, gamma: 1.20, Mw: 25.0 },
  hydrazine:{ name: 'Hydrazine monoprop',    Tc: 1150, gamma: 1.28, Mw: 13.0 },
  coldgas:  { name: 'Cold gas (nitrogen)',   Tc: 300,  gamma: 1.40, Mw: 28.0 },
  custom:   { name: 'Custom',                Tc: 3000, gamma: 1.22, Mw: 22.0 },
};

const ENGINE_PRESETS = {
  demo: {
    name: 'Workbench demo — 14 kN kerolox (sea level)',
    prop: 'kerolox', Pc: 196, Dt: 23, De: 119, type: 'bell', bellPct: 80, coneAngle: 15,
    CR: 6, chamberLen: 1.6, alt: 0, mach: 0, base: false, domain: 1.2,
  },
  overexp: {
    name: 'Over-expanded — vacuum bell fired at sea level',
    prop: 'hydrolox', Pc: 120, Dt: 20, De: 160, type: 'bell', bellPct: 80, coneAngle: 15,
    CR: 5, chamberLen: 1.4, alt: 0, mach: 0, base: false, domain: 1.4,
  },
  diamonds: {
    name: 'Shock diamonds — moderate over-expansion',
    prop: 'methalox', Pc: 90, Dt: 30, De: 125, type: 'bell', bellPct: 80, coneAngle: 15,
    CR: 5, chamberLen: 1.5, alt: 0, mach: 0, base: false, domain: 1.2,
  },
  ideal: {
    name: 'Near-ideal expansion (smooth plume)',
    prop: 'kerolox', Pc: 70, Dt: 34, De: 99, type: 'bell', bellPct: 80, coneAngle: 15,
    CR: 5, chamberLen: 1.5, alt: 0, mach: 0, base: false, domain: 1.2,
  },
  underexp: {
    name: 'Under-expanded — high altitude (big Mach disk)',
    prop: 'kerolox', Pc: 80, Dt: 30, De: 70, type: 'bell', bellPct: 80, coneAngle: 15,
    CR: 5, chamberLen: 1.5, alt: 22, mach: 0, base: false, domain: 1.4,
  },
  coldgas: {
    name: 'Cold-gas thruster (N2, conical)',
    prop: 'coldgas', Pc: 20, Dt: 20, De: 30, type: 'cone', bellPct: 80, coneAngle: 15,
    CR: 4, chamberLen: 1.4, alt: 0, mach: 0, base: false, domain: 0.6,
  },
  hybrid: {
    name: 'Amateur hybrid motor (N2O/HTPB, conical)',
    prop: 'hybrid', Pc: 30, Dt: 30, De: 64, type: 'cone', bellPct: 80, coneAngle: 12,
    CR: 4, chamberLen: 2.0, alt: 0, mach: 0, base: false, domain: 1.0,
  },
  upper: {
    name: 'Upper stage at 30 km (huge under-expanded plume)',
    prop: 'hydrolox', Pc: 100, Dt: 16, De: 100, type: 'bell', bellPct: 80, coneAngle: 15,
    CR: 5, chamberLen: 1.5, alt: 30, mach: 0, base: false, domain: 1.4,
  },
  flight: {
    name: 'Supersonic flight — Mach 2 at 12 km with rocket base',
    prop: 'kerolox', Pc: 100, Dt: 26, De: 90, type: 'bell', bellPct: 80, coneAngle: 15,
    CR: 5, chamberLen: 1.5, alt: 12, mach: 2.0, base: true, domain: 1.2,
  },
};

if (typeof module !== 'undefined') {
  module.exports = { atmosphere, nozzleTheory, buildContour, machFromAreaRatio, areaRatioFromMach,
    PROPELLANTS, ENGINE_PRESETS, P_REF, T_REF, R_REF, RHO_REF, U_REF, R_AIR, RU, G0 };
}
