# AMISync Project Rulebook

## Authoritative Specification
- Treat `SPEC.md` and `Paper Files/icsthesissample.tex` as the single source of truth for all requirements, mathematical formulations, portal extraction mechanics, and UI behavior.
- Always consult `SPEC.md` before implementing or modifying any feature, data model, solver rule, or UI screen.

## Protected Read-Only Directories
- **Never** edit, rename, move, or delete any file inside:
  - `Paper Files/` (thesis `.tex`, `.cls`, `.bib`, and all diagram/UI `.png` assets).
  - `AMISSU/` (unpacked reference extension used solely as a reference for UPLB AMIS portal authentication and section-fetching patterns).
- **Never** copy minified bundles or compiled assets from `AMISSU/` into the new AMISync build.

## New Build Directory
- Place all new AMISync extension source code, configuration files (`manifest.json`, `package.json`, build configs), and tests inside `./Extension Files/`.

## UI Fidelity
- Match the screens, visual hierarchy, interactive controls, states, and Human-in-the-Loop (HITL) user flows specified in `SPEC.md` (derived directly from `Paper Files/1.1.png`, `Paper Files/1.2.png`, and `Paper Files/2.0.png`).

## Tech Stack
- **Extension Platform:** Chrome Manifest V3 (desktop Google Chrome) with `'wasm-unsafe-eval'` CSP for WebAssembly.
- **Language & UI:** TypeScript, React, and Vite.
- **Optimization Engine:** Client-side Google OR-Tools CP-SAT compiled to WebAssembly (`or-tools-wasm`) executing inside a dedicated Web Worker.
- **Conflict Diagnosis:** Recursive QuickXplain Minimal Unsatisfiable Subset (MUS) extraction in Pure Satisfiability Mode with deterministic natural-language explanation templates.

## Client-Side Constraint
- Keep all portal data extraction/parsing, constraint modeling, CP-SAT optimization, and QuickXplain conflict diagnosis **100% local in the browser**.
- Use **zero external backend servers** and **zero paid APIs** (no remote solver services, no external databases, and no LLM API calls). Persist local state exclusively via `chrome.storage.local`.
- Maintain strictly read-only integration with authenticated UPLB AMIS sessions (no automatic enlistment, enrollment, or AMIS data mutation).

## Execution Rule
- Implement and verify **one milestone at a time** following the phased checklist in Section 9 of `SPEC.md`. Do not advance to the next milestone until the current milestone's deliverables and checks are verified.
