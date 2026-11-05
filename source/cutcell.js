// ============================================================================
// cutcell.js — embedded-boundary ("cut-cell") geometry for the solver.
//
// For every cell: r-weighted fluid volume V = ∫∫ r dx dr and meridional area
// Am = ∫∫ dx dr. For every face: r-weighted open area (x-faces: ∫ r dr over
// the open part; r-faces: r_face × open length). The wall vector of a cut cell
// follows from the closure (divergence theorem), so uniform pressure stays
// exactly in balance. Slivers with volume fraction < 0.5 are merged into the
// neighbour they share the largest open face with, which keeps the explicit
// time step stable. All lengths in grid units (cell size = 1).
// ============================================================================
'use strict';

function buildCutGeometry(o) {
  // o: { Nx, Nr, dx, contour, tw, base, xBase, bodyR, mode: 'cut' | 'stair' }
  const { Nx, Nr, dx, contour } = o;
  const cut = o.mode !== 'stair';
  const xeC = contour.xe / dx, twC = o.tw / dx, xBaseC = o.xBase / dx, bodyC = o.bodyR / dx;
  // fine table of the inner-wall radius (cells) every 1/SUB cell in x
  const SUB = 8;
  const nTab = Nx * SUB + 1;
  const Rtab = new Float32Array(nTab);
  for (let k = 0; k < nTab; k++) {
    const X = (k / SUB) * dx;
    Rtab[k] = X <= contour.xe ? contour.radiusAt(X) / dx : -1e9;
  }
  const RinAt = (xc) => {
    if (xc > xeC) return -1e9;
    const f = Math.min(Math.max(xc * SUB, 0), nTab - 1);
    const k = Math.min(Math.floor(f), nTab - 2), t = f - k;
    const a = Rtab[k], b = Rtab[k + 1];
    if (a < -1e8 || b < -1e8) return contour.radiusAt(Math.min(xc * dx, contour.xe)) / dx;
    return a + (b - a) * t;
  };
  const fluid = (xc, rc) => {
    if (xc <= xeC) {
      const ri = RinAt(xc);
      if (rc >= ri && rc <= ri + twC) return false;
      if (o.base && xc < xBaseC && rc >= ri && rc < bodyC) return false;
    }
    return true;
  };
  // per column: radius range of the inner wall over [i, i+1]
  const colMin = new Float32Array(Nx), colMax = new Float32Array(Nx);
  for (let i = 0; i < Nx; i++) {
    let mn = 1e9, mx = -1e9;
    for (let a = 0; a <= SUB; a++) { const k = i * SUB + a; const r = Rtab[k]; if (r > -1e8) { mn = Math.min(mn, r); mx = Math.max(mx, r); } }
    colMin[i] = mn; colMax[i] = mx;
  }
  const overlaps = (a0, a1, b0, b1) => a0 < b1 && a1 > b0;
  const maybeCut = (i, j) => {
    if (!cut) return false;
    const x0 = i, x1 = i + 1, r0 = j, r1 = j + 1;
    if (colMax[i] < -1e8) return false;          // column entirely downstream of the nozzle
    const mn = colMin[i], mx = colMax[i];
    if (overlaps(r0, r1, mn - 1e-6, mx + 1e-6)) return true;
    if (overlaps(r0, r1, mn + twC - 1e-6, mx + twC + 1e-6)) return true;
    if (xeC >= x0 && xeC <= x1 && overlaps(r0, r1, mn, mx + twC)) return true;
    if (o.base) {
      if (xBaseC >= x0 && xBaseC <= x1 && overlaps(r0, r1, mn, bodyC)) return true;
      if (x0 < xBaseC && bodyC >= r0 && bodyC <= r1) return true;
    }
    return false;
  };

  const NC = 8, NF = 12;
  const V = new Float32Array(Nx * Nr), Am = new Float32Array(Nx * Nr), isCut = new Uint8Array(Nx * Nr);
  for (let j = 0; j < Nr; j++) for (let i = 0; i < Nx; i++) {
    const k = j * Nx + i;
    if (maybeCut(i, j)) {
      let am = 0, v = 0;
      for (let b = 0; b < NC; b++) {
        const rc = j + (b + 0.5) / NC;
        for (let a = 0; a < NC; a++) if (fluid(i + (a + 0.5) / NC, rc)) { am += 1; v += rc; }
      }
      Am[k] = am / (NC * NC); V[k] = v / (NC * NC);
      isCut[k] = (Am[k] > 0 && Am[k] < 1) ? 1 : 0;
    } else if (fluid(i + 0.5, j + 0.5)) { Am[k] = 1; V[k] = j + 0.5; }
  }
  // faces (index on the (Nx+1) x (Nr+1) lattice)
  const W1 = Nx + 1;
  const Ax = new Float32Array(W1 * (Nr + 1)), Ar = new Float32Array(W1 * (Nr + 1));
  const cutAt = (i, j) => (i >= 0 && i < Nx && j >= 0 && j < Nr) ? isCut[j * Nx + i] : 0;
  for (let j = 0; j < Nr; j++) for (let i = 0; i <= Nx; i++) {         // x-faces at x = i
    let a;
    if (cut && (cutAt(i - 1, j) || cutAt(i, j) || maybeCut(Math.min(i, Nx - 1), j) || (i > 0 && maybeCut(i - 1, j)))) {
      a = 0;
      for (let b = 0; b < NF; b++) { const rc = j + (b + 0.5) / NF; if (fluid(i, rc)) a += rc; }
      a /= NF;
    } else a = fluid(i, j + 0.5) ? j + 0.5 : 0;
    Ax[j * W1 + i] = a;
  }
  for (let j = 0; j <= Nr; j++) for (let i = 0; i < Nx; i++) {         // r-faces at r = j
    let a;
    if (cut && (cutAt(i, j - 1) || cutAt(i, j) || (j < Nr && maybeCut(i, j)) || (j > 0 && maybeCut(i, j - 1)))) {
      let f = 0;
      for (let b = 0; b < NF; b++) if (fluid(i + (b + 0.5) / NF, j)) f++;
      a = j * f / NF;
    } else a = fluid(i + 0.5, j) ? j : 0;
    Ar[j * W1 + i] = a;
  }

  // ---------------- classification ----------------
  const solid = new Uint8Array(Nx * Nr);
  const kap = new Float32Array(Nx * Nr);
  for (let j = 0; j < Nr; j++) for (let i = 0; i < Nx; i++) {
    const k = j * Nx + i;
    kap[k] = V[k] / (j + 0.5);
    if (kap[k] < 0.02) solid[k] = 1;
  }
  const zeroSolidFaces = () => {
    for (let j = 0; j < Nr; j++) for (let i = 0; i < Nx; i++) {
      if (!solid[j * Nx + i]) continue;
      Ax[j * W1 + i] = 0; Ax[j * W1 + i + 1] = 0; Ar[j * W1 + i] = 0; Ar[(j + 1) * W1 + i] = 0;
    }
  };
  zeroSolidFaces();
  // merge slivers into a neighbour with kappa >= 0.5
  const host = new Int32Array(Nx * Nr).fill(-1);   // -1: own host
  const KMERGE = 0.5;
  for (let pass = 0; pass < 2; pass++) {
    for (let j = 0; j < Nr; j++) for (let i = 0; i < Nx; i++) {
      const k = j * Nx + i;
      if (solid[k] || kap[k] >= KMERGE || host[k] >= 0) continue;
      let best = -1, bestA = 0;
      const cand = [
        [i - 1, j, Ax[j * W1 + i] / (j + 0.5)], [i + 1, j, Ax[j * W1 + i + 1] / (j + 0.5)],
        [i, j - 1, j > 0 ? Ar[j * W1 + i] / j : 0], [i, j + 1, Ar[(j + 1) * W1 + i] / (j + 1)],
      ];
      for (const [ii, jj, a] of cand) {
        if (ii < 0 || ii >= Nx || jj < 0 || jj >= Nr) continue;
        const kk = jj * Nx + ii;
        if (solid[kk] || kap[kk] < KMERGE || host[kk] >= 0) continue;
        if (a > bestA + 1e-9) { bestA = a; best = kk; }
      }
      if (best >= 0 && bestA > 0.02) host[k] = best;
      else if (pass === 1) solid[k] = 1;
    }
  }
  zeroSolidFaces();
  // first-order flag for faces next to cut cells: store the area negated
  const ax = (i, j) => Ax[j * W1 + i], ar = (i, j) => Ar[j * W1 + i];
  const geoA = new Float32Array(W1 * (Nr + 1) * 4);
  const partial = (i, j) => (i >= 0 && i < Nx && j >= 0 && j < Nr) && !solid[j * Nx + i] && (kap[j * Nx + i] < 0.98 || host[j * Nx + i] >= 0);
  for (let j = 0; j <= Nr; j++) for (let i = 0; i <= Nx; i++) {
    const q = (j * W1 + i) * 4;
    if (i < Nx && j < Nr) { const k = j * Nx + i; geoA[q] = V[k]; geoA[q + 1] = Am[k]; }
    if (j < Nr) { const a = ax(i, j); geoA[q + 2] = (partial(i - 1, j) || partial(i, j)) ? -a : a; }
    if (i < Nx) { const a = ar(i, j); geoA[q + 3] = (partial(i, j - 1) || partial(i, j)) ? -a : a; }
  }
  // wall vectors (closure) and group sums
  const Wx = new Float32Array(Nx * Nr), Wr = new Float32Array(Nx * Nr);
  for (let j = 0; j < Nr; j++) for (let i = 0; i < Nx; i++) {
    const k = j * Nx + i;
    if (solid[k]) continue;
    Wx[k] = ax(i, j) - ax(i + 1, j);
    Wr[k] = Am[k] - (ar(i, j + 1) - ar(i, j));
    if (Math.abs(Wx[k]) < 1e-6) Wx[k] = 0;
    if (Math.abs(Wr[k]) < 1e-6) Wr[k] = 0;
  }
  const geoG = new Float32Array(Nx * Nr * 4), geoM = new Float32Array(Nx * Nr * 4);
  const gV = new Float32Array(Nx * Nr), gA = new Float32Array(Nx * Nr), gX = new Float32Array(Nx * Nr), gR = new Float32Array(Nx * Nr);
  const slaveMask = new Uint8Array(Nx * Nr);
  for (let k = 0; k < Nx * Nr; k++) if (!solid[k]) { const h = host[k] >= 0 ? host[k] : k; gV[h] += V[k]; gA[h] += Am[k]; gX[h] += Wx[k]; gR[h] += Wr[k]; }
  for (let j = 0; j < Nr; j++) for (let i = 0; i < Nx; i++) {
    const k = j * Nx + i;
    if (solid[k] || host[k] < 0) continue;
    const h = host[k], hi = h % Nx, hj = (h - hi) / Nx;
    const bit = i < hi ? 1 : i > hi ? 2 : j < hj ? 4 : 8;
    slaveMask[h] |= bit;
  }
  let nCut = 0, nMerged = 0;
  for (let j = 0; j < Nr; j++) for (let i = 0; i < Nx; i++) {
    const k = j * Nx + i, q = k * 4;
    if (solid[k]) { geoG[q] = 1; continue; }
    const h = host[k] >= 0 ? host[k] : k, hi = h % Nx, hj = (h - hi) / Nx;
    geoG[q] = gV[h]; geoG[q + 1] = gA[h]; geoG[q + 2] = gX[h]; geoG[q + 3] = gR[h];
    geoM[q] = hi - i; geoM[q + 1] = hj - j; geoM[q + 2] = slaveMask[k]; geoM[q + 3] = kap[k];
    if (kap[k] < 0.98) nCut++;
    if (host[k] >= 0) nMerged++;
  }
  return { mask: solid, geoA, geoG, geoM, Ax, Ar, W1, kappa: kap, nCut, nMerged };
}

if (typeof module !== 'undefined') module.exports = { buildCutGeometry };
