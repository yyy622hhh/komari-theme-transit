# AGENTS.md

Root-scope development guide for `komari-theme-transit`.

## Snapshot

- Updated: 2026-08-18
- Branch: `main`
- App: Vue 3 + Vite + reka-ui + Tailwind CSS v4 theme for Komari Monitor
- Package manager: `bun` 1.3.14 with a committed lockfile
- Theme manifest and version source: [komari-theme.json](komari-theme.json)

## Required workflow for agents

1. Check the nearest scoped `AGENTS.md`; [src/AGENTS.md](src/AGENTS.md) overrides this file for app source.
2. Before broad edits, identify the milestone class:
   - M2 performance only
   - M3 security/permissions only
   - M4 UI/UX only
   - M5 new feature
   - M6 docs/tests/DX
3. Validate with `bun run lint:check`, `bun run type-check` and `bun run build-only`; UI changes also run `bun run test:visual`.
4. Release-related changes also run `bun run build` and `bun run audit:release`.
5. Use [CONTRIBUTING.md](CONTRIBUTING.md) for the public contribution and release checklist.

## What this repo builds

This repository builds a Komari theme package, not a generic deployed web app.

Release contract:

- `bun run build` must output `dist/` and `komari-theme-Transit-build-<short-sha>.zip`.
- Zip layout must stay: `komari-theme.json`, `preview.png`, `dist/`.
- Packaged `preview.png` comes from [docs/preview.png](docs/preview.png).
- Do not rename [komari-theme.json](komari-theme.json), [docs/preview.png](docs/preview.png), or the zip pattern.

## Commands

Run from repo root only:

```bash
bun run dev
bun run lint
bun run lint:check
bun run type-check
bun run test:visual
bun run build
bun run preview
```

## Root map

- [CONTRIBUTING.md](CONTRIBUTING.md) — contribution workflow, validation and release rules.
- [SECURITY.md](SECURITY.md) — supported versions and private reporting path.
- [src/](src/) — Vue app source.
- [src/AGENTS.md](src/AGENTS.md) — source-tree agent rules.
- [docs/](docs/) — architecture, auth, cache, data flow, migration, milestones.
- [public/images/](public/images/) — runtime image contract.
- [.github/workflows/release-on-version-bump.yml](.github/workflows/release-on-version-bump.yml) — release automation.
- [vite.config.ts](vite.config.ts) — Vite config, build constants, manual chunks, zip packaging.
- [package.json](package.json) — bun scripts and dependencies; intentionally no top-level `version`.

## Architecture anchor

New app code must follow:

```text
Component -> Composable -> Service -> RequestManager / CacheService -> API / RPC
```

Detailed source rules are in [src/AGENTS.md](src/AGENTS.md); architecture details live under [docs/](docs/).

Quick placement guide:

- UI and view orchestration: `src/components/`, `src/views/`
- Vue lifecycle/reactive glue: `src/composables/`
- Business/infrastructure logic: `src/services/`
- Shared constants: `src/constants/`
- Pure helpers: `src/utils/`
- Global app state: `src/stores/`
- Low-level transport: `src/utils/api.ts`, `src/utils/rpc.ts`, `src/utils/init.ts`

## Safeguards

- [komari-theme.json](komari-theme.json) is the only release-version source; do not add `package.json.version`.
- Default node card size must remain `compact`; `mini` is optional.
- Realtime node metrics must update without page refresh; node indexes must point to Vue-reactive node objects.
- Public home/detail routes stay public; sensitive actions/data paths perform permission checks instead of router guards.
- Do not bypass service/cache/request layers with component-local business logic.
- Do not reintroduce Naive UI, UnoCSS, SCSS, `lucide-vue-next`, or extra icon component packages.
- Runtime filenames under [public/images/](public/images/) are code contracts.
- GitHub Release verification is required after release workflow or version changes; local build success alone is not enough.

## Child guides

- [src/AGENTS.md](src/AGENTS.md) applies to `/src` and overrides this file for app code.
- If future scoped guides are added, the nearest guide wins.
