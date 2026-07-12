# AGENTS.md

Repo guide for `komari-theme-Glassmorphism`.

## Snapshot

- Updated: 2026-07-12
- Branch: `main`
- App: Vue 3 + Vite + reka-ui + Tailwind CSS v4 theme for Komari Monitor
- Package manager: `bun` (>= 1.2)
- Theme manifest: `komari-theme.json`

## What this repo is

- Builds a Komari theme, not a generic web app
- Release artifact is a zip package Komari can import
- Runtime app code lives under `src/`
- Runtime static assets include `public/images/`
- Release preview image is `docs/preview.png`

## Root structure

- `src/` app source
- `public/images/` runtime image contract, especially flags and logos
- `.github/` release workflow
- `docs/preview.png` release preview image
- `komari-theme.json` theme manifest consumed by the zip build
- `vite.config.ts` build, chunking, zip packaging
- `package.json` root commands and pinned dependency versions
- `bun.lock` resolved lockfile (managed by bun)

## Root commands

Run from repo root only.

```bash
bun run dev
bun run build
bun run preview
bun run lint
```

Notes:

- `bun run build` runs type check plus production build
- `bun run lint` runs eslint with `--fix --cache`
- There is no test suite in this repository
- Do not invent `bun test` or Vitest commands here

## Build and release contract

`bun run build` must preserve the Komari packaging flow defined in `vite.config.ts`.

Expected output:

- `dist/`
- `komari-theme-Glassmorphism-build-<sha>.zip`

Zip contents:

- `dist/`
- `komari-theme.json`
- `preview.png`

Current source of packaged preview:

- `docs/preview.png` on disk
- renamed to `preview.png` inside the zip

Do not change zip naming, manifest filename, or preview filename without updating the real build contract.

## Project-specific safeguards

- `komari-theme.json` is the **single release-version source**. `package.json` intentionally has no top-level `version`; do not re-add it just to satisfy tooling. `vite.config.ts` injects `__BUILD_VERSION__` from `komari-theme.json`.
- GitHub release automation must read `komari-theme.json.version` only. After changing release/version workflow logic or bumping the theme version, verify the Actions run and the GitHub Release tag/assets, not just local `bun run build`.
- Default node card size must remain `compact` in both `komari-theme.json` and `src/stores/app.ts`. `mini` is an optional high-density mode; do not repurpose or shrink the existing `compact` behavior.
- Realtime node metrics must update without a browser refresh. When touching `src/stores/nodes.ts`, `src/utils/init.ts`, or card/general-card metric rendering, verify polling/WebSocket updates change `net_in`, `net_out`, CPU, etc. in the running app.
- `src/stores/nodes.ts` keeps a UUID index for fast updates. That index must point at Vue-reactive node objects from `nodes.value`, not the raw object before insertion, or live updates mutate non-reactive data and the UI goes stale.
- README screenshots should be captured from a built app driven by a realistic mocked Komari API; include enough different surfaces (home, mini cards, list, detail, mobile) when screenshots are requested.

## Release workflow facts

Source of truth: `.github/workflows/release-on-version-bump.yml`

Release automation on `main`:

1. Detects `komari-theme.json.version`
2. Installs with `bun install --frozen-lockfile`
3. Runs `bun run build` when the theme version changed or the release tag is missing
4. Creates/updates a GitHub Release and uploads `komari-theme-Glassmorphism-build*.zip`

There is no test suite in CI; do not add one without a concrete need.

## v3 architecture orientation

- v3 app code should follow `Component -> Composable -> Service -> RequestManager / CacheService -> API / RPC`.
- Detailed source rules live in `src/AGENTS.md`; root guidance stays focused on repo contracts, packaging, and where to look.
- Architecture docs:
  - `docs/Architecture.md` — v3 layering and ownership rules
  - `docs/DataFlow.md` — node/provider/history/snapshot data paths
  - `docs/Auth.md` — verified auth and private feature gates
  - `docs/Cache.md` — shared cache lifecycle rules
  - `docs/Migration-v3.md` — migration notes and behavior changes
  - `docs/Milestones-v3.md` — M2-M6 milestone acceptance scope
- New business logic belongs under `src/services/`; shared limits/timings/security settings belong under `src/constants/`; `src/utils/` should remain helper-focused.

## Where to look

- Start at `package.json` for root commands
- Check `vite.config.ts` for build behavior, global constants, and zip packaging
- Check `komari-theme.json` for theme metadata and managed configuration schema
- Check `src/` for app behavior
- Check `public/images/` when code references image filenames directly
- Check `.github/workflows/release-on-version-bump.yml` for release automation expectations

Contributor density, useful for triage:

- `src/components/` is a dense UI change area
- `src/services/` is the v3 business/infrastructure logic area
- `src/constants/` is the v3 shared limits/timings/security configuration area
- `src/utils/` is a helper area; avoid adding new business logic there
- `src/stores/` is central state, usually affected by cross-cutting changes

## Conventions seen in this repo

- Use `bun`, not pnpm/npm/yarn
- Dependency versions are declared directly in `package.json`; add new ones with `bun add` / `bun add -d`
- Keep root guidance focused on build, packaging, manifest, and repo structure
- Preserve the `@` alias to `src` defined in `vite.config.ts`
- Treat `komari-theme.json` as release input, not optional metadata
- Treat `docs/preview.png` as release input, not just documentation art
- Respect existing generated outputs and naming patterns, especially `komari-theme-Glassmorphism-build-<sha>.zip`
- Root verification is lint plus build, not tests
- UI is built on `reka-ui` + Tailwind CSS v4 (shadcn-vue style under `src/components/ui/`). Do **not** reintroduce Naive UI, UnoCSS, or SCSS — they have been removed.

## Repo grounded anti-patterns

- Do not rename `komari-theme.json`
- Do not move or rename `docs/preview.png` casually
- Do not rename files under `public/images/flags/` or `public/images/logo/` without checking code references in `src`
- Do not change asset path conventions like `/images/flags/<code>.svg` or `/images/logo/...` blindly
- Do not add detailed app architecture rules here that belong in `src/AGENTS.md`
- Do not bypass v3 service/cache/request layers by adding business logic directly to components or generic utils
- Keep workflow-specific details in `.github/` docs if a scoped guide is added later; keep public image asset naming details in `public/images/` docs if a scoped guide is added later

## Child guides

For local rules, defer to the nearest child guide:

- `src/AGENTS.md` for app code, components, stores, router, services, constants, utilities, and v3 layering rules

If additional scoped guides are added later, the nearest child guide overrides this root file for its subtree.
