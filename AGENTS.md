# AGENTS.md

Root-scope guide for AI agents working in `komari-theme-Glassmorphism`.

For the complete AI/developer manual, read [AIAGENTREADME.md](AIAGENTREADME.md). For persistent task handoff and progress tracking, read and update [AICACHE.md](AICACHE.md).

## Snapshot

- Updated: 2026-07-12
- Branch: `main`
- App: Vue 3 + Vite + reka-ui + Tailwind CSS v4 theme for Komari Monitor
- Package manager: `bun` >= 1.2
- Theme manifest and version source: [komari-theme.json](komari-theme.json)

## Required workflow for agents

1. Read [AIAGENTREADME.md](AIAGENTREADME.md).
2. Read [AICACHE.md](AICACHE.md) and preserve/update useful handoff notes.
3. Check the nearest scoped `AGENTS.md`; [src/AGENTS.md](src/AGENTS.md) overrides this file for app source.
4. Before broad edits, identify the milestone class:
   - M2 performance only
   - M3 security/permissions only
   - M4 UI/UX only
   - M5 new feature
   - M6 docs/tests/DX
5. For multi-file or interruptible work, record plan/progress/results in [AICACHE.md](AICACHE.md).
6. Validate with `bun run lint` and `bun run build` unless the change is docs-only or you explicitly record why validation was skipped.

## What this repo builds

This repository builds a Komari theme package, not a generic deployed web app.

Release contract:

- `bun run build` must output `dist/` and `komari-theme-Glassmorphism-build-<short-sha>.zip`.
- Zip layout must stay: `komari-theme.json`, `preview.png`, `dist/`.
- Packaged `preview.png` comes from [docs/preview.png](docs/preview.png).
- Do not rename [komari-theme.json](komari-theme.json), [docs/preview.png](docs/preview.png), or the zip pattern.

## Commands

Run from repo root only:

```bash
bun run dev
bun run lint
bun run build
bun run preview
```

There is no test suite. Do not invent `bun test` / Vitest commands.

## Root map

- [AIAGENTREADME.md](AIAGENTREADME.md) — full AI/developer guide, architecture, development paths.
- [AICACHE.md](AICACHE.md) — persistent AI work cache and handoff log.
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

Detailed rules are in [AIAGENTREADME.md](AIAGENTREADME.md) and [src/AGENTS.md](src/AGENTS.md).

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
