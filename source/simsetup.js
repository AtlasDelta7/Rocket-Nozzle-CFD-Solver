// ============================================================================
// simsetup.js — turns user-facing engine parameters into a grid, wall mask,
// initial condition and the normalised parameter block used by the solver.
// ============================================================================
'use strict';

function buildSimSetup(cfg) {
  // cfg (SI): Dt, De, type, bellPct, coneAngle, CR, chamberLen, Pc, Tc, gamma, Mw,
  //           alt (m), mach, base (bool), bodyRatio, domainL (m), Nx, aspect, startMode, rampMs
  const Nx = cfg.Nx;
  const Nr = Math.max(16, Math.round(Nx * cfg.aspect));
  const contour = buildContour(cfg);
  // Snap the cell size so the throat radius is a whole number of cells: the
  // stepped wall then reproduces the true throat area (and hence mass flow).
  // On a live re-mesh the existing spacing is kept (cfg.dx).
  let dx = cfg.domainL / Nx;
  if (cfg.dx) dx = cfg.dx;
  else { const nt = Math.max(3, Math.round(contour.Rt / dx)); dx = contour.Rt / nt; }
  const atm = atmosphere(cfg.alt);
  const g = cfg.gamma;
  const Re_gas = RU / cfg.Mw;
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

  // ---------------- normalised parameters ----------------
  const tScale = dx / U_REF;                    // seconds per grid time unit
  const P = computeParams(cfg, contour, dx, cfg.Pc, atm.p);
  const pa = P.amb[3], rhoa = P.amb[0];
  const ReN = P.ReN, TcN = P.res[1], PcN = P.res[0];

  // ---------------- initial condition ----------------
  function initialState() {
    const A = new Float32Array(Nx * Nr * 4), B = new Float32Array(Nx * Nr * 4);
    const rho0 = PcN / (ReN * TcN);
    const E0 = PcN / (g - 1);
    for (let j = 0; j < Nr; j++) {
      const r = (j + 0.5) * dx;
      for (let i = 0; i < Nx; i++) {
        const x = (i + 0.5) * dx, k = (j * Nx + i) * 4;
        const inNozzle = x <= contour.xe && r < RinCol[i];
        if (cfg.startMode === 'burst' && inNozzle && x < contour.xt) {
          A[k] = rho0; A[k + 1] = 0; A[k + 2] = 0; A[k + 3] = E0; B[k] = rho0;
        } else if (inNozzle) {
          A[k] = rhoa; A[k + 1] = 0; A[k + 2] = 0; A[k + 3] = pa / (g - 1);
        } else {
          A[k] = P.ambCons[0]; A[k + 1] = P.ambCons[1]; A[k + 2] = 0; A[k + 3] = P.ambCons[3];
        }
      }
    }
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

  return {
    cfg, Nx, Nr, dx, tw, bodyR, xBase, contour, atm, theory, mask, geo, P, initialState,
    iExit, jExit, iChamber, iThroat, tScale,
    resolution: { throatCells: contour.Rt / dx, exitCells: contour.Re / dx },
  };
}

// Normalised solver parameters. 'live' quantities (Pc, Tc, Mw, alt, mach) may
// change every frame; pStartSi is the ambient pressure at ignition.
function computeParams(cfg, contour, dx, PcSi, pStartSi) {
  const g = cfg.gamma;
  const atm = atmosphere(cfg.alt);
  const pa = atm.p / P_REF;
  const rhoa = pa / (atm.T / T_REF);           // R_air normalised = 1
  const ca = Math.sqrt(g * pa / rhoa);
  const uinf = cfg.mach * ca;
  const ReN = (RU / cfg.Mw) / R_REF;
  const TcN = cfg.Tc / T_REF;
  const PcN = PcSi / P_REF;
  const c0 = Math.sqrt(g * ReN * TcN);
  const uLim = Math.sqrt(2 * g / (g - 1) * ReN * TcN);
  const tScale = dx / U_REF;
  return {
    gamma: g,
    amb: [rhoa, uinf, 0, pa],
    ambCons: [rhoa, rhoa * uinf, 0, pa / (g - 1) + 0.5 * rhoa * uinf * uinf],
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
  const { Nr, dx, P } = setup, g = P.gamma;
  let F = 0, mdot = 0, Mw = 0, pw = 0, A = 0;
  for (let j = 0; j < setup.jExit; j++) {
    const k = j * 4;
    const rho = Math.max(col.A[k], 1e-9), u = col.A[k + 1] / rho, v = col.A[k + 2] / rho;
    const p = Math.max((g - 1) * (col.A[k + 3] - 0.5 * rho * (u * u + v * v)), 1e-9);
    const dA = setup.geo ? 2 * Math.PI * Math.abs(setup.geo.Ax[j * setup.geo.W1 + setup.iExit + 1]) * dx * dx : 2 * Math.PI * (j + 0.5) * dx * dx;
    const c = Math.sqrt(g * p / rho);
    const m = rho * u * dA;
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
  const g = setup.P.gamma;
  const rho = Math.max(a[0], 1e-9), u = a[1] / rho, v = a[2] / rho;
  const p = Math.max((g - 1) * (a[3] - 0.5 * rho * (u * u + v * v)), 1e-9);
  const Y = Math.min(Math.max(b[0] / rho, 0), 1);
  const Rmix = Y * setup.P.ReN + (1 - Y) * setup.P.RaN;
  const T = p / (rho * Rmix) * T_REF;
  const c = Math.sqrt(g * p / rho);
  return { rho: rho * RHO_REF, u: u * U_REF, v: v * U_REF, p: p * P_REF, T, Y, M: Math.hypot(u, v) / c };
}

if (typeof module !== 'undefined') module.exports = { buildSimSetup, computeParams, exitPerformance, cellPrimSI };
