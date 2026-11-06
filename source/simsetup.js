// ============================================================================
// simsetup.js — turns user-facing engine parameters into a grid, wall mask,
// initial condition and the normalised parameter block used by the solver.
// ============================================================================
'use strict';

function buildSimSetup(cfg) {
  // cfg (SI): Dt, De, type, bellPct, coneAngle, CR, chamberLen, Pc, Tc, gamma, Mw,
  //           alt (m), mach, base (bool), bodyRatio, domainL (m), Nx, aspect, startMode, rampMs,
  //           minCells, viscous, afterburn, qAb, sAir, Tw, inletAbsorb
  const Nx = cfg.Nx;
  const Nr = Math.max(16, Math.round(Nx * cfg.aspect));
  const injOn = injectorActive(cfg);
  const contour = chamberHardwareContour(buildContour(cfg), cfg, injOn);
  // the injector-resolved chamber needs fine cells, so the domain closes around the engine
  if (injOn && !cfg.dx) cfg = { ...cfg, domainL: Math.max(1.3 * contour.xe, 1.25 * (contour.Re + Math.max(contour.Rc, contour.Re) * 0.12) / cfg.aspect) };
  // Snap the cell size so the throat radius is a whole number of cells: the
  // stepped wall then reproduces the true throat area (and hence mass flow).
  // Keep at least minCells across the throat radius by shortening the domain,
  // unless the engine would no longer fit (it must stay within 75 % of the length).
  // On a live re-mesh the existing spacing is kept (cfg.dx).
  let dx = cfg.domainL / Nx, nt = 0, gridLimited = false;
  if (cfg.dx) dx = cfg.dx;
  else {
    const minCells = cfg.minCells || 8;
    const want = Math.max(minCells, Math.round(contour.Rt / dx));
    const fit = Math.floor(contour.Rt / (contour.xe / (0.75 * Nx)));
    nt = Math.max(3, Math.min(want, Math.max(fit, Math.min(Math.round(contour.Rt / dx), want))));
    gridLimited = nt < minCells;
    dx = contour.Rt / nt;
  }
  const atm = atmosphere(cfg.alt);
  const g = cfg.gamma, Ge = 1 / (g - 1), Ga = 1 / (GAMMA_AIR - 1);
  const theory = nozzleTheory({ Pc: cfg.Pc, Tc: cfg.Tc, gamma: g, Mw: cfg.Mw, Dt: cfg.Dt, De: cfg.De, pa: atm.p });

  // ---------------- wall mask ----------------
  const tw = Math.max(2.6 * dx, 0.12 * contour.Rt);
  const bodyR = cfg.base ? Math.max(contour.Rc, contour.Re) * (cfg.bodyRatio || 1.5) + tw : 0;
  const xBase = contour.xt;
  const RinCol = new Float32Array(Nx);
  for (let i = 0; i < Nx; i++) {
    const x = (i + 0.5) * dx;
    RinCol[i] = x <= contour.xe ? contour.radiusAt(x) : Infinity;
  }
  const hw = injOn ? chamberSolids(cfg, contour, dx) : [];
  const geo = buildCutGeometry({ Nx, Nr, dx, contour, tw, base: cfg.base, xBase, bodyR, mode: cfg.wallModel || 'cut', solids: hw });
  const mask = geo.mask;
  // Turbulence length scale (cells), stored in geoM.w: the Smagorinsky scale in
  // open flow; inside the engine a mixing length min(kappa d, 0.09 delta), where
  // delta is a flat-plate estimate of the boundary layer thickness.
  const CS = 0.17, KAPPA = 0.41;
  for (let j = 0; j < Nr; j++) for (let i = 0; i < Nx; i++) {
    const x = (i + 0.5) * dx, r = (j + 0.5) * dx;
    let l = CS;
    if (x <= contour.xe && r < RinCol[i]) {
      const s = x > contour.xt ? x - contour.xt : x;
      const delta = 0.025 * s + (x > contour.xt ? 0.05 * contour.Rt : 0);
      l = Math.max(CS, Math.min(KAPPA * (RinCol[i] - r), 0.09 * delta) / dx);
      // flag the boundary-layer band of the diverging section (bit 16 of the slave mask)
      if (x > contour.xt + 0.5 * contour.Rt && RinCol[i] - r < Math.max(2 * dx, delta)) geo.geoM[(j * Nx + i) * 4 + 2] += 16;
    }
    geo.geoM[(j * Nx + i) * 4 + 3] = l;
  }

  // ---------------- normalised parameters ----------------
  const tScale = dx / U_REF;                    // seconds per grid time unit
  const P = computeParams(cfg, contour, dx, cfg.Pc, atm.p);
  const pa = P.amb[3], rhoa = P.amb[0];
  const ReN = P.ReN, TcN = P.res[1], PcN = P.res[0];

  // ---------------- initial condition ----------------
  function initialState() {
    const A = new Float32Array(Nx * Nr * 4), B = new Float32Array(Nx * Nr * 4);
    const rho0 = PcN / (ReN * TcN);
    const E0 = PcN * Ge;
    for (let j = 0; j < Nr; j++) {
      const r = (j + 0.5) * dx;
      for (let i = 0; i < Nx; i++) {
        const x = (i + 0.5) * dx, k = (j * Nx + i) * 4;
        const inNozzle = x <= contour.xe && r < RinCol[i];
        if (injOn && inNozzle && x < contour.xt) {
          // chamber already burning (igniter): hot products at chamber pressure
          A[k] = rho0; A[k + 1] = 0; A[k + 2] = 0; A[k + 3] = E0; B[k] = rho0; B[k + 1] = rho0 * P.injData.Fres; B[k + 2] = Ge;
        } else if (cfg.startMode === 'burst' && inNozzle && x < contour.xt) {
          A[k] = rho0; A[k + 1] = 0; A[k + 2] = 0; A[k + 3] = E0; B[k] = rho0; B[k + 1] = rho0; B[k + 2] = Ge;
        } else if (inNozzle) {
          A[k] = rhoa; A[k + 1] = 0; A[k + 2] = 0; A[k + 3] = pa * Ga; B[k + 2] = Ga;
        } else {
          A[k] = P.ambCons[0]; A[k + 1] = P.ambCons[1]; A[k + 2] = 0; A[k + 3] = P.ambCons[3]; B[k + 2] = Ga;
        }
      }
    }
    if (!injOn) for (let j = 0; j < Nr; j++) B[j * Nx * 4 + 3] = P.uInlet0;
    // merged sliver cells carry their host's state
    for (let k = 0; k < Nx * Nr; k++) {
      const q = k * 4, hx = geo.geoM[q], hy = geo.geoM[q + 1];
      if (mask[k] || (hx === 0 && hy === 0)) continue;
      const h = (k + hy * Nx + hx) * 4;
      for (let c = 0; c < 4; c++) { A[q + c] = A[h + c]; B[q + c] = B[h + c]; }
    }
    return { A, B };
  }

  const iExit = Math.max(1, Math.min(Nx - 1, Math.floor(contour.xe / dx) - 1));
  let jExit = 0;
  while (jExit < Nr && !mask[jExit * Nx + iExit]) jExit++;
  // chamber probe, kept clear of a pintle post on the axis
  let iChamber = Math.max(1, Math.floor(0.5 * contour.Lc / dx));
  for (const s of hw) if (s.r0 <= 0) iChamber = Math.max(iChamber, Math.ceil(s.x1 / dx) + 2);
  const iThroat = Math.floor(contour.xt / dx);
  // near-wall row per column (first full fluid layer under the nozzle wall)
  const jWall = new Float32Array(Nx * 4);
  for (let i = 0; i <= iExit; i++) {
    let j = Math.min(Nr - 1, Math.floor(RinCol[i] / dx));
    while (j > 0 && (mask[j * Nx + i] || geo.kappa[j * Nx + i] < 0.5)) j--;
    jWall[i * 4] = j;
  }
  geo.jWall = jWall;

  return {
    cfg, Nx, Nr, dx, tw, bodyR, xBase, contour, atm, theory, mask, geo, P, initialState,
    solids: hw, injector: injOn ? buildInjectorTable(cfg, contour, dx, P) : null,
    iExit, jExit, iChamber, iThroat, tScale,
    resolution: { throatCells: contour.Rt / dx, exitCells: contour.Re / dx, gridLimited, shortened: !cfg.dx && Nx * dx < 0.98 * cfg.domainL },
  };
}

