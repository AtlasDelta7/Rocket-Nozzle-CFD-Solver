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
  const contour = buildContour(cfg);
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
  const geo = buildCutGeometry({ Nx, Nr, dx, contour, tw, base: cfg.base, xBase, bodyR, mode: cfg.wallModel || 'cut' });
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
        if (cfg.startMode === 'burst' && inNozzle && x < contour.xt) {
          A[k] = rho0; A[k + 1] = 0; A[k + 2] = 0; A[k + 3] = E0; B[k] = rho0; B[k + 1] = rho0; B[k + 2] = Ge;
        } else if (inNozzle) {
          A[k] = rhoa; A[k + 1] = 0; A[k + 2] = 0; A[k + 3] = pa * Ga; B[k + 2] = Ga;
        } else {
          A[k] = P.ambCons[0]; A[k + 1] = P.ambCons[1]; A[k + 2] = 0; A[k + 3] = P.ambCons[3]; B[k + 2] = Ga;
        }
      }
    }
    for (let j = 0; j < Nr; j++) B[j * Nx * 4 + 3] = P.uInlet0;
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
  const iChamber = Math.max(1, Math.floor(0.5 * contour.Lc / dx));
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
    iExit, jExit, iChamber, iThroat, tScale,
    resolution: { throatCells: contour.Rt / dx, exitCells: contour.Re / dx, gridLimited, shortened: !cfg.dx && Nx * dx < 0.98 * cfg.domainL },
  };
}

// 1-D estimate of the inflow speed for the contraction ratio (normalised): the start
// value of the slow average, which then adapts to whatever the throat really passes.
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
  const chem = cfg.afterburn !== false && (cfg.qAb || 0) > 0;
  return {
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
    chemK: [(cfg.qAb || 0) * 1e6 / (U_REF * U_REF), Math.max(cfg.sAir || 1, 0.05), (dx / U_REF) / CHEM_TAU0, pa],
    Tw: Math.min(cfg.Tw || 800, Math.max(cfg.Tc, 1)) / T_REF,
    res: [PcN, TcN, ReN],
    pStart: Math.min(pStartSi / P_REF, PcN),
    ramp: cfg.startMode === 'burst' ? 0 : (cfg.rampMs * 1e-3) / tScale,
    RcCells: contour.Rc / dx,
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
  const Rmix = Y * setup.P.ReN + (1 - Y) * setup.P.RaN;
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
