// ============================================================================
// app.js — UI, presets, main loop, HUD, probe, recording, ascent mode.
// ============================================================================
'use strict';
(function () {
const $ = id => document.getElementById(id);
const fmt = (v, d = 0) => (isFinite(v) ? v : 0).toLocaleString('en-GB', { minimumFractionDigits: d, maximumFractionDigits: d });

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------
const S = {
  preset: 'demo', prop: 'kerolox',
  Dt: 23, De: 119, type: 'bell', bellPct: 80, coneAngle: 15, CR: 6, chamberLen: 1.6,
  base: false, bodyRatio: 1.5,
  Pc: 196, throttle: 100, Tc: 3670, Mw: 22, gamma: 1.22, qAb: 6.8, sAir: 1.8,
  viscous: true, afterburn: true, Tw: 800, inletAbsorb: 100, minCells: 8,
  injMode: false, injType: 'shower', injRings: 6, injDP: 20, injD: 1.5, injTMR: 1, injAngle: 30, OF: 2.3, droplets: true,
  film: 0, baffles: 0, baffleH: 30, cavD: 0, cavW: 40,
  alt: 0, mach: 0,
  ascent: false, ascentTop: 35, ascentDur: 40, ascentMachTop: 3.0, ascentMach: true, throttleSweep: false,
  res: 1024, domainL: 1.2, aspect: 0.28, startMode: 'ramp', rampMs: 0.12, cfl: 0.6, order2: true, wallModel: 'cut',
  speed: 20,
  field: 'temp', field2: 'schl', split: false, centerPlot: false, glow: true, glowK: 0.8, cmap: 'plasma', mirror: true, sonic: 0, particles: false, schlGain: 10, flameGain: 1.0,
  recSize: 'window',
};

const RES_OPTIONS = [[384, 'Draft — 384 × 108'], [640, 'Low — 640 × 179'], [1024, 'Medium — 1024 × 287'], [1536, 'High — 1536 × 430'], [2048, 'Ultra — 2048 × 573']];

// kind: live (applied smoothly while running), geo (re-mesh walls, flow continues),
//       reset (restart sim), next (applies on next restart), view (display only)
const CONTROLS = [
  { section: 'Engine geometry', open: true, items: [
    { key: 'Dt', label: 'Throat diameter', min: 4, max: 150, step: 0.5, unit: 'mm', kind: 'geo', d: 1 },
    { key: 'De', label: 'Exit diameter', min: 6, max: 500, step: 1, unit: 'mm', kind: 'geo', d: 0, hint: () => {
      const t = theoryNow(); if (!t) return '';
      const opt = isFinite(t.epsOpt) ? `ideal for this altitude ≈ ${fmt(t.epsOpt, 1)}` : 'vacuum: bigger is always better';
      return `Expansion ratio ε = ${fmt(t.eps, 1)} · ${opt}`; } },
    { key: 'type', label: 'Nozzle shape', type: 'seg', options: [['bell', 'Bell (Rao)'], ['cone', 'Conical']], kind: 'geo' },
    { key: 'bellPct', label: 'Bell length', min: 60, max: 100, step: 1, unit: '% of 15° cone', kind: 'geo', d: 0, show: () => S.type === 'bell' },
    { key: 'coneAngle', label: 'Cone half-angle', min: 6, max: 35, step: 0.5, unit: '°', kind: 'geo', d: 1, show: () => S.type === 'cone' },
    { key: 'CR', label: 'Contraction ratio', min: 1.8, max: 12, step: 0.1, unit: 'Ac/At', kind: 'geo', d: 1 },
    { key: 'chamberLen', label: 'Chamber length', min: 0.6, max: 10, step: 0.1, unit: '× Rc', kind: 'geo', d: 1 },
    { key: 'base', label: 'Rocket body around engine', type: 'toggle', kind: 'geo' },
    { key: 'bodyRatio', label: 'Body diameter', min: 1.05, max: 3, step: 0.05, unit: '× nozzle', kind: 'geo', d: 2, show: () => S.base },
  ] },
  { section: 'Combustion', open: true, items: [
    { key: 'prop', label: 'Propellant', type: 'select', options: Object.entries(PROPELLANTS).map(([k, v]) => [k, v.name]), kind: 'prop' },
    { key: 'Pc', label: 'Chamber pressure', min: 2, max: 350, step: 1, unit: 'bar', kind: 'live', d: 0 },
    { key: 'throttle', label: 'Throttle', min: 10, max: 120, step: 1, unit: '%', kind: 'live', d: 0 },
    { key: 'Tc', label: 'Chamber temperature', min: 200, max: 4200, step: 10, unit: 'K', kind: 'live', d: 0 },
    { key: 'Mw', label: 'Exhaust molar mass', min: 2, max: 44, step: 0.5, unit: 'kg/kmol', kind: 'live', d: 1 },
    { key: 'gamma', label: 'Ratio of specific heats γ', min: 1.1, max: 1.67, step: 0.01, unit: '', kind: 'reset', d: 2, hint: () => 'Exhaust γ; air stays at 1.40 and mixtures fall between. Changing it restarts the run' },
    { key: 'qAb', label: 'Afterburn energy', min: 0, max: 16, step: 0.1, unit: 'MJ/kg', kind: 'live', d: 1, hint: () => 'Heat from burning the exhaust\'s CO and H₂ in air, per kg of exhaust' },
  ] },
  { section: 'Viscous & reacting flow', open: true, items: [
    { key: 'viscous', label: 'Viscosity, turbulence & boundary layers', type: 'toggle', kind: 'live2' },
    { key: 'Tw', label: 'Nozzle wall temperature', min: 300, max: 2000, step: 10, unit: 'K', kind: 'live', d: 0, show: () => S.viscous, hint: () => 'Sets the heat lost to the wall. Regeneratively cooled walls run near 800 K' },
    { key: 'afterburn', label: 'Afterburning in the plume', type: 'toggle', kind: 'live2' },
  ] },
  { section: 'Injector & chamber', open: true, items: [
    { key: 'injMode', label: 'Simulate injectors, sprays and flame', type: 'toggle', kind: 'reset', hint: () => injectorHint() },
    { key: 'injType', label: 'Injector type', type: 'select', kind: 'reset', show: () => S.injMode, options: [['shower', 'Showerhead (alternating rings)'], ['coax', 'Coaxial shear'], ['impinge', 'Impinging doublets'], ['pintle', 'Pintle']] },
    { key: 'injRings', label: 'Rings of elements', min: 1, max: 12, step: 1, unit: '', kind: 'reset', d: 0, show: () => S.injMode && S.injType !== 'pintle' },
    { key: 'OF', label: 'Mixture ratio O/F', min: 0.5, max: 10, step: 0.05, unit: '', kind: 'reset', d: 2, show: () => S.injMode, hint: () => { const sp = PROPELLANTS[S.prop] && PROPELLANTS[S.prop].spray; return sp ? `Design ${fmt(sp.OF, 1)} · stoichiometric ${fmt(sp.s, 1)}` : ''; } },
    { key: 'injDP', label: 'Injector pressure drop', min: 5, max: 50, step: 1, unit: '% Pc', kind: 'reset', d: 0, show: () => S.injMode, hint: () => 'Sets the injection speed. Below about 15 % real engines risk feed-system instability' },
    { key: 'injD', label: 'Orifice size', min: 0.4, max: 5, step: 0.1, unit: 'mm', kind: 'reset', d: 1, show: () => S.injMode, hint: () => 'Sets the starting drop size. Smaller orifices burn closer to the face' },
    { key: 'injAngle', label: 'Impingement half-angle', min: 10, max: 45, step: 1, unit: '°', kind: 'reset', d: 0, show: () => S.injMode && S.injType === 'impinge' },
    { key: 'injTMR', label: 'Total momentum ratio', min: 0.1, max: 4, step: 0.05, unit: '', kind: 'reset', d: 2, show: () => S.injMode && S.injType === 'pintle', hint: () => `Spray cone angle ${fmt(Math.atan(Math.sqrt(S.injTMR)) * 180 / Math.PI, 0)}° from the axis` },
    { key: 'droplets', label: 'Show droplets (fuel amber, oxidiser blue)', type: 'toggle', kind: 'view', show: () => S.injMode },
    { key: 'film', label: 'Film cooling', min: 0, max: 30, step: 1, unit: '% of fuel', kind: 'reset', d: 0, show: () => S.injMode },
    { key: 'baffles', label: 'Ring baffles', min: 0, max: 4, step: 1, unit: '', kind: 'reset', d: 0, show: () => S.injMode },
    { key: 'baffleH', label: 'Baffle height', min: 5, max: 80, step: 1, unit: '% Rc', kind: 'reset', d: 0, show: () => S.injMode && S.baffles > 0 },
    { key: 'cavD', label: 'Acoustic cavity depth', min: 0, max: 40, step: 1, unit: '% Rc', kind: 'reset', d: 0, show: () => S.injMode },
    { key: 'cavW', label: 'Acoustic cavity width', min: 5, max: 100, step: 1, unit: '% Rc', kind: 'reset', d: 0, show: () => S.injMode && S.cavD > 0 },
  ] },
  { section: 'Flight & environment', open: true, items: [
    { key: 'alt', label: 'Altitude', min: 0, max: 45, step: 0.1, unit: 'km', kind: 'live', d: 1, hint: () => { const a = atmosphere(S.alt * 1000); return `Ambient ${fmt(a.p / 1000, a.p < 1000 ? 3 : 1)} kPa · ${fmt(a.T, 0)} K`; } },
    { key: 'mach', label: 'Flight Mach number', min: 0, max: 5, step: 0.05, unit: '', kind: 'live', d: 2 },
    { key: 'ascent', label: 'Ascent mode (sweep altitude)', type: 'toggle', kind: 'mode' },
    { key: 'ascentTop', label: 'Ascent to', min: 5, max: 45, step: 1, unit: 'km', kind: 'view', d: 0, show: () => S.ascent },
    { key: 'ascentDur', label: 'Ascent duration', min: 5, max: 180, step: 1, unit: 's (real time)', kind: 'view', d: 0, show: () => S.ascent },
    { key: 'ascentMach', label: 'Speed up during ascent', type: 'toggle', kind: 'view', show: () => S.ascent },
    { key: 'ascentMachTop', label: 'Final flight Mach', min: 0, max: 5, step: 0.1, unit: '', kind: 'view', d: 1, show: () => S.ascent && S.ascentMach },
    { key: 'throttleSweep', label: 'Throttle sweep (40–100 %)', type: 'toggle', kind: 'mode' },
  ] },
  { section: 'View', open: true, items: [
    { key: 'cmap', label: 'Colour map', type: 'select', options: Object.entries(COLORMAPS).filter(([k]) => k !== 'flame').map(([k, v]) => [k, v.name]), kind: 'view' },
    { key: 'mirror', label: 'Mirror about axis (full plume)', type: 'toggle', kind: 'view' },
    { key: 'split', label: 'Split view (second field below axis)', type: 'toggle', kind: 'view' },
    { key: 'field2', label: 'Lower-half field', type: 'select', options: FIELDS.map(f => [f.id, f.label]), kind: 'view', show: () => S.split },
    { key: 'sonic', label: 'Overlay', type: 'seg', options: [[0, 'None'], [1, 'Sonic line'], [2, 'Mach contours']], kind: 'view' },
    { key: 'particles', label: 'Flow tracer particles', type: 'toggle', kind: 'view' },
    { key: 'centerPlot', label: 'Centreline plot (Mach & pressure on axis)', type: 'toggle', kind: 'view' },
    { key: 'glow', label: 'Glow (bloom)', type: 'toggle', kind: 'view' },
    { key: 'glowK', label: 'Glow strength', min: 0, max: 2.5, step: 0.05, unit: '', kind: 'view', d: 2, show: () => S.glow },
    { key: 'schlGain', label: 'Schlieren sensitivity', min: 1, max: 40, step: 0.5, unit: '', kind: 'view', d: 1, show: () => S.field === 'schl' },
    { key: 'flameGain', label: 'Flame brightness', min: 0.2, max: 3, step: 0.05, unit: '', kind: 'view', d: 2, show: () => S.field === 'flame' },
  ] },
  { section: 'Simulation', open: false, items: [
    { key: 'res', label: 'Grid resolution', type: 'select', options: RES_OPTIONS, kind: 'reset', hint: () => setup ? `Δx = ${fmt(setup.dx * 1000, 2)} mm · throat radius = ${fmt(setup.resolution.throatCells, 1)} cells` + (setup.resolution.throatCells < S.minCells - 0.01 ? '  ⚠ throat under-resolved: raise the grid' : '') : '' },
    { key: 'minCells', label: 'Minimum cells across throat radius', min: 4, max: 24, step: 1, unit: 'cells', kind: 'reset', d: 0, hint: () => 'The domain shortens if needed to keep this. Raise the grid to see more plume' },
    { key: 'domainL', label: 'Domain length', min: 0.1, max: 8, step: 0.05, unit: 'm', kind: 'reset', d: 2, hint: () => {
      if (!setup) return '';
      const L = setup.Nx * setup.dx, f = setup.contour.xe / L, rf = setup.contour.Re / (setup.Nr * setup.dx);
      let h = `Actual ${fmt(L, 2)} m × ${fmt(setup.Nr * setup.dx, 2)} m (snapped to the throat)`;
      if (setup.resolution.shortened) h += '  · shortened to keep the throat resolved';
      if (f > 0.6) h += '  ⚠ engine fills most of the domain: increase length or use Fit';
      else if (rf > 0.45) h += '  ⚠ nozzle exit is close to the top boundary: increase length';
      return h; } },
    { key: '_fit', label: 'Fit domain to engine', type: 'button', action: () => fitDomain() },
    { key: 'wallModel', label: 'Wall model', type: 'seg', options: [['cut', 'Cut-cell (smooth)'], ['stair', 'Stepped']], kind: 'reset', hint: () => 'Cut-cell walls follow the true nozzle contour' },
    { key: 'startMode', label: 'Start-up', type: 'seg', options: [['ramp', 'Ignition ramp'], ['burst', 'Diaphragm burst']], kind: 'next' },
    { key: 'rampMs', label: 'Ignition ramp time', min: 0.01, max: 3, step: 0.01, unit: 'ms', kind: 'next', d: 2, show: () => S.startMode === 'ramp' },
    { key: 'inletAbsorb', label: 'Chamber acoustic damping', min: 0, max: 100, step: 5, unit: '%', kind: 'live2', d: 0, hint: () => '100 % absorbs chamber sound at the injector face so Pc settles at once. 0 % lets the chamber ring' },
    { key: 'cfl', label: 'CFL number', min: 0.2, max: 0.9, step: 0.05, unit: '', kind: 'live2', d: 2 },
    { key: 'order2', label: 'Second-order reconstruction', type: 'toggle', kind: 'live2' },
    { key: '_reset', label: 'Reset all settings to defaults', type: 'button', action: () => { try { localStorage.removeItem(STORE_KEY); } catch (e) {} applyPreset('demo'); } },
  ] },
  { section: 'Theory vs simulation', open: false, custom: 'theory' },
  { section: 'Recording', open: false, items: [
    { key: 'recSize', label: 'Video / screenshot frame', type: 'select', options: [['window', 'Same as window'], ['1080p', '1920 × 1080 landscape'], ['4k', '3840 × 2160 landscape'], ['portrait', '1080 × 1920 portrait (phone)'], ['square', '1080 × 1080 square']], kind: 'view' },
  ], customAfter: 'recnote' },
  { section: 'Help', open: false, custom: 'help' },
];

// ---------------------------------------------------------------------------
// GL setup
// ---------------------------------------------------------------------------
const glCanvas = $('gl'), ovCanvas = $('overlay');
const ov = ovCanvas.getContext('2d');
let gl, solver, renderer, setup = null;
let running = true, stepsTotal = 0, simTime = 0, lastDt = 0.03;
let pStartSi = 101325;
let live = null;               // smoothed live values actually applied
let P = null;                  // current solver params
let perf = null, chamber = null;
let frameNo = 0, lastFrameT = performance.now();
let stepsWindow = 0, stepsPerSec = 0, fps = 0, fpsWindow = 0, statT = performance.now();
let budget = 3;                // adaptive steps/frame cap (starts small, grows while frames stay fast)
let slowFrames = 0, minFrameDt = 0.05;   // learnt display frame interval (s)
const view = { cx: 0, cy: 0, zoom: 1, fitted: false };
const mouse = { x: 0, y: 0, inside: false, down: false, lastX: 0, lastY: 0, moved: false };

function showMsg(html) { const m = $('msg'); m.innerHTML = html; m.style.display = html ? 'block' : 'none'; }

function initGL() {
  gl = glCanvas.getContext('webgl2', { antialias: false, alpha: false, depth: false, stencil: false, preserveDrawingBuffer: false, powerPreference: 'high-performance' });
  if (!gl) { showMsg('<b>WebGL 2 is not available.</b><br>Open this file in an up-to-date Chrome or Edge with hardware acceleration enabled (Settings → System → "Use graphics acceleration when available").'); return false; }
  try {
    solver = new GPUSolver(gl);
    renderer = new Renderer(gl, solver);
  } catch (e) {
    console.error(e);
    showMsg('<b>Could not start the GPU solver.</b><br>' + e.message + '<br><br>Try Chrome/Edge with graphics acceleration on.');
    return false;
  }
  glCanvas.addEventListener('webglcontextlost', ev => {
    ev.preventDefault();            // lets the browser hand the context back
    contextLost = true; lossCount++; frameFences = [];
    showMsg('<b>GPU reset</b> — the graphics driver restarted. Recovering…');
    clearTimeout(restoreTimer);
    restoreTimer = setTimeout(() => { if (contextLost) showMsg('<b>The GPU has not come back.</b><br>The browser may have blocked WebGL after repeated resets. Close <i>every</i> browser window, reopen this file, and pick a lower grid resolution.<br><br>' + gpuAdvice()); }, 8000);
  });
  glCanvas.addEventListener('webglcontextrestored', () => {
    try {
      solver = new GPUSolver(gl); renderer = new Renderer(gl, solver); renderer.setColormap(S.cmap);
    } catch (e) { showMsg('<b>Could not restart the GPU solver.</b><br>' + e.message); return; }
    contextLost = false; clearTimeout(restoreTimer); frameFences = [];
    // come back gently: one resolution step down and a small step budget
    const idx = RES_OPTIONS.findIndex(o => o[0] === S.res);
    let note = '';
    if (idx > 0) { S.res = RES_OPTIONS[idx - 1][0]; syncControl('res'); note = ` Grid dropped to ${RES_OPTIONS[idx - 1][1].split(' —')[0]} to be safe.`; }
    budget = 2; setup = null; perf = null;
    restart(); saveSettings();
    showMsg('<b>Recovered from a GPU reset.</b>' + note + '<br>' + gpuAdvice());
    setTimeout(() => showMsg(''), 7000);
  });
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  window.__gpu = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
  gpuName = shortGpu(window.__gpu);
  return true;
}
let contextLost = false, lossCount = 0, restoreTimer = null, gpuName = '';
function shortGpu(r) {
  r = (r || '').replace(/\(R\)|\(TM\)/g, '');
  const m = /ANGLE \(([^,]*),\s*([^(]+?)(?:\s+Direct3D|\s+\(|,|\))/.exec(r || '');
  let n = m ? m[2] : (r || 'unknown GPU');
  return n.replace(/\(R\)|\(TM\)/g, '').replace(/\s+/g, ' ').trim().slice(0, 48);
}
function isIntegrated() { return /intel|uhd|iris|microsoft basic|swiftshader|llvmpipe/i.test(window.__gpu || ''); }
function gpuAdvice() {
  return isIntegrated()
    ? `Running on <b>${gpuName}</b> (integrated graphics). For much better speed and stability, make the browser use the NVIDIA GPU: Windows Settings → System → Display → Graphics → your browser → <b>High performance</b>, then restart the browser.`
    : `Running on <b>${gpuName}</b>.`;
}

// ---------------------------------------------------------------------------
// Configuration -> setup
// ---------------------------------------------------------------------------
function cfgFromS() {
  return {
    Dt: S.Dt / 1000, De: Math.max(S.De, S.Dt * 1.02) / 1000, type: S.type, bellPct: S.bellPct, coneAngle: S.coneAngle,
    CR: S.CR, chamberLen: S.chamberLen, Pc: S.Pc * 1e5 * S.throttle / 100, Tc: S.Tc, gamma: S.gamma, Mw: S.Mw,
    alt: S.alt * 1000, mach: S.mach, base: S.base, bodyRatio: S.bodyRatio, domainL: S.domainL, Nx: S.res,
    aspect: S.aspect, startMode: S.startMode, rampMs: S.rampMs, cfl: S.cfl, order2: S.order2, wallModel: S.wallModel,
    minCells: S.minCells, viscous: S.viscous, afterburn: S.afterburn, qAb: S.qAb, sAir: S.sAir, Tw: S.Tw, inletAbsorb: S.inletAbsorb / 100,
    prop: S.prop, injMode: S.injMode, injType: S.injType, injRings: S.injRings, injDP: S.injDP, injD: S.injD, injTMR: S.injTMR, injAngle: S.injAngle, OF: S.OF,
    film: S.film, baffles: S.baffles, baffleH: S.baffleH, cavD: S.cavD, cavW: S.cavW,
  };
}
function injectorHint() {
  if (S.injMode && !(PROPELLANTS[S.prop] && PROPELLANTS[S.prop].spray)) return 'Choose kerolox, methalox or hydrolox: this mode needs liquid-oxygen propellants';
  if (!S.injMode) return 'Replaces the hot-gas source with liquid sprays, mixing and a flame. The grid closes in around the engine';
  const c = setup && setup.contour; if (!c) return '';
  const Vc = Math.PI * c.Rc * c.Rc * c.Lc, At = Math.PI * c.Rt * c.Rt;
  return `L* ≈ ${fmt((Vc + 0.5 * Math.PI * (c.Rc * c.Rc + c.Rt * c.Rt) * (c.xt - c.Lc)) / At, 2)} m`;
}
function liveTargets() {
  return { Pc: S.Pc * 1e5 * S.throttle / 100, Tc: S.Tc, Mw: S.Mw, alt: S.alt * 1000, mach: S.mach };
}
let theoryCache = null;
function theoryNow() {
  const t = liveTargets();
  theoryCache = nozzleTheory({ Pc: t.Pc, Tc: t.Tc, gamma: S.gamma, Mw: t.Mw, Dt: S.Dt / 1000, De: Math.max(S.De, S.Dt * 1.02) / 1000, pa: atmosphere(t.alt).p });
  return theoryCache;
}

function restart() {
  if (!solver) return;
  const cfg = cfgFromS();
  const newSetup = buildSimSetup(cfg);
  const gridChanged = !setup || setup.Nx !== newSetup.Nx || setup.Nr !== newSetup.Nr;
  setup = newSetup;
  try {
    if (gridChanged) { solver.resize(setup.Nx, setup.Nr); renderer.resize(setup.Nx, setup.Nr); }
  } catch (e) { showMsg('<b>Grid too large for this GPU.</b><br>' + e.message); return; }
  solver.setGeometry(setup.geo);
  if (!solver.spray) { solver.spray = new GPUSpray(solver); solver.spray.resize(); }
  if (setup.injector && !solver.spray.blendOk) showMsg('<b>This GPU cannot blend floating-point textures,</b> which the spray model needs. Switch off injector mode.');
  solver.spray.setInjector(setup.injector);
  const init = setup.initialState();
  solver.setState(init.A, init.B);
  renderer.resetParticles();
  pStartSi = setup.atm.p;
  live = liveTargets();
  P = setup.P;
  stepsTotal = 0; simTime = 0; perf = null; chamber = null; lastReadT = -1; axisData = null; sep = null; sepHold = 0; readGen++; probeData = null; budget = Math.max(2, Math.min(budget, 6));
  chamberPerf = null; wallGasT = 0;
  if (gridChanged || !view.fitted) fitView();
  refreshHints();
}
let geoTimer = null;
function remesh() {
  clearTimeout(geoTimer);
  geoTimer = setTimeout(() => {
    if (!setup) return;
    const cfg = cfgFromS();
    cfg.dx = setup.dx;                 // keep the grid so the flow can carry on
    const ns = buildSimSetup(cfg);
    if (ns.Nx !== setup.Nx || ns.Nr !== setup.Nr) { restart(); return; }
    setup = ns;
    solver.setGeometry(setup.geo);
    if (solver.spray) solver.spray.setInjector(setup.injector);
    refreshHints();
    // a smaller throat can drop below the minimum: re-grid once dragging has stopped
    clearTimeout(resetTimer);
    if (ns.resolution.throatCells < S.minCells - 0.01) resetTimer = setTimeout(restart, 800);
  }, 40);
}
let resetTimer = null;
function restartSoon() { clearTimeout(resetTimer); resetTimer = setTimeout(restart, 150); }

function fitDomain() {
  const c = buildContour(cfgFromS());
  const t = theoryNow();
  // plume length scales with exit diameter and how under-expanded it is
  const plume = 2 * c.Re * Math.max(6, Math.min(16, 6 + 2.5 * Math.log10(Math.max(t.ratio, 1)) * 3));
  S.domainL = Math.round(Math.min(8, Math.max(0.1, (c.xe + plume) * 1.05)) * 20) / 20;
  syncControl('domainL');
  restart();
}

// Apply smoothed live parameters; rescale ambient region when altitude / speed change
function applyLive(dtWall) {
  if (!setup) return;
  const tg = liveTargets();
  const k = 1 - Math.exp(-dtWall * 5);
  const prev = { ...live };
  for (const key of Object.keys(tg)) {
    live[key] += (tg[key] - live[key]) * k;
    if (Math.abs(tg[key] - live[key]) < 1e-6 * Math.max(1, Math.abs(tg[key]))) live[key] = tg[key];
  }
  const cfg = cfgFromS();
  cfg.alt = live.alt; cfg.mach = live.mach; cfg.Tc = live.Tc; cfg.Mw = live.Mw;
  const newP = computeParams(cfg, setup.contour, setup.dx, live.Pc, pStartSi);
  if (P && (prev.alt !== live.alt || prev.mach !== live.mach)) {
    const fp = newP.amb[3] / P.amb[3];
    const fT = (newP.Ta) / (P.Ta);
    const du = newP.amb[1] - P.amb[1];
    if (Math.abs(fp - 1) > 1e-7 || Math.abs(fT - 1) > 1e-7 || Math.abs(du) > 1e-7) solver.rescaleAmbient(fp, fT, du, newP);
  }
  P = newP;
}

// ---------------------------------------------------------------------------
// View transform
// ---------------------------------------------------------------------------
function resizeCanvas() {
  const r = $('viewport').getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const W = Math.max(64, Math.round(r.width * dpr)), H = Math.max(64, Math.round(r.height * dpr));
  if (glCanvas.width !== W || glCanvas.height !== H) {
    glCanvas.width = ovCanvas.width = W; glCanvas.height = ovCanvas.height = H;
    if (view.fitted) fitView();
  }
}
function fitView() {
  if (!setup) return;
  const W = glCanvas.width, H = glCanvas.height;
  const y0 = S.mirror ? -setup.Nr : 0, y1 = setup.Nr;
  view.zoom = Math.min(W / setup.Nx, H / ((y1 - y0) * 0.82));
  view.cx = setup.Nx / 2;
  view.cy = S.mirror ? 0 : Math.min(setup.Nr / 2, H / view.zoom / 2);
  view.fitted = true;
  clampView();
}
function clampView() {
  if (!setup) return;
  const W = glCanvas.width, H = glCanvas.height;
  const hw = W / view.zoom / 2, hh = H / view.zoom / 2;
  view.cx = Math.min(Math.max(view.cx, Math.min(hw, setup.Nx / 2)), Math.max(setup.Nx - hw, setup.Nx / 2));
  const yMin = S.mirror ? -setup.Nr : 0;
  view.cy = Math.min(Math.max(view.cy, Math.min(yMin + hh, (yMin + setup.Nr) / 2)), Math.max(setup.Nr - hh, (yMin + setup.Nr) / 2));
}
function viewVec() {
  const W = glCanvas.width, H = glCanvas.height;
  return [view.cx - W / view.zoom / 2, view.cy - H / view.zoom / 2, W / view.zoom, H / view.zoom];
}
function screenToCell(px, py) {
  const v = viewVec(), W = glCanvas.width, H = glCanvas.height;
  return [v[0] + px / W * v[2], v[1] + (1 - py / H) * v[3]];
}
function cellToScreen(x, y, v) {
  const W = glCanvas.width, H = glCanvas.height;
  return [(x - v[0]) / v[2] * W, H - (y - v[1]) / v[3] * H];
}

// ---------------------------------------------------------------------------
// Display parameters
// ---------------------------------------------------------------------------
function fieldIndex() { return FIELDS.findIndex(f => f.id === S.field); }
function displayRange(field = S.field) {
  const t = theoryCache || theoryNow();
  const Ta = atmosphere(live ? live.alt : S.alt * 1000).T;
  const Tc = live ? live.Tc : S.Tc;
  const pa = atmosphere(live ? live.alt : S.alt * 1000).p;
  const Pc = live ? live.Pc : S.Pc * 1e5;
  switch (field) {
    case 'temp': return { r: [Math.min(0.75 * t.Te, 0.9 * Ta), 1.04 * Math.max(Tc, Ta, P && P.chem ? 2700 : 0)], unit: 'K', d: 0 };
    case 'mach': return { r: [0, Math.max(1.5, t.Me * 1.3 + S.mach)], unit: '', d: 1 };
    case 'pres': { const lo = Math.log10(Math.max(Math.min(t.pe, pa) * 0.08, 1)); return { r: [lo, Math.log10(Pc * 1.05)], unit: 'Pa', log: true, d: 0 }; }
    case 'dens': { const R = RU / S.Mw; const rc = Pc / (R * Tc); const re = t.pe / (R * t.Te); const ra = pa / (R_AIR * Ta);
      return { r: [Math.log10(Math.min(re, ra) * 0.08), Math.log10(rc * 1.05)], unit: 'kg/m³', log: true, d: 3 }; }
    case 'vel': return { r: [0, Math.max(t.uLim * 0.95, 1) + S.mach * 340], unit: 'm/s', d: 0 };
    case 'vort': return { r: [0, t.uLim / Math.max(t.At ** 0.5, 1e-3) * 0.6], unit: '1/s', d: 0, logish: true };
    case 'exh': return { r: [0, 1], unit: '', d: 2 };
    case 'turb': return { r: [0, 4], unit: '', d: 0 };
    case 'burn': return { r: [0, 1], unit: '', d: 2 };
    case 'fuel': case 'ox': return { r: [0, 0.6], unit: '', d: 2 };
    case 'heat': return { r: [0.5, 4.5], unit: '', d: 0 };
    default: return { r: [0, 1], unit: '', d: 1 };
  }
}
function V() {
  const dr = displayRange();
  const split = S.split && S.mirror;
  return {
    fieldIndex: fieldIndex(), range: dr.r, ReN: P.ReN, RaN: P.RaN, Rs: P.Rs, chemK: P.chemK,
    droplets: !!(P.inj && S.droplets), dropScale: 25000, dpr: window.devicePixelRatio || 1,
    split, fieldIndex2: FIELDS.findIndex(f => f.id === S.field2), range2: displayRange(S.field2).r,
    Tc: live.Tc, Ta: P.Ta, schlGain: S.schlGain, dx: setup.dx,
    view: viewVec(), mirror: S.mirror, sonic: +S.sonic, bg: (S.field === 'flame' || (S.split && S.field2 === 'flame')) ? [0.012, 0.016, 0.035] : [0.02, 0.025, 0.05],
    flameGain: S.flameGain, particles: S.particles, particleSize: Math.max(1.2, Math.min(2.4, view.zoom * 0.7)) * (window.devicePixelRatio > 1 ? 1.4 : 1),
    particleAge: 220, spdRef: P.uLimN,
    glow: S.glow && S.glowK > 0, glowK: S.glowK * (S.field === 'flame' ? 0.75 : 0.55), glowThr: S.field === 'flame' ? 0.5 : 0.55,
  };
}

// ---------------------------------------------------------------------------
// Overlay: nozzle, axis, colour bar, scale bar, probe
// ---------------------------------------------------------------------------
const cbarCache = {};
function colorbarImage(field) {
  const id = field === 'flame' ? 'flame' : S.cmap;
  if (cbarCache[id]) return cbarCache[id];
  const c = document.createElement('canvas'); c.width = 256; c.height = 1;
  const x = c.getContext('2d'); const im = x.createImageData(256, 1);
  im.data.set(lutData(COLORMAPS[id] || COLORMAPS.plasma));
  x.putImageData(im, 0, 0);
  cbarCache[id] = c;
  return c;
}
function drawColorbar(field, bx, by, bw, dpr, tag) {
  const dr = displayRange(field), bh = 7 * dpr;
  ov.fillStyle = 'rgba(5,7,12,0.55)'; ov.fillRect(bx - 8 * dpr, by - 20 * dpr, bw + 16 * dpr, bh + 36 * dpr);
  ov.imageSmoothingEnabled = true;
  ov.drawImage(colorbarImage(field), bx, by, bw, bh);
  ov.font = `${10 * dpr}px ${getComputedStyle(document.body).getPropertyValue('--mono')}`;
  ov.fillStyle = 'rgba(200,210,230,0.75)'; ov.textBaseline = 'bottom';
  const lab = (val) => {
    if (dr.log) { const p = Math.pow(10, val); return p >= 1e5 ? fmt(p / 1e5, 2) + ' bar' : p >= 1000 ? fmt(p / 1000, 1) + ' k' : fmt(p, p < 1 ? 3 : 0); }
    return fmt(val, dr.d);
  };
  let lo, hi, name = (tag ? tag + ' ' : '') + FIELDS.find(f => f.id === field).label.toUpperCase();
  if (field === 'schl') { lo = 'uniform'; hi = 'steep ∇ρ'; }
  else if (field === 'flame') { lo = 'cold'; hi = 'hot exhaust'; }
  else if (field === 'exh') { lo = 'ambient air'; hi = 'pure exhaust'; }
  else if (field === 'vort') { lo = '0'; hi = 'strong shear'; }
  else if (field === 'turb') { lo = 'laminar'; hi = '10,000 × laminar'; }
  else if (field === 'burn') { lo = 'unburnt'; hi = 'fully burnt'; }
  else if (field === 'fuel' || field === 'ox') { lo = '0'; hi = '≥ 60 % by mass'; }
  else if (field === 'heat') { lo = 'none'; hi = 'intense'; }
  else { lo = lab(dr.r[0]); hi = lab(dr.r[1]) + (dr.unit && !dr.log ? ' ' + dr.unit : dr.log && field === 'dens' ? ' kg/m³' : ''); }
  ov.textAlign = 'left'; ov.fillText(name, bx, by - 6 * dpr);
  ov.textBaseline = 'top';
  ov.fillText(lo, bx, by + bh + 4 * dpr);
  ov.textAlign = 'right'; ov.fillText(hi, bx + bw, by + bh + 4 * dpr);
}
function drawOverlay() {
  const W = ovCanvas.width, H = ovCanvas.height, dpr = Math.min(window.devicePixelRatio || 1, 2);
  ov.clearRect(0, 0, W, H);
  if (!setup) return;
  const v = viewVec(), dx = setup.dx, c = setup.contour, tw = setup.tw;
  const signs = S.mirror ? [1, -1] : [1];
  // axis
  ov.save();
  ov.setLineDash([4 * dpr, 6 * dpr]); ov.strokeStyle = 'rgba(160,175,200,0.18)'; ov.lineWidth = dpr;
  let a = cellToScreen(0, 0, v), b = cellToScreen(setup.Nx, 0, v);
  ov.beginPath(); ov.moveTo(a[0], a[1]); ov.lineTo(b[0], b[1]); ov.stroke();
  ov.restore();
  // nozzle walls (+ body)
  for (const s of signs) {
    ov.beginPath();
    let first = true;
    for (const [x, r] of c.pts) { const p = cellToScreen(x / dx, s * r / dx, v); if (first) { ov.moveTo(p[0], p[1]); first = false; } else ov.lineTo(p[0], p[1]); }
    for (let k = c.pts.length - 1; k >= 0; k--) { const [x, r] = c.pts[k]; const p = cellToScreen(x / dx, s * (r + tw) / dx, v); ov.lineTo(p[0], p[1]); }
    ov.closePath();
    ov.fillStyle = '#0b0d13'; ov.fill();
    ov.strokeStyle = 'rgba(170,185,210,0.75)'; ov.lineWidth = 1.2 * dpr; ov.stroke();
    if (S.base) {
      ov.beginPath();
      const xb = setup.xBase;
      let p = cellToScreen(0, s * setup.bodyR / dx, v); ov.moveTo(p[0], p[1]);
      p = cellToScreen(xb / dx, s * setup.bodyR / dx, v); ov.lineTo(p[0], p[1]);
      for (let k = c.pts.length - 1; k >= 0; k--) { const [x, r] = c.pts[k]; if (x > xb) continue; p = cellToScreen(x / dx, s * (r + tw * 0.5) / dx, v); ov.lineTo(p[0], p[1]); }
      p = cellToScreen(0, s * (c.Rc + tw * 0.5) / dx, v); ov.lineTo(p[0], p[1]);
      ov.closePath(); ov.fillStyle = '#0b0d13'; ov.fill(); ov.strokeStyle = 'rgba(170,185,210,0.55)'; ov.stroke();
    }
  }
  // pintle post and baffles
  if (setup.solids && setup.solids.length) {
    ov.strokeStyle = 'rgba(210,220,235,0.9)'; ov.lineWidth = 1 * dpr; ov.fillStyle = 'rgba(40,46,60,0.9)';
    for (const q of setup.solids) for (const s of signs) {
      const a = cellToScreen(Math.max(q.x0, 0) / dx, s * Math.max(q.r0, 0) / dx, v), b = cellToScreen(q.x1 / dx, s * q.r1 / dx, v);
      ov.fillRect(a[0], a[1], b[0] - a[0], b[1] - a[1]); ov.strokeRect(a[0], a[1], b[0] - a[0], b[1] - a[1]);
    }
  }
  // separation point on the nozzle wall
  if (sep) {
    ov.font = `${10 * dpr}px ${getComputedStyle(document.body).getPropertyValue('--mono')}`;
    ov.textAlign = 'center'; ov.textBaseline = 'bottom';
    for (const s of signs) {
      const R = c.radiusAt(sep.x), p = cellToScreen(sep.x / dx, s * (R + tw) / dx, v), d = 7 * dpr * s;
      ov.fillStyle = '#ffb547';
      ov.beginPath(); ov.moveTo(p[0], p[1]); ov.lineTo(p[0] - 5 * dpr, p[1] - d); ov.lineTo(p[0] + 5 * dpr, p[1] - d); ov.closePath(); ov.fill();
      if (s > 0) ov.fillText('SEPARATION', p[0], p[1] - d - 3 * dpr);
    }
  }
  if (S.centerPlot) drawCenterPlot(v, W, H, dpr);
  // colour bar(s)
  const bw = Math.min(240 * dpr, W * 0.26), by = H - 30 * dpr;
  const split = S.split && S.mirror;
  drawColorbar(S.field, 16 * dpr, by, bw, dpr, split ? '▲' : '');
  if (split) drawColorbar(S.field2, 16 * dpr + bw + 30 * dpr, by, bw, dpr, '▼');
  // scale bar
  const mPerPx = (v[2] / W) * dx;
  const target = 140 * dpr * mPerPx;
  const nice = [0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.25, 0.5, 1, 2, 5].find(n => n >= target * 0.6) || 5;
  const sl = nice / mPerPx, sx = W - 20 * dpr - sl, sy = H - 22 * dpr;
  ov.strokeStyle = 'rgba(200,210,230,0.7)'; ov.lineWidth = 1.5 * dpr;
  ov.beginPath(); ov.moveTo(sx, sy - 5 * dpr); ov.lineTo(sx, sy); ov.lineTo(sx + sl, sy); ov.lineTo(sx + sl, sy - 5 * dpr); ov.stroke();
  ov.textAlign = 'center'; ov.textBaseline = 'bottom'; ov.fillStyle = 'rgba(200,210,230,0.75)';
  ov.fillText(nice >= 1 ? nice + ' m' : fmt(nice * 1000, 0) + ' mm', sx + sl / 2, sy - 7 * dpr);
  // ascent / mode banner
  if (S.ascent || S.throttleSweep) {
    ov.textAlign = 'center'; ov.textBaseline = 'top'; ov.fillStyle = 'rgba(92,242,168,0.85)';
    const txt = (S.ascent ? `ASCENT  ·  ALT ${fmt(S.alt, 1)} km  ·  MACH ${fmt(S.mach, 2)}` : '') + (S.throttleSweep ? `${S.ascent ? '  ·  ' : ''}THROTTLE ${fmt(S.throttle, 0)} %` : '');
    ov.fillText(txt, W / 2, 12 * dpr);
  }
  // probe crosshair
  if (mouse.inside && !mouse.down) {
    ov.strokeStyle = 'rgba(255,255,255,0.35)'; ov.lineWidth = dpr;
    const px = mouse.x * dpr, py = mouse.y * dpr;
    ov.beginPath(); ov.moveTo(px - 8 * dpr, py); ov.lineTo(px + 8 * dpr, py); ov.moveTo(px, py - 8 * dpr); ov.lineTo(px, py + 8 * dpr); ov.stroke();
  }
}

// ---------------------------------------------------------------------------
// HUD + readback
// ---------------------------------------------------------------------------
// Read-outs are time-averaged over ~60 µs of simulated time (like a test-stand
// display), which hides chamber acoustic ringing without lagging real changes.
const AVG_TAU = 6e-5;
let lastReadT = -1;
function smoothInto(avg, now, a) { if (!avg) return { ...now }; for (const k in now) avg[k] += (now[k] - avg[k]) * a; return avg; }
function processStepInfo(si) {
  if (isFinite(si[0]) && si[0] > 0) lastDt = si[0];
  const tPrev = simTime;
  simTime = si[2] * setup.tScale;
  return tPrev;
}
function processMeasurements(tPrev, col, chA, chB) {
  const pNow = exitPerformance(setup, col);
  const cNow = cellPrimSI(setup, chA, chB);
  if (simTime < tPrev || lastReadT < 0 || !perf || !chamber) { perf = { ...pNow }; chamber = { ...cNow }; }
  else {
    const a = 1 - Math.exp(-Math.max(0, simTime - tPrev) / AVG_TAU);
    perf = smoothInto(perf, pNow, a); chamber = smoothInto(chamber, cNow, a);
  }
  lastReadT = simTime;
}
// synchronous version (used by single-step and the self-test)
function readback() {
  const tPrev = processStepInfo(solver.readStepInfo());
  const col = solver.readColumn(setup.iExit);
  const ch = solver.readCell(setup.iChamber, 0);
  processMeasurements(tPrev, col, ch.A, ch.B);
}
let axisData = null;
function processAxis(row, rowB) {
  const n = setup.Nx;
  const M = new Float32Array(n), pr = new Float32Array(n), solidRow = setup.mask.subarray(0, n);
  for (let i = 0; i < n; i++) {
    const k = i * 4, rho = Math.max(row[k], 1e-9), u = row[k + 1] / rho, v = row[k + 2] / rho;
    const G = rowB[k + 2], g = 1 + 1 / G;
    const p = Math.max((row[k + 3] - 0.5 * rho * (u * u + v * v)) / G, 1e-9);
    M[i] = Math.hypot(u, v) / Math.sqrt(g * p / rho); pr[i] = p * P_REF;
  }
  axisData = { M, pr, solidRow };
}
function readAxis() { processAxis(solver._readRect(solver.state.A, 0, 0, setup.Nx, 1), solver._readRect(solver.state.B, 0, 0, setup.Nx, 1)); }
// Separation read-out: a short hold stops the marker flickering as the shock foot moves.
let sep = null, sepHold = 0;
let chamberPerf = null, wallGasT = 0;
function processThroat(col) {
  const now = chamberPerformance(setup, col);
  chamberPerf = chamberPerf ? { mdot: chamberPerf.mdot + 0.1 * (now.mdot - chamberPerf.mdot), unburntOx: chamberPerf.unburntOx + 0.1 * (now.unburntOx - chamberPerf.unburntOx), fuelVapour: chamberPerf.fuelVapour + 0.1 * (now.fuelVapour - chamberPerf.fuelVapour) } : now;
}
// mean gas temperature next to the chamber wall, from the near-wall sound speed
function processChamberWall(row) {
  let s = 0, n = 0;
  const g = S.gamma, end = Math.floor(setup.contour.Lc / setup.dx);
  for (let i = 2; i < end; i++) { const c = row[i * 4 + 3]; if (c > 0) { s += c * c / (g * P.ReN) * T_REF; n++; } }
  if (n) wallGasT = wallGasT ? wallGasT + 0.1 * (s / n - wallGasT) : s / n;
}
function processWall(row) {
  const now = wallSeparation(setup, row, atmosphere(live.alt).p);
  if (now) { sep = sep ? { ...now, x: sep.x + (now.x - sep.x) * 0.2, frac: sep.frac + (now.frac - sep.frac) * 0.2 } : now; sepHold = 12; }
  else if (--sepHold <= 0) sep = null;
}

// Non-blocking read-back: one batched request in flight at a time, collected
// when the GPU signals it is done (no pipeline stalls).
let readGen = 0, probeCell = null, probeData = null;
function asyncReadback() {
  const res = solver.pollAsync();
  if (res && res.tag === readGen) {
    const d = res.data;
    const tPrev = processStepInfo(d.step);
    processMeasurements(tPrev, { A: d.colA, B: d.colB }, d.chA, d.chB);
    if (d.axis) processAxis(d.axis, d.axisB);
    if (d.wall && S.viscous) processWall(d.wall); else if (!S.viscous) sep = null;
    if (d.wall && P.inj) processChamberWall(d.wall);
    if (d.thA && P.inj) processThroat({ A: d.thA, B: d.thB });
    if (d.prA) probeData = { cell: res.probe, q: cellPrimSI(setup, d.prA, d.prB) };
  }
  if (!solver._async) {
    const st = solver.state, reqs = [
      { name: 'step', tex: solver.stepInfoTex, x: 0, y: 0, w: 1, h: 1 },
      { name: 'colA', tex: st.A, x: setup.iExit, y: 0, w: 1, h: setup.Nr },
      { name: 'colB', tex: st.B, x: setup.iExit, y: 0, w: 1, h: setup.Nr },
      { name: 'chA', tex: st.A, x: setup.iChamber, y: 0, w: 1, h: 1 },
      { name: 'chB', tex: st.B, x: setup.iChamber, y: 0, w: 1, h: 1 },
      { name: 'wall', tex: solver.drawWallRow(), x: 0, y: 0, w: setup.Nx, h: 1 },
    ];
    if (P.inj) reqs.push({ name: 'thA', tex: st.A, x: setup.iThroat, y: 0, w: 1, h: setup.Nr }, { name: 'thB', tex: st.B, x: setup.iThroat, y: 0, w: 1, h: setup.Nr });
    if (S.centerPlot) reqs.push({ name: 'axis', tex: st.A, x: 0, y: 0, w: setup.Nx, h: 1 }, { name: 'axisB', tex: st.B, x: 0, y: 0, w: setup.Nx, h: 1 });
    const pc = probeCell;
    if (pc) { reqs.push({ name: 'prA', tex: st.A, x: pc.i, y: pc.j, w: 1, h: 1 }, { name: 'prB', tex: st.B, x: pc.i, y: pc.j, w: 1, h: 1 }); }
    if (solver.requestAsync(reqs, readGen) && pc) solver._async.probe = pc;
  }
}
function drawCenterPlot(v, W, H, dpr) {
  if (!axisData) return;
  const ph = Math.round(H * 0.24), py0 = H - ph - 46 * dpr, py1 = py0 + ph;
  ov.fillStyle = 'rgba(4,6,12,0.72)'; ov.fillRect(0, py0 - 18 * dpr, W, ph + 30 * dpr);
  ov.strokeStyle = 'rgba(120,130,150,0.25)'; ov.lineWidth = dpr;
  const t = theoryCache || theoryNow();
  const Mmax = Math.max(1.5, t.Me * 1.35 + S.mach);
  const pa = atmosphere(live.alt).p, lpMin = Math.log10(Math.max(Math.min(t.pe, pa) * 0.05, 1)), lpMax = Math.log10(live.Pc * 1.1);
  const yM = m => py1 - Math.min(m / Mmax, 1.05) * ph;
  const yP = p => py1 - (Math.log10(Math.max(p, 1)) - lpMin) / (lpMax - lpMin) * ph;
  // grid: Mach 1 line and ambient pressure line
  ov.setLineDash([3 * dpr, 4 * dpr]);
  ov.beginPath(); ov.moveTo(0, yM(1)); ov.lineTo(W, yM(1)); ov.stroke();
  ov.strokeStyle = 'rgba(255,181,71,0.25)';
  ov.beginPath(); ov.moveTo(0, yP(pa)); ov.lineTo(W, yP(pa)); ov.stroke();
  ov.setLineDash([]);
  const n = setup.Nx, step = Math.max(1, Math.floor(n / W * 1.5));
  const line = (arr, fy, col) => {
    ov.strokeStyle = col; ov.lineWidth = 1.6 * dpr; ov.beginPath();
    let pen = false;
    for (let i = 0; i < n; i += step) {
      if (axisData.solidRow[i]) { pen = false; continue; }
      const x = cellToScreen(i + 0.5, 0, v)[0];
      if (x < -5 || x > W + 5) { pen = false; continue; }
      const y = fy(arr[i]);
      if (!pen) { ov.moveTo(x, y); pen = true; } else ov.lineTo(x, y);
    }
    ov.stroke();
  };
  line(axisData.pr, yP, 'rgba(255,181,71,0.9)');
  line(axisData.M, yM, 'rgba(63,208,255,0.95)');
  ov.font = `${10 * dpr}px ${getComputedStyle(document.body).getPropertyValue('--mono')}`;
  ov.textBaseline = 'top'; ov.textAlign = 'left';
  ov.fillStyle = 'rgba(63,208,255,0.95)'; ov.fillText(`MACH ON AXIS (0–${fmt(Mmax, 1)})`, 12 * dpr, py0 - 14 * dpr);
  ov.fillStyle = 'rgba(255,181,71,0.9)'; ov.fillText('PRESSURE (log)', 190 * dpr, py0 - 14 * dpr);
  ov.fillStyle = 'rgba(200,210,230,0.5)'; ov.fillText('- - M = 1 / ambient p', 320 * dpr, py0 - 14 * dpr);
}
function fmtForce(F) { return Math.abs(F) >= 1e6 ? [fmt(F / 1e6, 2), 'MN'] : Math.abs(F) >= 1000 ? [fmt(F / 1000, Math.abs(F) >= 1e5 ? 0 : 2), 'kN'] : [fmt(F, 0), 'N']; }
function setMetric(id, v, unit, sub) {
  $('m-' + id).innerHTML = v + (unit ? `<small>${unit}</small>` : '');
  if (sub !== undefined) $('s-' + id).textContent = sub;
}
function updateHUD() {
  const t = theoryNow();
  $('simtime').textContent = `T+ ${fmt(simTime * 1000, 3)} ms`;
  $('fieldname').textContent = (S.split && S.mirror) ? `${FIELDS[fieldIndex()].label} ▲ · ${FIELDS.find(f => f.id === S.field2).label} ▼` : FIELDS[fieldIndex()].label + ' field';
  $('solvestat').textContent = `SOLVE ${fmt(stepsPerSec, 0)} steps/s · ${fmt(fps, 0)} fps${running ? '' : ' · PAUSED'}`;
  $('gridstat').innerHTML = `GRID ${setup.Nx} × ${setup.Nr} · Δx ${fmt(setup.dx * 1000, 2)} mm<br>` +
    (isIntegrated() ? `<span style="color:var(--warn)">GPU ${gpuName} — integrated, see README</span>` : `GPU ${gpuName}`);
  if (perf && chamber) {
    const [fv, fu] = fmtForce(perf.F), [iv, iu] = fmtForce(t.F);
    setMetric('thrust', fv, fu, `ideal ${iv} ${iu}`);
    setMetric('mach', fmt(perf.Me, 2), '', `ideal ${fmt(t.Me, 2)}`);
    setMetric('tc', fmt(chamber.T, 0), 'K', `target ${fmt(live.Tc, 0)} K`);
    setMetric('pc', fmt(chamber.p / 1e6, chamber.p < 1e6 ? 2 : 1), 'MPa', P.inj ? `c* efficiency ${fmt(100 * chamber.p / live.Pc, 0)} % · target ${fmt(live.Pc / 1e5, 0)} bar` : `target ${fmt(live.Pc / 1e6, 2)} MPa · ${fmt(live.Pc / 1e5, 0)} bar`);
    setMetric('isp', fmt(Math.max(perf.Isp, 0), 0), 's', `ideal ${fmt(t.Isp, 0)} s · vac ${fmt(t.IspVac, 0)} s`);
    const ratio = perf.pe / Math.max(atmosphere(live.alt).p, 1e-9);
    const mstate = atmosphere(live.alt).p < 1 ? 'vacuum' : ratio > 1.08 ? 'under-expanded' : ratio < 0.92 ? 'over-expanded' : 'near-ideal';
    setMetric('ratio', atmosphere(live.alt).p < 1 ? '∞' : fmt(ratio, ratio < 10 ? 2 : 0), '', sep ? `SEPARATED AT ${fmt(sep.frac * 100, 0)} % OF BELL · theory ${fmt(t.ratio, 2)}` : `${mstate.toUpperCase()} · theory ${fmt(t.ratio, 2)}` + (t.separation ? ' · sep. risk' : ''));
  }
}

function updateTheoryPanel() {
  const el = $('theory-body'); if (!el || !el.offsetParent) return;
  const t = theoryNow();
  const pa = atmosphere(live ? live.alt : S.alt * 1000).p;
  const st = { 'under-expanded': 'under', 'over-expanded': 'over', 'near-ideal': 'ideal', vacuum: 'vac' }[t.state];
  const row = (k, a, b) => `<tr><td>${k}</td><td class="n">${a}</td><td class="n">${b === undefined ? '' : b}</td></tr>`;
  const [Fi, Fu] = fmtForce(t.F), [Fs, Fsu] = perf ? fmtForce(perf.F) : ['—', ''];
  el.innerHTML = `
    <div style="margin:4px 0 8px"><span class="state ${st}">${t.state.toUpperCase()}</span>
      ${sep ? '<span class="state over" style="margin-left:6px">FLOW SEPARATED</span>' : t.separation ? '<span class="state over" style="margin-left:6px">SEPARATION LIKELY</span>' : ''}</div>
    <table class="th">
      <tr class="head"><td></td><td class="n">1-D ideal</td><td class="n">simulated</td></tr>
      ${row('Thrust', Fi + ' ' + Fu, perf ? Fs + ' ' + Fsu : '—')}
      ${row('Mass flow', fmt(t.mdot, 3) + ' kg/s', perf ? fmt(perf.mdot, 3) + ' kg/s' : '—')}
      ${row('Exit Mach', fmt(t.Me, 2), perf ? fmt(perf.Me, 2) : '—')}
      ${row('Exit pressure', fmt(t.pe / 1000, 1) + ' kPa', perf ? fmt(perf.pe / 1000, 1) + ' kPa' : '—')}
      ${row('Isp', fmt(t.Isp, 0) + ' s', perf ? fmt(perf.Isp, 0) + ' s' : '—')}
      ${row('Chamber pressure', fmt((live ? live.Pc : 0) / 1e5, 1) + ' bar', chamber ? fmt(chamber.p / 1e5, 1) + ' bar' : '—')}
      ${row('Chamber temp.', fmt(live ? live.Tc : 0, 0) + ' K', chamber ? fmt(chamber.T, 0) + ' K' : '—')}
      ${P && P.inj && chamber ? row('c* efficiency', '100 %', fmt(100 * chamber.p / live.Pc, 1) + ' %') : ''}
      ${P && P.inj && chamberPerf ? row('Oxidiser unburnt at throat', '—', fmt(100 * chamberPerf.unburntOx, 1) + ' % of flow') : ''}
      ${P && P.inj && chamberPerf ? row('Fuel vapour at throat', '—', fmt(100 * chamberPerf.fuelVapour, 1) + ' % of flow') : ''}
      ${P && P.inj && wallGasT ? row('Gas temp. at chamber wall', '—', fmt(wallGasT, 0) + ' K') : ''}
      ${row('Separation point', (() => { const f = setup ? summerfieldPoint(setup.contour, live ? live.Pc : S.Pc * 1e5, S.gamma, pa) : null; return f === null ? 'attached' : fmt(f * 100, 0) + ' % of bell'; })(), !S.viscous ? 'viscosity off' : sep ? fmt(sep.frac * 100, 0) + ' % of bell' : 'attached')}
      ${sep ? row('Wall p / pa at separation', '0.40', fmt(sep.pRatio, 2)) : ''}
      <tr class="head"><td colspan="3" style="padding-top:10px">Ideal nozzle numbers</td></tr>
      ${row('Expansion ratio ε', fmt(t.eps, 2))}
      ${row('Optimum ε here', isFinite(t.epsOpt) ? fmt(t.epsOpt, 2) : '∞ (vacuum)')}
      ${row('Pe / Pa', pa < 1 ? '∞' : fmt(t.ratio, 3))}
      ${row('Thrust coefficient Cf', fmt(t.Cf, 3))}
      ${row('Characteristic vel. c*', fmt(t.cstar, 0) + ' m/s')}
      ${row('Exit velocity', fmt(t.ue, 0) + ' m/s')}
      ${row('Exit temperature', fmt(t.Te, 0) + ' K')}
      ${row('Vacuum Isp', fmt(t.IspVac, 0) + ' s')}
      ${row('Vacuum thrust', fmtForce(t.Fvac).join(' '))}
      ${row('Ambient pressure', fmt(pa / 1000, pa < 1000 ? 3 : 2) + ' kPa')}
    </table>
    <p class="note">"Simulated" values are measured at the nozzle exit plane by the solver once the start-up transient has passed (give it ~1 ms of sim time). The 1-D numbers assume uniform, parallel, frictionless exit flow, so a few % difference is normal: real bells lose a little to divergence and wall friction, and a coarse grid adds numerical loss. The 1-D separation point uses the Summerfield criterion (wall pressure = 0.4 pa).</p>
    ${t.separation && !sep && S.viscous ? '<p class="note warn">Pe &lt; 0.4 Pa (Summerfield criterion): a real engine would likely separate here. Give the flow time to settle, or raise the grid: separation forms in the boundary layer, which is only a few cells thick.</p>' : ''}
    ${t.separation && !S.viscous ? '<p class="note warn">Pe &lt; 0.4 Pa (Summerfield criterion): a real engine would likely separate here, but viscosity is switched off, so this run has no boundary layer to separate.</p>' : ''}`;
}

// ---------------------------------------------------------------------------
// Probe
// ---------------------------------------------------------------------------
function updateProbe() {
  const el = $('probe');
  if (!mouse.inside || mouse.down || !setup) { el.style.display = 'none'; probeCell = null; return; }
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const [x, y] = screenToCell(mouse.x * dpr, mouse.y * dpr);
  const i = Math.floor(x), j = Math.floor(Math.abs(y));
  if (i < 0 || i >= setup.Nx || j >= setup.Nr) { el.style.display = 'none'; probeCell = null; return; }
  const xm = (x * setup.dx), rm = (Math.abs(y) * setup.dx);
  let txt;
  if (setup.mask[j * setup.Nx + i]) { probeCell = null; txt = `wall\nx ${fmt(xm * 1000, 1)} mm  r ${fmt(rm * 1000, 1)} mm`; }
  else {
    probeCell = { i, j };
    if (!probeData) { el.style.display = 'none'; return; }
    const q = probeData.q;
    txt = `x ${fmt(xm * 1000, 1)} mm   r ${fmt(rm * 1000, 1)} mm\n` +
      `T    ${fmt(q.T, 0)} K\np    ${q.p >= 1e5 ? fmt(q.p / 1e5, 2) + ' bar' : fmt(q.p / 1000, 2) + ' kPa'}\n` +
      `Mach ${fmt(q.M, 2)}\n|u|  ${fmt(Math.hypot(q.u, q.v), 0)} m/s\nρ    ${fmt(q.rho, q.rho < 1 ? 4 : 2)} kg/m³\nexh. ${fmt(q.Y * 100, 0)} %`;
  }
  el.textContent = txt;
  el.style.display = 'block';
  const vr = $('viewport').getBoundingClientRect();
  let lx = mouse.x + 16, ly = mouse.y + 16;
  if (lx + 190 > vr.width) lx = mouse.x - 200;
  if (ly + 130 > vr.height) ly = mouse.y - 140;
  el.style.left = lx + 'px'; el.style.top = ly + 'px';
}

// ---------------------------------------------------------------------------
// Recording + screenshots
// ---------------------------------------------------------------------------
const recCanvas = document.createElement('canvas');
const recCtx = recCanvas.getContext('2d');
recCanvas.setAttribute('aria-hidden', 'true');
recCanvas.style.cssText = 'position:fixed;left:-100000px;top:0;width:2px;height:2px;opacity:0;pointer-events:none';
document.body.appendChild(recCanvas);
let recorder = null, recChunks = [], recStart = 0, shotPending = false;
function recDims() {
  switch (S.recSize) {
    case '1080p': return [1920, 1080];
    case '4k': return [3840, 2160];
    case 'portrait': return [1080, 1920];
    case 'square': return [1080, 1080];
    default: {
      // Retina / 5K screens can exceed what video encoders accept (~4096 px wide).
      const k = Math.min(1, 3840 / glCanvas.width, 2160 / glCanvas.height);
      return [Math.round(glCanvas.width * k) & ~1, Math.round(glCanvas.height * k) & ~1];
    }
  }
}
function composite() {
  const [W, H] = recDims();
  if (recCanvas.width !== W || recCanvas.height !== H) { recCanvas.width = W; recCanvas.height = H; }
  const c = recCtx, mono = getComputedStyle(document.body).getPropertyValue('--mono');
  c.fillStyle = '#06070b'; c.fillRect(0, 0, W, H);
  const gw = glCanvas.width, gh = glCanvas.height;
  const portrait = H > W * 1.2, square = Math.abs(H - W) < 10;
  const u = Math.min(W, H) / 1080;          // UI scale unit
  let rx, ry, rw, rh, hudY;
  if (portrait || square) {
    rw = W; rh = Math.min(H * (square ? 0.62 : 0.5), W * gh / gw);
    rx = 0; ry = square ? H * 0.1 : (H - rh) / 2 - H * 0.04; hudY = ry + rh + 40 * u;
    // crop the source to the target aspect (centre)
    const sa = rw / rh, sw = Math.min(gw, gh * sa), sh = sw / sa;
    const sx = (gw - sw) / 2, sy = (gh - sh) / 2;
    c.drawImage(glCanvas, sx, sy, sw, sh, rx, ry, rw, rh);
    c.drawImage(ovCanvas, sx, sy, sw, sh, rx, ry, rw, rh);
  } else {
    rx = 0; ry = 0; rw = W; rh = Math.round(H - 175 * u);
    const sa = rw / rh, sw = Math.min(gw, gh * sa), sh = sw / sa;
    const sx = (gw - sw) / 2, sy = (gh - sh) / 2;
    c.drawImage(glCanvas, sx, sy, sw, sh, 0, 0, rw, rh);
    c.drawImage(ovCanvas, sx, sy, sw, sh, 0, 0, rw, rh);
    hudY = rh + 14 * u;
  }
  // header
  c.textBaseline = 'top'; c.textAlign = 'left';
  c.fillStyle = 'rgba(200,210,230,0.6)'; c.font = `${20 * u}px ${mono}`;
  const pad = 36 * u;
  const headY = portrait ? ry - 70 * u : square ? ry - 70 * u : pad;
  c.fillText(`T+ ${fmt(simTime * 1000, 2)} ms`, pad, headY);
  c.fillText((S.split && S.mirror) ? `${FIELDS[fieldIndex()].label.toUpperCase()} ▲  ·  ${FIELDS.find(f => f.id === S.field2).label.toUpperCase()} ▼` : FIELDS[fieldIndex()].label.toUpperCase() + ' FIELD', pad, headY + 28 * u);
  c.textAlign = 'right';
  c.fillText((S.ascent ? `ALT ${fmt(S.alt, 1)} km · M ${fmt(S.mach, 2)}` : `ALT ${fmt(S.alt, 1)} km`), W - pad, headY);
  // metrics
  const t = theoryCache || theoryNow();
  const met = perf && chamber ? [
    ['THRUST', ...fmtForce(perf.F)], ['MACH', fmt(perf.Me, 2), ''], ['CHAMBER', fmt(chamber.T, 0), 'K'], ['Pc', fmt(chamber.p / 1e6, 1), 'MPa'],
  ] : [['THRUST', '—', ''], ['MACH', '—', ''], ['CHAMBER', '—', ''], ['Pc', '—', '']];
  const colW = (W - 2 * pad) / met.length;
  c.strokeStyle = 'rgba(120,130,150,0.35)'; c.lineWidth = Math.max(1, u * 1.5);
  c.beginPath(); c.moveTo(pad, hudY); c.lineTo(W - pad, hudY); c.stroke();
  met.forEach((m, k) => {
    const x = pad + k * colW;
    c.textAlign = 'left'; c.fillStyle = 'rgba(150,160,180,0.7)'; c.font = `${16 * u}px ${mono}`;
    c.fillText(m[0], x, hudY + 18 * u);
    c.fillStyle = '#e8edf6'; c.font = `${44 * u}px ${mono}`;
    c.fillText(m[1], x, hudY + 42 * u);
    const w = c.measureText(m[1]).width;
    c.fillStyle = 'rgba(150,160,180,0.8)'; c.font = `${16 * u}px ${mono}`;
    c.fillText(m[2], x + w + 6 * u, hudY + 66 * u);
  });
  c.textAlign = 'left'; c.fillStyle = 'rgba(150,160,180,0.55)'; c.font = `${15 * u}px ${mono}`;
  const footY = portrait || square ? hudY + 130 * u : H - 30 * u;
  c.fillText('ROCKET NOZZLE CFD SOLVER', pad, footY);
  c.textAlign = 'right';
  c.fillText(`2D axisymmetric · ${S.viscous ? 'Navier-Stokes + turbulence model' : 'inviscid'}${P && P.chem ? ' · afterburning' : ''}`, W - pad, footY);
  return recCanvas;
}
function stamp() { const d = new Date(), p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`; }
// Saving: browsers put downloads in the user's Downloads folder (or ask, if
// they're set to). A save started outside a click (e.g. when a recording
// finishes) can be blocked by Safari, so a toast always offers a manual
// "Save again" link, which is a real click and always works.
let saveToast = null, saveToastTimer = 0;
function showSaveToast(html, url, name, keepOpen) {
  if (!saveToast) {
    saveToast = document.createElement('div');
    saveToast.style.cssText = 'position:fixed;left:50%;bottom:18px;transform:translateX(-50%);z-index:60;max-width:min(560px,calc(100vw - 32px));background:rgba(8,10,16,.96);border:1px solid #3fd0ff;border-radius:8px;padding:10px 14px;font:12px/1.5 var(--mono);color:#c9d0de;box-shadow:0 6px 24px rgba(0,0,0,.5)';
    document.body.appendChild(saveToast);
  }
  saveToast.innerHTML = html;
  if (url) {
    const a = document.createElement('a');
    a.href = url; a.download = name; a.textContent = 'Save again';
    a.style.cssText = 'color:#3fd0ff;margin-left:10px;text-decoration:underline;cursor:pointer';
    saveToast.appendChild(a);
  }
  const x = document.createElement('span');
  x.textContent = '×'; x.style.cssText = 'margin-left:12px;cursor:pointer;color:#8a93a6;font-size:15px';
  x.onclick = () => { saveToast.style.display = 'none'; };
  saveToast.appendChild(x);
  saveToast.style.display = 'block';
  clearTimeout(saveToastTimer);
  if (!keepOpen) saveToastTimer = setTimeout(() => { saveToast.style.display = 'none'; }, 12000);
}
const savedUrls = [];
function download(blob, name, note = '') {
  if (!blob || !blob.size) { showSaveToast(`Couldn't create <b>${name}</b>: the browser returned an empty file.`, null, null, true); return; }
  const url = URL.createObjectURL(blob);
  // Keep the last few files available for "Save again"; revoke older ones.
  savedUrls.push(url); while (savedUrls.length > 4) URL.revokeObjectURL(savedUrls.shift());
  const a = document.createElement('a');
  a.href = url; a.download = name; a.rel = 'noopener'; a.style.display = 'none';
  document.body.appendChild(a);
  try { a.click(); } catch (e) { console.warn('download click failed', e); }
  setTimeout(() => a.remove(), 1000);
  const mb = blob.size / 1048576;
  showSaveToast(`Saved <b>${name}</b> (${mb >= 1 ? fmt(mb, 1) + ' MB' : fmt(blob.size / 1024, 0) + ' KB'}) to your Downloads folder.${note ? '<br>' + note : ''}<br><span style="color:#8a93a6">Not there?</span>`, url, name);
}
// Pick a format the browser can actually record. MP4 (H.264) first, because it
// plays everywhere (QuickTime, Windows Photos, phones); WebM as a fallback.
const REC_TYPES = [
  'video/mp4;codecs=avc1.640033', 'video/mp4;codecs=avc1.4d0033', 'video/mp4;codecs=avc1', 'video/mp4;codecs=h264', 'video/mp4',
  'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm',
];
function makeRecorder(stream, bitrate) {
  const ok = REC_TYPES.filter(t => { try { return MediaRecorder.isTypeSupported(t); } catch (e) { return false; } });
  for (const mime of [...ok, '']) {
    for (const bps of [bitrate, Math.min(bitrate, 16e6)]) {
      try { return new MediaRecorder(stream, mime ? { mimeType: mime, videoBitsPerSecond: bps } : { videoBitsPerSecond: bps }); }
      catch (e) { console.warn('MediaRecorder rejected', mime || '(default)', bps, e); }
    }
  }
  return new MediaRecorder(stream);
}
function resetRecButton() { recorder = null; $('b-rec').classList.remove('on'); $('b-rec').textContent = '● Record'; }
function toggleRecord() {
  if (recorder) { if (recorder.state !== 'inactive') recorder.stop(); return; }
  if (!window.MediaRecorder || !recCanvas.captureStream) {
    showSaveToast('Video recording isn\'t supported in this browser. Use Chrome, Edge, Firefox or Safari 14.1+. Screenshots still work.', null, null, true);
    return;
  }
  composite();
  let stream, rec;
  try {
    stream = recCanvas.captureStream(60);
    const px = recCanvas.width * recCanvas.height;
    rec = makeRecorder(stream, Math.round(Math.min(40e6, Math.max(8e6, px * 10))));
  } catch (e) {
    console.error(e);
    showSaveToast('Couldn\'t start recording: ' + (e && e.message ? e.message : e) + '. Try a smaller frame under <i>Recording</i>.', null, null, true);
    return;
  }
  recorder = rec;
  recChunks = [];
  const chunks = recChunks;
  rec.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
  rec.onerror = e => {
    console.error('Recorder error', e);
    showSaveToast('Recording stopped with an error' + (e && e.error ? ': ' + e.error.message : '') + '. Try a smaller frame under <i>Recording</i>, or another browser.', null, null, true);
  };
  rec.onstop = () => {
    stream.getTracks().forEach(t => t.stop());
    const type = rec.mimeType || (chunks[0] && chunks[0].type) || 'video/webm';
    const ext = type.includes('mp4') ? 'mp4' : 'webm';
    const note = ext === 'webm' ? 'WebM file: plays in Chrome, Edge, Firefox and VLC. On a Mac, QuickTime can\'t open it; use VLC or open it in a browser.' : '';
    resetRecButton();
    if (!chunks.length) { showSaveToast('The recording came out empty. Try again, or pick a smaller frame under <i>Recording</i>.', null, null, true); return; }
    download(new Blob(chunks, { type: type.split(';')[0] }), `nozzle_cfd_${stamp()}.${ext}`, note);
  };
  try { rec.start(1000); }
  catch (e) { console.error(e); resetRecButton(); showSaveToast('Couldn\'t start recording: ' + (e && e.message ? e.message : e), null, null, true); return; }
  recStart = performance.now();
  $('b-rec').classList.add('on');
}

// ---------------------------------------------------------------------------
// Modes
// ---------------------------------------------------------------------------
let ascentT = 0, sweepT = 0;
function updateModes(dt) {
  if (S.ascent) {
    ascentT += dt;
    const s = Math.min(1, ascentT / S.ascentDur);
    S.alt = Math.round(S.ascentTop * Math.pow(s, 1.5) * 100) / 100;
    if (S.ascentMach) S.mach = Math.round(S.ascentMachTop * Math.pow(s, 1.1) * 100) / 100;
    syncControl('alt'); syncControl('mach');
    if (s >= 1) { S.ascent = false; syncControl('ascent'); refreshVisibility(); }
  }
  if (S.throttleSweep) {
    sweepT += dt;
    S.throttle = Math.round(70 + 30 * Math.cos(2 * Math.PI * sweepT / 8));
    syncControl('throttle');
  }
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------
// GPU-load-aware step budget: a fence is placed after each frame's work. If the
// previous frames' fences have all completed when a new frame starts, the GPU
// has spare time -> add steps; if work is piling up -> back off. Works at any
// display refresh rate (60/144 Hz, or 30 fps under the browser's energy saver).
let frameFences = [];
function adaptBudget() {
  while (frameFences.length && gl.getSyncParameter(frameFences[0], gl.SYNC_STATUS) === gl.SIGNALED) gl.deleteSync(frameFences.shift());
  while (frameFences.length > 6) gl.deleteSync(frameFences.shift());
  const pending = frameFences.length;
  if (!running || selfTestRunning) return;
  if (pending >= 2) { slowFrames++; if (slowFrames >= 2) { budget = Math.max(1, budget * 0.8); slowFrames = 0; } }
  else { slowFrames = 0; if (pending === 0) budget = Math.min(S.speed, budget * 1.06 + 0.5); }
}
function frame(now) {
  requestAnimationFrame(frame);
  if (!setup || contextLost || gl.isContextLost()) return;
  adaptBudget();
  const dtWall = Math.min(0.1, (now - lastFrameT) / 1000);
  lastFrameT = now;
  resizeCanvas();
  updateModes(dtWall);
  applyLive(dtWall);
  let n = 0;
  if (running || stepOnce) {
    n = stepOnce ? S.speed : Math.max(1, Math.min(S.speed, Math.round(budget)));
    solver.step(n, P);
    stepsTotal += n; stepsWindow += n;
    stepOnce = false;
  }
  asyncReadback();
  if (S.particles && n > 0) renderer.advectParticles(lastDt * n, [setup.contour.Lc / setup.dx, setup.contour.Rc / setup.dx, 0.8, 220]);
  const v = V();
  renderer.derive(v);
  if (v.split) renderer.derive(v, true);
  renderer.display(v, glCanvas.width, glCanvas.height);
  drawOverlay();
  updateProbe();
  if (recorder || shotPending) {
    const cv = composite();
    if (shotPending) { shotPending = false; const name = `nozzle_cfd_${stamp()}.png`; cv.toBlob(b => download(b, name), 'image/png'); }
    if (recorder) $('b-rec').textContent = `■ Stop ${fmt((now - recStart) / 1000, 0)}s`;
  }
  minFrameDt = Math.min(minFrameDt * 1.003, Math.max(dtWall, 0.004));   // info only
  frameFences.push(gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0));
  frameNo++; fpsWindow++;
  if (now - statT > 1000) {
    stepsPerSec = stepsWindow * 1000 / (now - statT); fps = fpsWindow * 1000 / (now - statT);
    stepsWindow = 0; fpsWindow = 0; statT = now;
    $('speedval').textContent = (Math.round(budget) < S.speed && running) ? `${Math.round(budget)}/${S.speed} st/fr` : `${S.speed} st/fr`;
  }
  if (frameNo % 6 === 0) updateHUD();
  if (frameNo % 15 === 0) updateTheoryPanel();
}
let stepOnce = false;

// ---------------------------------------------------------------------------
// UI construction
// ---------------------------------------------------------------------------
const rows = {};   // key -> {el, input, valInput, item}
function buildPanel() {
  const body = $('panel-body');
  for (const sec of CONTROLS) {
    const d = document.createElement('details'); d.className = 'sec'; d.open = !!sec.open;
    d.innerHTML = `<summary>${sec.section}</summary>`;
    const sb = document.createElement('div'); sb.className = 'sec-body'; d.appendChild(sb);
    if (sec.custom === 'theory') { sb.innerHTML = '<div id="theory-body"></div>'; d.addEventListener('toggle', updateTheoryPanel); }
    if (sec.custom === 'help') sb.innerHTML = HELP_HTML;
    for (const it of sec.items || []) sb.appendChild(buildRow(it));
    if (sec.customAfter === 'recnote') {
      const n = document.createElement('p'); n.className = 'note';
      n.innerHTML = 'Press <span class="kbd">● Record</span> (or <span class="kbd">V</span>) to capture what you see, with the readouts burned in, and again to stop. The file saves to your Downloads folder as MP4 where the browser supports it (Chrome, Edge, Safari), otherwise WebM (Firefox). If nothing appears, click <i>Save again</i> in the message that pops up. Screenshots (<span class="kbd">S</span>) use the same frame.';
      sb.appendChild(n);
    }
    body.appendChild(d);
  }
  refreshVisibility(); refreshHints();
}
function buildRow(it) {
  const row = document.createElement('div'); row.className = 'row';
  const liveTag = it.kind === 'live' ? '<span class="live">LIVE</span>' : '';
  if (it.type === 'toggle') {
    row.className = 'row toggle';
    row.innerHTML = `<span class="name">${it.label}</span><input type="checkbox">`;
    const inp = row.querySelector('input'); inp.checked = !!S[it.key];
    inp.addEventListener('change', () => { S[it.key] = inp.checked; onChange(it); });
    row.addEventListener('click', e => { if (e.target !== inp) { inp.checked = !inp.checked; inp.dispatchEvent(new Event('change')); } });
    rows[it.key] = { el: row, input: inp, item: it };
  } else if (it.type === 'select') {
    row.innerHTML = `<div class="top"><span class="name">${it.label}</span></div><select></select><div class="hint"></div>`;
    const sel = row.querySelector('select');
    for (const [v, l] of it.options) { const o = document.createElement('option'); o.value = v; o.textContent = l; sel.appendChild(o); }
    sel.value = S[it.key];
    sel.addEventListener('change', () => { S[it.key] = typeof S[it.key] === 'number' ? +sel.value : sel.value; onChange(it); });
    rows[it.key] = { el: row, input: sel, item: it };
  } else if (it.type === 'seg') {
    row.innerHTML = `<div class="top"><span class="name">${it.label}</span></div><div class="seg"></div>`;
    const seg = row.querySelector('.seg');
    for (const [v, l] of it.options) {
      const b = document.createElement('button'); b.textContent = l; b.dataset.v = v;
      b.addEventListener('click', () => { S[it.key] = typeof it.options[0][0] === 'number' ? +v : v; syncControl(it.key); onChange(it); });
      seg.appendChild(b);
    }
    rows[it.key] = { el: row, seg, item: it };
  } else if (it.type === 'button') {
    row.innerHTML = `<button class="btn" style="width:100%">${it.label}</button>`;
    row.querySelector('button').addEventListener('click', it.action);
    rows[it.key] = { el: row, item: it };
  } else {
    row.innerHTML = `<div class="top"><span class="name">${it.label}${liveTag}</span><span class="val"><input type="text"><span class="u">${it.unit || ''}</span></span></div>
      <input type="range" min="${it.min}" max="${it.max}" step="${it.step}"><div class="hint"></div>`;
    const rng = row.querySelector('input[type=range]'), num = row.querySelector('.val input');
    rng.value = S[it.key]; num.value = fmt(S[it.key], it.d).replace(/,/g, '');
    rng.addEventListener('input', () => { S[it.key] = +rng.value; num.value = fmt(S[it.key], it.d).replace(/,/g, ''); onChange(it); });
    num.addEventListener('change', () => {
      let v = parseFloat(num.value); if (!isFinite(v)) v = S[it.key];
      v = Math.min(it.max * 4, Math.max(it.min * 0.25, v));
      S[it.key] = v; rng.value = v; num.value = fmt(v, it.d).replace(/,/g, ''); onChange(it);
    });
    num.addEventListener('keydown', e => e.stopPropagation());
    rows[it.key] = { el: row, input: rng, num, item: it };
  }
  return row;
}
function syncControl(key) {
  const r = rows[key]; if (!r) return;
  const it = r.item;
  if (it.type === 'toggle') r.input.checked = !!S[key];
  else if (it.type === 'select') r.input.value = S[key];
  else if (it.type === 'seg') r.seg.querySelectorAll('button').forEach(b => b.classList.toggle('on', String(b.dataset.v) === String(S[key])));
  else if (r.num) { r.input.value = S[key]; if (document.activeElement !== r.num) r.num.value = fmt(S[key], it.d).replace(/,/g, ''); }
}
function refreshVisibility() {
  for (const k in rows) { const it = rows[k].item; rows[k].el.style.display = it.show && !it.show() ? 'none' : ''; }
}
function refreshHints() {
  for (const k in rows) {
    const it = rows[k].item, h = rows[k].el.querySelector('.hint');
    if (h) h.textContent = it.hint ? it.hint() : (it.kind === 'next' ? 'Applies when you press Restart' : '');
  }
}
function onChange(it) {
  switch (it.kind) {
    case 'geo': remesh(); S.preset = 'custom'; break;
    case 'reset': restartSoon(); break;
    case 'live': S.preset = 'custom'; break;
    case 'live2': if (setup) setup.cfg.cfl = S.cfl; break;
    case 'prop': {
      const p = PROPELLANTS[S.prop];
      if (S.prop !== 'custom') {
        const gChanged = Math.abs(p.gamma - S.gamma) > 1e-9;
        S.Tc = p.Tc; S.gamma = p.gamma; S.Mw = p.Mw; S.qAb = p.qAb; S.sAir = p.sAir;
        if (p.spray) S.OF = p.spray.OF;
        ['Tc', 'gamma', 'Mw', 'qAb', 'OF'].forEach(syncControl);
        if (gChanged || S.injMode) restartSoon();
      }
      break;
    }
    case 'mode': ascentT = 0; sweepT = 0; if (!S.throttleSweep && it.key === 'throttleSweep') { S.throttle = 100; syncControl('throttle'); } break;
  }
  if (['Tc', 'gamma', 'Mw', 'qAb'].includes(it.key) && S.prop !== 'custom' && !S.injMode) { S.prop = 'custom'; syncControl('prop'); }
  if (it.key === 'injMode') { view.fitted = false; }
  if (it.key === 'split' && S.split && !S.mirror) { S.mirror = true; syncControl('mirror'); view.fitted = false; fitView(); }
  if (it.key === 'mirror') { if (!S.mirror && S.split) { S.split = false; syncControl('split'); } view.fitted = false; fitView(); }
  if (it.key === 'cmap') renderer.setColormap(S.cmap);
  refreshVisibility(); refreshHints();
  saveSettings();
}

function applyPreset(key) {
  const e = ENGINE_PRESETS[key]; if (!e) return;
  const p = PROPELLANTS[e.prop];
  Object.assign(S, { preset: key, prop: e.prop, Tc: p.Tc, gamma: p.gamma, Mw: p.Mw, qAb: p.qAb, sAir: p.sAir, Pc: e.Pc, throttle: 100, Dt: e.Dt, De: e.De,
    type: e.type, bellPct: e.bellPct, coneAngle: e.coneAngle, CR: e.CR, chamberLen: e.chamberLen, alt: e.alt, mach: e.mach,
    base: e.base, domainL: e.domain, ascent: false, throttleSweep: false, injMode: false });
  if (p.spray) S.OF = p.spray.OF;
  if (e.inj) Object.assign(S, e.inj);
  for (const k in rows) syncControl(k);
  refreshVisibility();
  view.fitted = false;
  restart();
  if (e.field) setField(e.field);
  saveSettings();
}

function buildTabs() {
  const tabs = $('tabs');
  FIELDS.forEach((f, k) => {
    const b = document.createElement('button'); b.className = 'tab'; b.textContent = f.label.replace(' (log)', '').replace(' (visual)', '');
    b.title = `${f.label}  [${k + 1}]`;
    b.addEventListener('click', () => setField(f.id));
    b.dataset.f = f.id; tabs.appendChild(b);
  });
}
function setField(id) {
  S.field = id;
  saveSettings();
  document.querySelectorAll('.tab').forEach(b => b.classList.toggle('on', b.dataset.f === id));
  refreshVisibility();
  if (setup) updateHUD();
}

function setRunning(r) {
  running = r;
  $('b-play').textContent = running ? '❚❚ Pause' : '▶ Play';
  $('b-play').classList.toggle('primary', running);
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------
function bindEvents() {
  $('b-play').onclick = () => setRunning(!running);
  $('b-restart').onclick = () => { restart(); };
  $('b-step').onclick = () => { setRunning(false); stepOnce = true; };
  $('b-rec').onclick = toggleRecord;
  $('b-shot').onclick = () => { shotPending = true; };
  $('b-panel').onclick = () => { $('panel').classList.toggle('hidden'); setTimeout(() => { resizeCanvas(); fitView(); }, 30); };
  const sp = $('speed');
  sp.value = S.speed;
  sp.oninput = () => { S.speed = +sp.value; budget = Math.min(budget, S.speed); $('speedval').textContent = `${S.speed} st/fr`; saveSettings(); };
  const sel = $('preset');
  for (const [k, e] of Object.entries(ENGINE_PRESETS)) { const o = document.createElement('option'); o.value = k; o.textContent = e.name; sel.appendChild(o); }
  const oc = document.createElement('option'); oc.value = 'custom'; oc.textContent = 'Custom (your settings)'; oc.disabled = true; sel.appendChild(oc);
  sel.value = S.preset;
  sel.onchange = () => applyPreset(sel.value);
  setInterval(() => { if (sel.value !== S.preset) sel.value = S.preset; }, 300);

  const vp = $('viewport');
  vp.addEventListener('mousemove', e => {
    const r = vp.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    if (mouse.down) {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      view.cx -= (x - mouse.lastX) * dpr / view.zoom; view.cy += (y - mouse.lastY) * dpr / view.zoom;
      view.fitted = false; clampView(); mouse.moved = true;
    }
    mouse.x = x; mouse.y = y; mouse.lastX = x; mouse.lastY = y; mouse.inside = true;
  });
  vp.addEventListener('mouseleave', () => { mouse.inside = false; mouse.down = false; });
  vp.addEventListener('mousedown', e => { mouse.down = true; mouse.moved = false; const r = vp.getBoundingClientRect(); mouse.lastX = e.clientX - r.left; mouse.lastY = e.clientY - r.top; vp.style.cursor = 'grabbing'; });
  window.addEventListener('mouseup', () => { mouse.down = false; vp.style.cursor = 'crosshair'; });
  vp.addEventListener('dblclick', () => { fitView(); });
  vp.addEventListener('wheel', e => {
    e.preventDefault();
    const r = vp.getBoundingClientRect(), dpr = Math.min(window.devicePixelRatio || 1, 2);
    const px = (e.clientX - r.left) * dpr, py = (e.clientY - r.top) * dpr;
    const before = screenToCell(px, py);
    const f = Math.exp(-e.deltaY * 0.0015);
    const W = glCanvas.width;
    const minZoom = Math.min(W / setup.Nx, glCanvas.height / (setup.Nr * (S.mirror ? 2 : 1))) * 0.9;
    view.zoom = Math.min(Math.max(view.zoom * f, minZoom), 60);
    const after = screenToCell(px, py);
    view.cx += before[0] - after[0]; view.cy += before[1] - after[1];
    view.fitted = false; clampView();
  }, { passive: false });
  window.addEventListener('keydown', e => {
    if (e.target.tagName === 'INPUT' && e.target.type === 'text') return;
    if (e.target.tagName === 'SELECT') return;
    const k = e.key.toLowerCase();
    if (k === ' ') { e.preventDefault(); setRunning(!running); }
    else if (k === 'r') restart();
    else if (k === 'n') { setRunning(false); stepOnce = true; }
    else if (k === 's') shotPending = true;
    else if (k === 'v') toggleRecord();
    else if (k === 'h') $('b-panel').click();
    else if (k === 'f') fitView();
    else if (k === 'm') { S.mirror = !S.mirror; syncControl('mirror'); onChange(rows.mirror.item); }
    else if (k === 'p') { S.particles = !S.particles; syncControl('particles'); }
    else if (k === 'c') { S.sonic = (S.sonic + 1) % 3; syncControl('sonic'); }
    else if (k === 't' && e.shiftKey) runSelfTest();
    else if (/^[1-9]$/.test(k) && FIELDS[+k - 1]) setField(FIELDS[+k - 1].id);
  });
  window.addEventListener('resize', () => { resizeCanvas(); });
}

const HELP_HTML = `
<button class="btn primary" style="width:100%;margin:8px 0 4px" onclick="window.nozzle && window.nozzle.runSelfTest()">Run self-test (≈ 2 min)</button>
<p class="note">Runs every preset, view and feature on your GPU, measures speed at each grid size and shows a pass/fail report. Your settings are restored afterwards.</p>
<p class="note"><b>What you're looking at.</b> The app solves the compressible Navier-Stokes equations on your GPU for an axisymmetric engine: the chamber, the converging–diverging nozzle and the air around it. Shock diamonds, Mach disks, boundary layers, flow separation, afterburning and the plume's response to altitude all come out of the maths. None of it is drawn by hand.</p>
<p class="note"><b>Try this:</b> start the <i>Over-expanded</i> preset and watch for the amber <b>separation</b> marker on the nozzle wall. Pull <b>Altitude</b> up slowly and it moves out of the bell as the jet goes from over- to under-expanded. Or turn on <b>Ascent mode</b> and record it.</p>
<p class="note"><b>Mouse:</b> hover for local values · scroll to zoom · drag to pan · double-click to reset view.</p>
<table class="th">
<tr><td><span class="kbd">Space</span></td><td class="n">play / pause</td></tr>
<tr><td><span class="kbd">R</span></td><td class="n">restart from ignition</td></tr>
<tr><td><span class="kbd">N</span></td><td class="n">single step</td></tr>
<tr><td><span class="kbd">1</span>–<span class="kbd">9</span></td><td class="n">switch field</td></tr>
<tr><td><span class="kbd">C</span></td><td class="n">cycle sonic line / Mach contours</td></tr>
<tr><td><span class="kbd">P</span></td><td class="n">tracer particles</td></tr>
<tr><td><span class="kbd">M</span></td><td class="n">mirror view</td></tr>
<tr><td><span class="kbd">F</span></td><td class="n">fit view</td></tr>
<tr><td><span class="kbd">V</span> / <span class="kbd">S</span></td><td class="n">record video / screenshot</td></tr>
<tr><td><span class="kbd">H</span></td><td class="n">hide panel</td></tr>
<tr><td><span class="kbd">Shift</span>+<span class="kbd">T</span></td><td class="n">run self-test</td></tr>
</table>
<p class="note"><b>Injectors:</b> switch on <i>Simulate injectors, sprays and flame</i> or pick an Injector preset. Fuel droplets are amber and oxidiser droplets are blue. Try the <i>Heat release</i> tab, then change injector type, orifice size or chamber length and watch c* efficiency, shown under Pc. Injector elements are rings because the solver is axisymmetric, so baffles and cavities can't show their effect on tangential instability.</p>
    <p class="note"><b>Limits:</b> the flow is 2-D axisymmetric, so turbulence is modelled rather than fully resolved. Boundary layers are only a few cells thick and rely on a wall model. Afterburning is one global reaction. γ changes with the gas mixture but not with temperature. Results still sharpen with grid resolution. Treat the numbers as good engineering estimates for animation, not design data.</p>
<p class="note"><b>Speed:</b> if it's sluggish, lower the grid resolution or the speed slider. On laptops with two GPUs, make Windows run your browser on the NVIDIA card: Settings → System → Display → Graphics → your browser → High performance.</p>
`;


// ---------------------------------------------------------------------------
// Self-test: exercises every feature on this machine's GPU and reports.
// Start with the "Run self-test" button (Help) or open the file with #selftest.
// ---------------------------------------------------------------------------
const sleep = ms => new Promise(r => setTimeout(r, ms));
let selfTestRunning = false;
async function runSelfTest() {
  if (selfTestRunning) return;
  selfTestRunning = true;
  const saved = JSON.parse(JSON.stringify(S));
  const lines = [];
  let pass = 0, fail = 0, warn = 0;
  const box = document.createElement('div');
  box.style.cssText = 'position:fixed;right:16px;top:16px;width:520px;max-height:calc(100vh - 32px);overflow:auto;z-index:50;background:rgba(8,10,16,.96);border:1px solid #3fd0ff;border-radius:8px;padding:14px 16px;font:12px/1.55 var(--mono);color:#c9d0de;white-space:pre-wrap';
  document.body.appendChild(box);
  const head = () => `ROCKET NOZZLE CFD SOLVER SELF-TEST   ✓ ${pass}   ✗ ${fail}   ! ${warn}\n` + '─'.repeat(56) + '\n';
  const render = (extra = '') => { box.textContent = head() + lines.join('\n') + (extra ? '\n\n' + extra : ''); box.scrollTop = box.scrollHeight; };
  const log = (status, msg) => { if (status === 'PASS') pass++; else if (status === 'FAIL') fail++; else if (status === 'WARN') warn++; lines.push(`${status === 'PASS' ? '✓' : status === 'FAIL' ? '✗' : status === 'WARN' ? '!' : '·'} ${msg}`); render(); };
  const glErr = () => { const e = gl.getError(); return e === gl.NO_ERROR ? '' : 'GL error 0x' + e.toString(16); };
  const finiteState = () => {
    const all = solver.readAll(); let bad = 0;
    for (let k = 0; k < all.A.length; k++) if (!isFinite(all.A[k])) bad++;
    return bad;
  };
  const runFor = async (ms) => {
    const s0 = stepsTotal, t0 = performance.now();
    budget = S.speed;
    setRunning(true);
    while (performance.now() - t0 < ms) { await sleep(100); if (contextLost) break; }
    const dt = (performance.now() - t0) / 1000;
    return (stepsTotal - s0) / dt;
  };
  const canvasNotBlank = () => {
    const v = V(); renderer.derive(v); if (v.split) renderer.derive(v, true); renderer.display(v, glCanvas.width, glCanvas.height);
    const px = new Uint8Array(4), seen = new Set();
    for (const [fx, fy] of [[0.1, 0.5], [0.25, 0.5], [0.4, 0.45], [0.6, 0.5], [0.8, 0.2], [0.15, 0.6]]) {
      gl.readPixels(Math.floor(glCanvas.width * fx), Math.floor(glCanvas.height * fy), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      seen.add(px.join(','));
    }
    return seen.size;
  };
  try {
    // 1. environment
    log('INFO', `GPU: ${window.__gpu}`);
    log(isIntegrated() ? 'WARN' : 'PASS', isIntegrated() ? `Integrated/unknown GPU (${gpuName}) — set the browser to High performance for the NVIDIA GPU` : `Discrete GPU in use: ${gpuName}`);
    log(gl.getExtension('EXT_color_buffer_float') ? 'PASS' : 'FAIL', 'Float render targets (EXT_color_buffer_float)');
    log('INFO', `Max texture ${gl.getParameter(gl.MAX_TEXTURE_SIZE)} · units ${gl.getParameter(gl.MAX_TEXTURE_IMAGE_UNITS)} · draw buffers ${gl.getParameter(gl.MAX_DRAW_BUFFERS)} · ${navigator.userAgent.match(/(Chrome|Edg|Firefox)\/[\d.]+/)?.[0] || ''}`);
    log('INFO', `Boot (shader compile + setup): ${fmt(bootMs, 0)} ms`);
    let ls = false; try { localStorage.setItem('rncfd.t', '1'); ls = localStorage.getItem('rncfd.t') === '1'; localStorage.removeItem('rncfd.t'); } catch (e) {}
    log(ls ? 'PASS' : 'WARN', ls ? 'Settings storage works' : 'Settings storage unavailable (settings will not be remembered)');

    // 2. speed at each grid resolution
    let bestRes = 384;
    log('INFO', `Display frame interval ≈ ${fmt(minFrameDt * 1000, 1)} ms (${fmt(1 / minFrameDt, 0)} Hz)${minFrameDt > 0.025 ? ' — browser is capping at ~30 fps (energy saver / battery?)' : ''}`);
    setRunning(false);
    for (const [res, label] of RES_OPTIONS) {
      applyPreset('demo'); S.res = res; restart(); setRunning(false);
      await sleep(200);
      solver.step(20, P); readback();                       // warm-up
      const t0 = performance.now();
      for (let k = 0; k < 10; k++) { solver.step(10, P); if (k % 3 === 2) await sleep(0); }
      solver.readStepInfo();
      const ms = (performance.now() - t0) / 100, sps = 1000 / ms;
      stepsTotal += 120;
      if (contextLost) { log('FAIL', `${label.split(' —')[0]} ${res}: GPU context lost`); await sleep(6000); break; }
      const bad = finiteState(), e = glErr();
      const ok = !bad && !e;
      log(ok ? 'PASS' : 'FAIL', `${label.split(' —')[0].padEnd(6)} ${String(res).padStart(4)}: ${fmt(sps, 0).padStart(6)} steps/s raw GPU · ${fmt(ms, 2)} ms/step${bad ? ' · NaN cells ' + bad : ''}${e ? ' · ' + e : ''}`);
      if (ok && sps > 400) bestRes = res;
      if (ms > 40) { log('INFO', 'Stopping resolution sweep (too slow for higher grids)'); break; }
      await sleep(300);
    }
    log('INFO', `Recommended grid for smooth real-time use: ${bestRes}`);

    // 3. every preset
    const testRes = Math.min(bestRes, 1024);
    const runUntil = async (simMs, maxMs) => {
      const t0 = performance.now();
      while (performance.now() - t0 < maxMs && !contextLost) { await runFor(500); readback(); if (simTime * 1e3 >= simMs) break; }
    };
    for (const key of Object.keys(ENGINE_PRESETS)) {
      applyPreset(key); S.res = testRes; restart(); S.speed = 40;
      await runUntil(0.6, 25000);
      if (contextLost) { log('FAIL', `Preset ${key}: GPU context lost`); await sleep(6000); continue; }
      readback();
      const bad = finiteState(), e = glErr();
      const t = theoryNow();
      const pcErr = chamber ? Math.abs(chamber.p - live.Pc) / live.Pc : 1;
      const ok = !bad && !e && perf && isFinite(perf.F) && pcErr < 0.25;
      log(ok ? 'PASS' : 'FAIL', `Preset ${key.padEnd(9)} T+${fmt(simTime * 1e3, 2)}ms  F ${fmtForce(perf ? perf.F : 0).join(' ')} (ideal ${fmtForce(t.F).join(' ')})  Pc ${fmt(chamber ? chamber.p / 1e5 : 0, 0)}/${fmt(live.Pc / 1e5, 0)} bar${bad ? '  NaN ' + bad : ''}${e ? '  ' + e : ''}`);
    }

    // 4. every view + overlays
    applyPreset('diamonds'); S.res = testRes; restart(); S.speed = 40;
    await runUntil(0.4, 15000);
    for (const f of FIELDS) {
      setField(f.id);
      const n = canvasNotBlank(), e = glErr();
      log(n > 1 && !e ? 'PASS' : 'FAIL', `View ${f.label}: ${n} distinct sample colours${e ? ' · ' + e : ''}`);
    }
    setField('temp');
    for (const [name, patch] of [['Split view', { split: true, field2: 'schl' }], ['Sonic line', { sonic: 1 }], ['Mach contours', { sonic: 2 }], ['Glow off', { glow: false }], ['Particles', { particles: true }], ['Centreline plot', { centerPlot: true }], ['Colour map turbo', { cmap: 'turbo' }], ['Mirror off', { mirror: false, split: false }]]) {
      Object.assign(S, patch); if (patch.cmap) renderer.setColormap(S.cmap); fitView();
      await runFor(600);
      const n = canvasNotBlank(), e = glErr();
      log(n > 1 && !e && !contextLost ? 'PASS' : 'FAIL', `${name}${e ? ' · ' + e : ''}`);
    }
    Object.assign(S, { split: false, sonic: 0, glow: true, particles: false, centerPlot: false, cmap: 'plasma', mirror: true }); renderer.setColormap('plasma'); fitView();

    // physics switches
    for (const [name, patch] of [['Viscosity off', { viscous: false }], ['Afterburning off', { viscous: true, afterburn: false }], ['Both on', { viscous: true, afterburn: true }]]) {
      Object.assign(S, patch);
      await runFor(800);
      const bad = finiteState(), e = glErr();
      log(!bad && !e && !contextLost ? 'PASS' : 'FAIL', `${name}${bad ? ' · NaN ' + bad : ''}${e ? ' · ' + e : ''}`);
    }
    // 5. live changes while running
    for (const [name, patch, kind] of [['Exit diameter 125→160 mm', { De: 160 }, 'geo'], ['Throat diameter 30→36 mm', { Dt: 36 }, 'geo'], ['Conical nozzle', { type: 'cone' }, 'geo'], ['Rocket body on', { base: true }, 'geo'], ['Chamber pressure 90→150 bar', { Pc: 150 }, 'live'], ['Altitude 0→20 km', { alt: 20 }, 'live'], ['Flight Mach 0→2', { mach: 2 }, 'live'], ['Throttle 60 %', { throttle: 60 }, 'live']]) {
      Object.assign(S, patch); if (kind === 'geo') remesh();
      await runFor(1500);
      const bad = finiteState(), e = glErr();
      log(!bad && !e && !contextLost ? 'PASS' : 'FAIL', `Live change: ${name}${bad ? ' · NaN ' + bad : ''}${e ? ' · ' + e : ''}`);
    }
    // ascent mode
    applyPreset('demo'); S.res = testRes; restart(); S.speed = 40;
    Object.assign(S, { ascent: true, ascentDur: 5, ascentTop: 25 }); ascentT = 0;
    await runFor(6000);
    log(S.alt > 20 && !finiteState() ? 'PASS' : 'FAIL', `Ascent mode reached ${fmt(S.alt, 1)} km`);
    S.ascent = false;

    // 6. screenshot + recording (no files are saved)
    for (const size of ['window', '1080p', 'portrait']) {
      S.recSize = size;
      const blob = await new Promise(res => { const cv = composite(); cv.toBlob(res, 'image/png'); });
      log(blob && blob.size > 10000 ? 'PASS' : 'FAIL', `Screenshot ${size}: ${blob ? fmt(blob.size / 1024, 0) : 0} KB`);
    }
    if (window.MediaRecorder && recCanvas.captureStream) {
      S.recSize = '1080p'; composite();
      const stream = recCanvas.captureStream(30);
      const rec = makeRecorder(stream, 12e6);
      const chunks = []; rec.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
      const stopped = new Promise(r => rec.onstop = r);
      rec.start(1000);
      const t0 = performance.now();
      while (performance.now() - t0 < 2500) { composite(); await sleep(33); }
      rec.stop(); await stopped; stream.getTracks().forEach(t => t.stop());
      const size = chunks.reduce((a, b) => a + b.size, 0);
      const type = rec.mimeType || (chunks[0] && chunks[0].type) || 'default';
      log(size > 20000 ? 'PASS' : 'FAIL', `Video recording (${type}): ${fmt(size / 1024, 0)} KB in 2.5 s`);
      if (size > 20000 && !type.includes('mp4')) log('WARN', 'This browser records WebM, not MP4: QuickTime on a Mac can\'t play WebM (VLC can)');
      // Check the save path can build a downloadable link (nothing is saved)
      try { const u = URL.createObjectURL(new Blob(chunks, { type: type.split(';')[0] })); const ok = typeof u === 'string' && u.startsWith('blob:'); URL.revokeObjectURL(u);
        log(ok && 'download' in document.createElement('a') ? 'PASS' : 'FAIL', 'Download link can be created (files save to Downloads)'); }
      catch (e) { log('FAIL', 'Download link: ' + e.message); }
    } else log('FAIL', 'Video recording: not supported in this browser');
    S.recSize = saved.recSize;

    // 7. GPU reset recovery
    const ext = gl.getExtension('WEBGL_lose_context');
    if (ext) {
      const resBefore = S.res;
      ext.loseContext(); await sleep(400); ext.restoreContext();
      let waited = 0; while (contextLost && waited < 10000) { await sleep(250); waited += 250; }
      await runFor(1500);
      const ok = !contextLost && !finiteState();
      log(ok ? 'PASS' : 'FAIL', `Recovery from a forced GPU reset (grid ${resBefore} → ${S.res})`);
      showMsg('');
    }
    log('INFO', `Real GPU resets during the test: ${lossCount - 1 > 0 ? lossCount - 1 : 0}`);
  } catch (e) {
    log('FAIL', 'Self-test crashed: ' + (e && e.message ? e.message : e));
    console.error(e);
  }
  // restore the user's settings
  Object.assign(S, saved); S.ascent = false; S.throttleSweep = false;
  for (const k in rows) syncControl(k);
  renderer.setColormap(S.cmap); refreshVisibility(); restart(); setField(S.field); saveSettings();
  const report = head() + lines.join('\n');
  render(fail === 0 ? 'All tests passed. Your settings have been restored.' : 'Some tests failed — use "Copy report" to save the results.');
  const bar = document.createElement('div'); bar.style.cssText = 'display:flex;gap:8px;margin-top:10px';
  const copy = document.createElement('button'); copy.className = 'btn primary'; copy.textContent = 'Copy report';
  copy.onclick = async () => { try { await navigator.clipboard.writeText(report); copy.textContent = 'Copied ✓'; } catch (e) { const ta = document.createElement('textarea'); ta.value = report; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove(); copy.textContent = 'Copied ✓'; } };
  const close = document.createElement('button'); close.className = 'btn'; close.textContent = 'Close';
  close.onclick = () => box.remove();
  bar.append(copy, close); box.appendChild(bar);
  window.__selfTestReport = report;
  selfTestRunning = false;
}

// ---------------------------------------------------------------------------
// Settings persistence (browser storage; per-browser, best effort)
// ---------------------------------------------------------------------------
const STORE_KEY = 'rncfd.settings.v1';
const TRANSIENT = new Set(['ascent', 'throttleSweep']);
let saveTimer = null;
function saveSettings() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      const o = {};
      for (const k in S) if (!TRANSIENT.has(k)) o[k] = S[k];
      localStorage.setItem(STORE_KEY, JSON.stringify(o));
    } catch (e) { /* storage unavailable: ignore */ }
  }, 400);
}
function loadSettings() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return false;
    const o = JSON.parse(raw);
    for (const k in o) if (k in S && !TRANSIENT.has(k) && typeof o[k] === typeof S[k]) S[k] = o[k];
    if (S.throttle !== 100 && !o.throttle) S.throttle = 100;
    return true;
  } catch (e) { return false; }
}
function showTip() {
  const t = document.createElement('div');
  t.style.cssText = 'position:absolute;left:50%;bottom:16px;transform:translateX(-50%);background:rgba(8,10,16,.85);border:1px solid #262c3f;border-radius:6px;padding:7px 12px;font:11px var(--mono);color:#9aa3b5;letter-spacing:.04em;pointer-events:none;transition:opacity 1s;z-index:4;white-space:nowrap';
  t.textContent = 'hover = probe values  ·  scroll = zoom  ·  drag = pan  ·  double-click = reset view  ·  1–9 = fields  ·  H = hide panel';
  $('viewport').appendChild(t);
  setTimeout(() => { t.style.opacity = '0'; }, 9000);
  setTimeout(() => t.remove(), 10500);
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
let bootMs = 0;
function boot() {
  const tBoot = performance.now();
  buildTabs(); buildPanel(); bindEvents();
  if (!initGL()) return;
  resizeCanvas();
  if (loadSettings()) {
    for (const k in rows) syncControl(k);
    refreshVisibility();
    renderer.setColormap(S.cmap);
    $('speed').value = S.speed; $('speedval').textContent = `${S.speed} st/fr`;
    restart();
  } else applyPreset('demo');
  setField(S.field);
  for (const k in rows) syncControl(k);
  showTip();
  bootMs = performance.now() - tBoot;
  requestAnimationFrame(t => { lastFrameT = t; frame(t); });
  if (/selftest/i.test(location.hash)) setTimeout(runSelfTest, 1500);
  // expose a small API for testing / tinkering from the console
  window.nozzle = { S, get setup() { return setup; }, get solver() { return solver; }, get renderer() { return renderer; }, restart,
    get gpu() { return window.__gpu; }, get lossCount() { return lossCount; }, get stepsPerSec() { return stepsPerSec; }, get fps() { return fps; }, get budget() { return budget; }, applyPreset, setField, get perf() { return perf; }, get chamber() { return chamber; }, get chamberPerf() { return chamberPerf; }, get wallGasT() { return wallGasT; }, processThroat, processChamberWall, get sep() { return sep; }, get simTime() { return simTime; }, get P() { return P; }, get live() { return live; },
    stepNow: (n) => { solver.step(n, P); stepsTotal += n; readback(); processWall(solver._readRect(solver.drawWallRow(), 0, 0, setup.Nx, 1)); updateHUD(); }, composite, setRunning, view, fitView,
    runSelfTest, get selfTestReport() { return window.__selfTestReport; },
    loseContext: () => { const e = gl.getExtension('WEBGL_lose_context'); e.loseContext(); setTimeout(() => e.restoreContext(), 500); } };
}
window.addEventListener('DOMContentLoaded', boot);
})();