// 1-D estimate of the inflow speed for the contraction ratio (normalised): the start
// value of the slow average, which then adapts to whatever the throat really passes.
// ---------------------------------------------------------------------------
// Injector-resolved chamber
// ---------------------------------------------------------------------------
function injectorActive(cfg) {
  return !!(cfg.injMode && cfg.prop && PROPELLANTS[cfg.prop] && PROPELLANTS[cfg.prop].spray);
}
// Single global reaction, fuel + s oxidiser -> products. Its heat is set so that burning
// at the design mixture ratio reaches the propellant's chamber temperature exactly.
function injectorThermo(cfg, ReN, Ge) {
  const sp = PROPELLANTS[cfg.prop].spray, f = SPRAY_FLUIDS[sp.fuel], o = SPRAY_FLUIDS[sp.ox];
  const Rn = (Mw) => (RU / Mw) / R_REF;
  const Rf = Rn(f.Mw), Ro = Rn(o.Mw);
  const Leff = (x) => x.L + x.cl * (x.Tb - x.Tinj);
  const eF = Rf * Ge * f.Tb / T_REF - Leff(f) / (U_REF * U_REF);
  const eO = Ro * Ge * o.Tb / T_REF - Leff(o) / (U_REF * U_REF);
  const Yo = sp.OF / (1 + sp.OF), Yf = 1 - Yo;
  const burnt = Math.min(Yf, Yo / sp.s), Fres = Yf - burnt;
  const Rp = (ReN - Fres * Rf) / Math.max(1 - Fres, 1e-3);
  // The gas leaves carrying enthalpy, not just internal energy, so the budget is on enthalpy:
  // energy added inside the chamber must equal cp Tc at the throat's upstream state.
  const qHat = (ReN * (Ge + 1) * cfg.Tc / T_REF - (Yf * eF + Yo * eO)) / burnt;
  return { Rf, Ro, Rp, eF, eO, Fres, qHat, s: sp.s, fuel: f, ox: o, Ge,
    fuelVec: [f.rho, f.Tb, Leff(f), f.sigma], oxVec: [o.rho, o.Tb, Leff(o), o.sigma] };
}
// Acoustic cavity: an annular pocket in the chamber wall next to the injector face.
function chamberHardwareContour(c, cfg, on) {
  if (!on || !(cfg.cavD > 0)) return c;
  const w = (cfg.cavW || 0) / 100 * c.Rc, d = cfg.cavD / 100 * c.Rc, base = c.radiusAt;
  return { ...c, radiusAt: (x) => base(x) + (x < w ? d : 0) };
}
// Pintle post and ring baffles, snapped to whole cells.
function chamberSolids(cfg, c, dx) {
  const out = [], snap = (v) => Math.round(v / dx) * dx;
  if (cfg.injType === 'pintle') out.push({ x0: -dx, x1: snap(0.5 * c.Rc), r0: -dx, r1: snap(0.22 * c.Rc) });
  const n = Math.round(cfg.baffles || 0), h = snap((cfg.baffleH || 0) / 100 * c.Rc), t = Math.max(2 * dx, snap(0.04 * c.Rc));
  for (let k = 1; k <= n && h > 0; k++) {
    const r = snap(k / (n + 1) * c.Rc);
    out.push({ x0: -dx, x1: h, r0: r - t / 2, r1: r + t / 2 });
  }
  // back wall of an acoustic cavity, so the pocket stays sealed from the outside air
  if (cfg.cavD > 0) {
    const w = snap((cfg.cavW || 0) / 100 * c.Rc), d = (cfg.cavD / 100) * c.Rc;
    out.push({ x0: w, x1: w + Math.max(3 * dx, 0.12 * c.Rt), r0: c.Rc, r1: c.Rc + d + Math.max(3 * dx, 0.12 * c.Rt) });
  }
  return out;
}
// Starting drop sizes are primary-atomisation estimates, a small fraction of the orifice size:
// a liquid jet breaks up within a few diameters, far too fast and fine to resolve on this grid.
// Weighted table of spray elements, sampled by every new parcel: three rows of 256 texels,
// (x0, r0, angle, speed) in cells and U_REF; (type, drop size in m, cone half-angle, width in cells);
// (impingement x in cells, 0, 0, 0). Type 0 = fuel, 1 = oxidiser.
function buildInjectorTable(cfg, c, dx, P) {
  const d = P.injData, Pc = cfg.Pc, dp = (cfg.injDP || 20) / 100 * Pc;
  const OF = cfg.OF > 0 ? cfg.OF : PROPELLANTS[cfg.prop].spray.OF;
  const Vf = 0.8 * Math.sqrt(2 * dp / d.fuel.rho) / U_REF, Vo = 0.8 * Math.sqrt(2 * dp / d.ox.rho) / U_REF;
  const Do = (cfg.injD || 1.5) * 1e-3, n = Math.max(1, Math.round(cfg.injRings || 4));
  const mf = 1 / (1 + OF), mo = OF / (1 + OF), film = Math.min((cfg.film || 0) / 100, 0.5);
  const Ri = 0.9 * c.Rc, deg = Math.PI / 180, C = 1 / dx;
  const el = [];
  const add = (type, weight, x, r, angle, speed, drop, cone, width, xi = 0) => el.push({ type, weight, x: x * C, r: r * C, angle, speed, drop, cone, width: width * C, xi: xi * C });
  const x0 = 0.5 * dx;
  const ringR = (k, m) => (k + 0.5) / m * Ri;
  const shareOf = (rs) => { const s = rs.reduce((a, b) => a + b, 0) || 1; return rs.map((r) => r / s); };
  if (cfg.injType === 'coax') {
    const rs = Array.from({ length: n }, (_, k) => ringR(k, n)), w = shareOf(rs), g = 1.2 * Do;
    rs.forEach((r, k) => {
      add(1, mo * w[k], x0, r, 0, Vo, 0.035 * Do, 3 * deg, 0.5 * Do);
      add(0, 0.5 * mf * (1 - film) * w[k], x0, r + g, 0, 3 * Vf, 0.015 * Do, 8 * deg, 0.4 * Do);
      add(0, 0.5 * mf * (1 - film) * w[k], x0, Math.max(r - g, 0.2 * Do), 0, 3 * Vf, 0.015 * Do, 8 * deg, 0.4 * Do);
    });
  } else if (cfg.injType === 'impinge') {
    const th = (cfg.injAngle || 30) * deg, xi = 6 * Do, del = xi * Math.tan(th);
    const rs = Array.from({ length: n }, (_, k) => Math.max(ringR(k, n), del + Do)), w = shareOf(rs);
    rs.forEach((r, k) => {
      add(0, mf * (1 - film) * w[k], x0, r + del, -th, Vf, 0.12 * Do, 1 * deg, 0.5 * Do, xi);
      add(1, mo * w[k], x0, r - del, th, Vo, 0.12 * Do, 1 * deg, 0.5 * Do, xi);
    });
  } else if (cfg.injType === 'pintle') {
    const Rp = 0.22 * c.Rc, Lp = 0.5 * c.Rc, th = Math.atan(Math.sqrt(Math.max(cfg.injTMR || 1, 0.01)));
    const xt = Lp + 1.5 * dx;
    add(1, mo, xt, Rp, th, Vo, 0.04 * Do, 6 * deg, 0.6 * Do);
    add(0, mf * (1 - film), xt, Rp + Do, th, Vf, 0.04 * Do, 6 * deg, 0.6 * Do);
  } else {                                     // showerhead: alternating rings of axial jets
    const m = Math.max(2, n), rs = Array.from({ length: m }, (_, k) => ringR(k, m));
    const f = shareOf(rs.filter((_, k) => k % 2 === 0)), o = shareOf(rs.filter((_, k) => k % 2 === 1));
    let a = 0, b = 0;
    rs.forEach((r, k) => {
      if (k % 2 === 0) add(0, mf * (1 - film) * f[a++], x0, r, 0, Vf, 0.03 * Do, 4 * deg, 0.6 * Do);
      else add(1, mo * o[b++], x0, r, 0, Vo, 0.03 * Do, 4 * deg, 0.6 * Do);
    });
  }
  if (film > 0) add(0, mf * film, x0, 0.97 * c.Rc, 2 * deg, 0.5 * Vf, 80e-6, 1 * deg, 0.015 * c.Rc);
  // fill the table in proportion to mass (largest remainder), so equal-mass parcels give each element its share
  const total = el.reduce((s, e) => s + e.weight, 0), N = 256;
  const slots = el.map((e) => ({ e, q: e.weight / total * N }));
  slots.forEach((s) => { s.n = Math.floor(s.q); });
  let used = slots.reduce((t, s) => t + s.n, 0);
  slots.slice().sort((a, b) => (b.q - b.n) - (a.q - a.n)).forEach((s) => { if (used < N) { s.n++; used++; } });
  const tab = new Float32Array(N * 3 * 4);
  let t = 0;
  for (const s of slots) for (let q = 0; q < s.n; q++, t++) {
    const e = s.e;
    tab.set([e.x, e.r, e.angle, e.speed], t * 4);
    tab.set([e.type, e.drop, e.cone, e.width], (N + t) * 4);
    tab.set([e.xi, 0, 0, 0], (2 * N + t) * 4);
  }
  return { tab, elements: el, OF };
}
// c* quality read from the throat plane: how much oxidiser and fuel vapour, by mass flow, is left unburnt.
function chamberPerformance(setup, col) {
  const { dx, geo, iThroat, P } = setup;
  let m = 0, mO = 0, mF = 0;
  for (let j = 0; j < setup.Nr; j++) {
    if (setup.mask[j * setup.Nx + iThroat]) break;
    const k = j * 4, rho = Math.max(col.A[k], 1e-9), u = col.A[k + 1] / rho;
    const dA = 2 * Math.PI * Math.abs(geo.Ax[j * geo.W1 + iThroat]) * dx * dx;
    m += rho * u * dA; mO += col.B[k + 3] * u * dA; mF += col.B[k + 1] * u * dA;
  }
  const f = RHO_REF * U_REF, target = P.spray ? P.spray.mdot : 1;
  return { mdot: m * f, unburntOx: mO * f / Math.max(target, 1e-9), fuelVapour: mF * f / Math.max(target, 1e-9) };
}
function chamberInflowSpeed(cfg, c0) {
  const M = machFromAreaRatio(Math.max(cfg.CR, 1.05), cfg.gamma, false);
  return M * c0 / Math.sqrt(1 + 0.5 * (cfg.gamma - 1) * M * M);
}
// Normalised solver parameters. 'live' quantities (Pc, Tc, Mw, alt, mach) may
// change every frame; pStartSi is the ambient pressure at ignition.
function computeParams(cfg, contour, dx, PcSi, pStartSi) {
  const g = cfg.gamma, Ge = 1 / (g - 1), Ga = 1 / (GAMMA_AIR - 1);
  const atm = atmosphere(cfg.alt);
  const pa = atm.p / P_REF;
  const rhoa = pa / (atm.T / T_REF);           // R_air normalised = 1
  const ca = Math.sqrt(GAMMA_AIR * pa / rhoa);
  const uinf = cfg.mach * ca;
  const ReN = (RU / cfg.Mw) / R_REF;
  const TcN = cfg.Tc / T_REF;
  const PcN = PcSi / P_REF;
  const c0 = Math.sqrt(g * ReN * TcN);
  const uLim = Math.sqrt(2 * g / (g - 1) * ReN * TcN);
  const tScale = dx / U_REF;
  const injOn = injectorActive(cfg);
  const injData = injOn ? injectorThermo(cfg, ReN, Ge) : null;
  const chem = injOn || (cfg.afterburn !== false && (cfg.qAb || 0) > 0);
  const PcTheory = injOn ? nozzleTheory({ Pc: PcSi, Tc: cfg.Tc, gamma: g, Mw: cfg.Mw, Dt: cfg.Dt, De: cfg.De, pa: atm.p }) : null;
  return {
    inj: injOn,
    injData,
    Rs: injOn ? [injData.Rf, injData.Ro, injData.Rp] : [ReN, ReN, ReN],
    chamberNu: injOn ? [0.01 * chamberInflowSpeed(cfg, c0) * contour.Rc / dx, contour.xt / dx] : [0, 0],
    cap: injOn ? [1.02 * cfg.Tc, 1.25 * cfg.Tc] : [2400, 2800],
    spray: injOn ? {
      mhat: PcTheory.mdot / (2 * Math.PI * RHO_REF * U_REF * dx * dx),
      mdot: PcTheory.mdot,
      tScale: dx / U_REF, dx,
    } : null,
    gamma: g,
    amb: [rhoa, uinf, 0, pa],
    ambCons: [rhoa, rhoa * uinf, 0, pa * Ga + 0.5 * rhoa * uinf * uinf],
    ambB: [0, 0, Ga, 0],
    gamR: [Math.min(Ge, Ga), Math.max(Ge, Ga)],
    // inlet[0]: inverse averaging time of the inflow speed, about three chamber sound round trips
    inlet: [c0 / (6 * contour.xt / dx), cfg.inletAbsorb === undefined ? 1 : cfg.inletAbsorb, Ge, Ga],
    uInlet0: chamberInflowSpeed(cfg, c0),
    visc: cfg.viscous !== false,
    chem,
    gas: [1.0, ReN, T_REF, U_REF / (dx * P_REF)],
    chemK: injOn ? [injData.qHat, injData.s, (dx / U_REF) / CHEM_TAU0, pa]
                 : [(cfg.qAb || 0) * 1e6 / (U_REF * U_REF), Math.max(cfg.sAir || 1, 0.05), (dx / U_REF) / CHEM_TAU0, pa],
    Tw: Math.min(cfg.Tw || 800, Math.max(cfg.Tc, 1)) / T_REF,
    res: [PcN, TcN, ReN],
    pStart: Math.min(pStartSi / P_REF, PcN),
    ramp: cfg.startMode === 'burst' ? 0 : (cfg.rampMs * 1e-3) / tScale,
    RcCells: (contour.Rc + (injOn ? (cfg.cavD || 0) / 100 * contour.Rc : 0)) / dx + 0.5,
    cfl: cfg.cfl || 0.6,
    dtMax: 10.0,
    wFloor: 2.0 * c0 + Math.abs(uinf),
    vMax: 3.0 * (uLim + c0 + Math.abs(uinf) + ca),
    hllBlend: cfg.hllBlend === undefined ? 1.0 : cfg.hllBlend,
    order2: cfg.order2 === undefined ? true : cfg.order2,
    ReN, RaN: 1.0, Ta: atm.T, pa: atm.p, uinf, uLimN: uLim,
  };
}

