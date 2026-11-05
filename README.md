# Plume Lab — rocket nozzle & exhaust plume simulator

A real-time CFD toy for rocket engines. It runs on your GPU in Chrome or Edge, with nothing to install.

**To run it:** double-click `Plume Lab.html`. If it opens in a different browser, right-click → *Open with* → Chrome or Edge.

---

## What it actually does

It solves the **compressible Euler equations**, which are inviscid gas dynamics, on a 2-D axisymmetric grid. The grid covers the combustion chamber, the converging–diverging nozzle and the air around the engine. Everything you see comes out of the maths: shock diamonds, Mach disks, expansion fans, the start-up vortex ring and the plume changing with altitude. None of it is drawn or faked.

| | |
|---|---|
| Equations | 2-D axisymmetric Euler + a passive "exhaust fraction" scalar |
| Method | Finite volume, MUSCL (van Leer) reconstruction, HLLC Riemann solver (switches to HLL at strong shocks to stop the "carbuncle" glitch), SSP-RK2 time stepping, CFL time step computed on the GPU |
| Gas model | Calorically perfect, single frozen γ; exhaust and air have different molar masses, so temperatures are right |
| Walls | **Cut-cell** (embedded boundary): cells that straddle the nozzle wall use their true fluid volume and face openings, and slivers are merged into a neighbour for stability. The wall follows the real contour, not grid steps. A simpler stepped-wall mode is available for comparison. |
| Boundaries | Stagnation inlet at the injector face (your Pc and Tc), slip walls, pressure far-field, supersonic/subsonic outflow |
| Ambient | US Standard Atmosphere 1976, 0–45 km; optional flight Mach (free-stream) |

### Limits (by design)
- **No viscosity or turbulence.** There are no boundary layers, so a badly over-expanded nozzle shows the shock pattern but not true flow separation. The theory panel flags when a real engine would separate (Summerfield criterion).
- **No combustion in the plume.** There's no afterburning, and one γ is used everywhere.
- **Grid resolution.** The throat should be at least ~8 cells across its radius (the Simulation section shows the count). The cell size is snapped so the throat area, and so the mass flow, is exact.
- Chamber pressure can "ring" for a while after a hard start. That's an acoustic oscillation in the chamber.

### How close is it to theory?
The demo engine (LOX/RP-1, 196 bar, Ø23 mm throat, Ø119 mm exit, ε = 26.8, sea level) was run with a 10-cell throat radius after a hard start:

| | 1-D ideal | Simulated (cut-cell walls) |
|---|---|---|
| Chamber pressure | 196 bar | 190–199 bar (chamber "rings" after a hard start) |
| Mass flow | 4.51 kg/s | ≈ 4.45 kg/s |
| Exit Mach | 4.06 | 3.95 |
| Exit pressure | 63.6 kPa | 63–71 kPa |
| Isp | 312 s | 303–310 s (≈ 98 %, about what a real bell loses to divergence) |

At the same moment, the old stepped-wall version gave an exit Mach of 3.36 and an Isp of 278 s. That's why cut-cell is the default. Still air stays still to 0.0001 m/s around the nozzle walls, so the wall treatment doesn't create spurious flow.

---

## Controls

**Top tabs:** temperature · Mach · Schlieren · pressure · density · velocity · vorticity · exhaust fraction · flame (a "what it might look like" render).

**Right panel**
- **Presets** (top dropdown): over-expanded vacuum bell at sea level, shock diamonds, ideal expansion, high-altitude under-expanded (big Mach disk), upper stage at 30 km, cold-gas thruster, hybrid motor, supersonic flight with a rocket base.
- **Engine geometry:** throat and exit diameter, bell (Rao) or cone, bell length or cone angle, contraction ratio, chamber length, optional rocket body. These are *live*: drag them while it runs and the walls re-mesh in place.
- **Combustion:** propellant presets set Tc, γ and molar mass. Chamber pressure, throttle, Tc and molar mass are live. Changing γ restarts the run.
- **Flight & environment:** altitude and flight Mach (live). **Ascent mode** sweeps altitude (and speed) over a set real-time duration. **Throttle sweep** cycles 40–100 %.
- **View:** colour map, mirror (full plume), **split view** (a different field below the axis, e.g. temperature on top and Schlieren underneath), sonic line / Mach contours, tracer particles, glow (bloom), Schlieren sensitivity, flame brightness.
- **Simulation:** grid resolution, domain length (plus "Fit domain to engine"), wall model (cut-cell or stepped), start-up mode (ignition ramp or diaphragm burst), CFL, 1st/2nd order, and reset-to-defaults.
- **Theory vs simulation:** 1-D ideal nozzle numbers (Cf, c*, Isp, optimum ε, Pe/Pa, …) next to what the solver measures at the exit plane.

**Mouse:** hover for local T, p, Mach, velocity, density · scroll to zoom · drag to pan · double-click to reset the view.

**Keys:** `Space` play/pause · `R` restart · `N` single step · `1–9` fields · `C` sonic line / Mach contours · `P` particles · `M` mirror · `F` fit view · `V` record · `S` screenshot · `H` hide panel · `Shift+T` self-test.

**Recording:** `● Record` captures the view with the readouts burned in (MP4 in current Chrome/Edge, otherwise WebM). Pick the frame under *Recording*: window, 1080p, 4K, **portrait 1080×1920** or square. Tip: turn the speed slider down for slow-motion start-ups.

Your settings are remembered between sessions in this browser. "Reset all settings to defaults" (Simulation section) clears them.

---

## Speed tips
Measured on a laptop with an RTX 3050 Ti in Chrome, raw solver speed:

| Grid | Steps per second |
|---|---|
| Draft 384 × 108 | ≈ 3,300 |
| Low 640 × 179 | ≈ 1,550 |
| Medium 1024 × 287 (default) | ≈ 730 |
| High 1536 × 430 | ≈ 350 |
| Ultra 2048 × 573 | ≈ 200 |

A full start-up and settled plume (about 1 ms of simulated time) takes roughly 15–20 s on Medium, or a few seconds on Low.

- **Make sure the browser uses the NVIDIA GPU:** Windows Settings → System → Display → Graphics → *Add desktop app* → the browser's `.exe` → Options → *High performance*. The top-right readout shows which GPU is in use, in amber if it's integrated graphics.
- The app chooses how many steps to run per frame automatically. It adds steps while the GPU keeps up and backs off when work piles up. The **Speed** slider sets the maximum; the label shows e.g. `12/20 st/fr` when it's holding back.
- Chrome's **Energy saver** (Settings → Performance) caps pages at 30 fps on battery. It still works, just more slowly.
- If the graphics driver ever resets, the app recovers by itself, steps the grid down one level and carries on.
- **Self-test:** Help → *Run self-test*, or press `Shift + T`. It checks every preset, view and feature on your GPU, measures speed at each grid size, and reports pass/fail. Your settings are restored afterwards.
- **Brave works too.** Set it to High performance in the same Windows Graphics page. If the readouts jitter, turn Shields off for this page; its fingerprinting protection adds noise to GPU readbacks.

## Files
- `Plume Lab.html`: the whole app, a single self-contained file that works offline.
- `README.md`: this file.
- `source/`: the same code split into modules (physics, solver, renderer, UI) if you want to read or modify it. Run `python build.py` in that folder to rebuild the single HTML file.
