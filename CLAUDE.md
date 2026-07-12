# CLAUDE.md

This file is the Claude Code entrypoint for this repository. The full AI/developer guide lives in [AIAGENTREADME.md](AIAGENTREADME.md). Read it before making non-trivial changes.

## Required reading order

1. [AIAGENTREADME.md](AIAGENTREADME.md) — complete project architecture, coding rules, release contract, and development paths.
2. [AICACHE.md](AICACHE.md) — current AI work cache: planned work, completed work, validation, blockers, and handoff notes.
3. Nearest `AGENTS.md` for the files you are editing:
   - [AGENTS.md](AGENTS.md) — root/release/repo rules.
   - [src/AGENTS.md](src/AGENTS.md) — source-tree implementation rules.
4. Relevant docs under [docs/](docs/): architecture, auth, cache, data flow, migration, milestones.

## What this project is

Komari Glassmorphism is a Komari Monitor theme built with Vue 3 + Vite. The release artifact is a Komari-importable zip package, not a generic deployed web app.

Key release facts:

- [komari-theme.json](komari-theme.json) is release input and the only release-version source.
- Do not add a top-level `version` to [package.json](package.json).
- `bun run build` must preserve zip packaging from [vite.config.ts](vite.config.ts).
- Build output must include `dist/` and `komari-theme-Glassmorphism-build-<short-sha>.zip`.
- Zip layout must stay: `komari-theme.json`, `preview.png`, `dist/`.

## Commands

Use `bun` from the repository root:

```bash
bun run dev
bun run lint
bun run build
bun run preview
```

There is currently no test suite. Do not invent `bun test` or Vitest commands unless a real test framework is introduced.

## Architecture rule

New app code follows:

```text
Component -> Composable -> Service -> RequestManager / CacheService -> API / RPC
```

- Components render UI and call composables/services.
- Composables own Vue state/lifecycle.
- Services own business logic.
- Shared limits/settings belong in [src/constants/](src/constants/).
- Low-level API/RPC clients stay in [src/utils/api.ts](src/utils/api.ts) and [src/utils/rpc.ts](src/utils/rpc.ts).
- Generic helpers stay in [src/utils/](src/utils/); do not put new business workflows there.

## AI work cache requirement

For any task that may be interrupted, spans multiple files, or affects architecture/security/release behavior:

1. Add or update an entry in [AICACHE.md](AICACHE.md) before or during implementation.
2. Keep it accurate as work progresses.
3. Before stopping, update it with completed work, validation results, known risks, and next steps.

Do not store secrets, tokens, private passwords, or private server credentials in [AICACHE.md](AICACHE.md).

## Hard safeguards

- Do not reintroduce Naive UI, UnoCSS, SCSS, or `lucide-vue-next`.
- Use `@iconify/vue` for icons.
- Only app global is `window.$message`.
- Keep public home/detail routes public; do not add broad router guards.
- Gate sensitive actions/data paths through verified auth (`appStore.requireLoginPermission()` / auth service).
- Do not parse raw `theme_settings` in components; normalize in [src/stores/app.ts](src/stores/app.ts).
- Do not add ad-hoc caches for provider metadata, history records, or request deduplication.
- Keep `nodeCardSize` default as `compact`; `mini` is optional and must not replace compact behavior.
- Do not rename [komari-theme.json](komari-theme.json), [docs/preview.png](docs/preview.png), or the zip naming pattern.
- Runtime image filenames under [public/images/](public/images/) are code contracts; check helpers before renaming.

For detailed explanations and development paths, use [AIAGENTREADME.md](AIAGENTREADME.md).