// Convert a column read-back into exit-plane performance numbers (SI)
function exitPerformance(setup, col) {
  const { Nr, dx, P } = setup;
  let F = 0, mdot = 0, Mw = 0, pw = 0, A = 0;
  for (let j = 0; j < setup.jExit; j++) {
    const k = j * 4;
    const rho = Math.max(col.A[k], 1e-9), u = col.A[k + 1] / rho, v = col.A[k + 2] / rho;
    const G = col.B[k + 2], g = 1 + 1 / G;
    const p = Math.max((col.A[k + 3] - 0.5 * rho * (u * u + v * v)) / G, 1e-9);
    const dA = setup.geo ? 2 * Math.PI * Math.abs(setup.geo.Ax[j * setup.geo.W1 + setup.iExit + 1]) * dx * dx : 2 * Math.PI * (j + 0.5) * dx * dx;
    const c = Math.sqrt(g * p / rho);
    const m = col.B[k] * u * dA;            // exhaust only: air drawn back into a separated bell is not propellant
    F += (rho * u * u + p - P.amb[3]) * dA;
    mdot += m;
    Mw += m * Math.sqrt(u * u + v * v) / c;
    pw += p * dA; A += dA;
  }
  const Fsi = F * P_REF;                          // rho_hat*u_hat^2 has units of P_REF
  const mdotSi = mdot * RHO_REF * U_REF;
  return {
    F: Fsi, mdot: mdotSi, Me: mdot > 1e-12 ? Mw / mdot : 0,
    pe: (A > 0 ? pw / A : 0) * P_REF,
    Isp: mdotSi > 1e-9 ? Fsi / (mdotSi * G0) : 0,
  };
}
function cellPrimSI(setup, a, b) {
  const G = b[2], g = 1 + 1 / G;
  const rho = Math.max(a[0], 1e-9), u = a[1] / rho, v = a[2] / rho;
  const p = Math.max((a[3] - 0.5 * rho * (u * u + v * v)) / G, 1e-9);
  const Y = Math.min(Math.max(b[0] / rho, 0), 1);
  const R = setup.P.Rs, Fv = Math.max(b[1] / rho, 0), Ov = setup.P.inj ? Math.max(b[3] / rho, 0) : 0;
  const Rmix = (1 - Y) * setup.P.RaN + Fv * R[0] + Ov * R[1] + Math.max(Y - Fv - Ov, 0) * R[2];
  const T = p / (rho * Rmix) * T_REF;
  const c = Math.sqrt(g * p / rho);
  return { rho: rho * RHO_REF, u: u * U_REF, v: v * U_REF, p: p * P_REF, T, Y, M: Math.hypot(u, v) / c };
}

// Near-wall read-back -> separation point. Walks upstream from the exit while the
// flow next to the wall runs backwards. Returns null while the bell is attached.
function wallSeparation(setup, row, paSi) {
  const { dx, contour, iThroat, iExit } = setup;
  let i = iExit, gaps = 0, last = -1;
  for (; i > iThroat + 2 && gaps <= 2; i--) {
    const k = i * 4, x = (i + 0.5) * dx;
    const slope = (contour.radiusAt(x + 0.5 * dx) - contour.radiusAt(x - 0.5 * dx)) / dx;
    const ut = (row[k] + slope * row[k + 1]) / Math.hypot(1, slope);
    if (ut < 0 || Math.hypot(row[k], row[k + 1]) < 0.6 * row[k + 3]) { last = i; gaps = 0; } else if (last >= 0 || iExit - i > 2) gaps++;
  }
  if (last < 0 || iExit - last < 3) return null;
  // wall pressure just ahead of the separation shock: the lowest value in the cells upstream
  let pSep = Infinity, kS = last * 4;
  for (let q = last; q >= Math.max(iThroat + 1, last - 30); q--) if (row[q * 4 + 2] < pSep) { pSep = row[q * 4 + 2]; kS = q * 4; }
  const Msep = Math.hypot(row[kS], row[kS + 1]) / Math.max(row[kS + 3], 1e-6);
  if (Msep < 1.05) return null;   // no supersonic flow ahead of it, e.g. before the nozzle has started
  const x = (last + 0.5) * dx, R = contour.radiusAt(x);
  return {
    x, frac: (x - contour.xt) / (contour.xe - contour.xt), eps: (R * R) / (contour.Rt * contour.Rt),
    pRatio: pSep * P_REF / Math.max(paSi, 1e-6),
    Msep,
  };
}
// Where 1-D theory says the Summerfield limit (wall p = 0.4 pa) is reached.
function summerfieldPoint(contour, Pc, g, pa) {
  const nS = 200;
  for (let k = 0; k <= nS; k++) {
    const x = contour.xt + (contour.xe - contour.xt) * k / nS, R = contour.radiusAt(x);
    const M = machFromAreaRatio(Math.max((R * R) / (contour.Rt * contour.Rt), 1.0001), g, true);
    if (Pc * Math.pow(1 + 0.5 * (g - 1) * M * M, -g / (g - 1)) < 0.4 * pa) return k / nS;
  }
  return null;
}

if (typeof module !== 'undefined') module.exports = { buildSimSetup, computeParams, exitPerformance, cellPrimSI };
