# Decisions

Choices made where the spec ([docs/spec.md](docs/spec.md)) or the build prompt
([docs/build-prompt.md](docs/build-prompt.md)) left room. Newest last. Mark anything a human should
review with **Review**.

| Date | Decision | Why |
| --- | --- | --- |
| 2026-11-13 | Turborepo on a pnpm workspace. Workspaces: `apps/worker`, `apps/web`, `packages/shared`, `e2e`. `migrations/` and `docs/` sit at the root and are not packages | Matches the build prompt's required layout. Turbo caches typecheck, build and test per package |
| 2026-11-13 | Root scripts call `turbo run <task>` for `build`, `dev`, `typecheck`, `test`, `test:e2e`. A package joins a task by defining that script; packages without it are skipped | One entry point for the quality gates the build prompt names |
| 2026-11-13 | `@plinth/shared` is consumed as TypeScript source (`exports` points at `src/index.ts`), with no build step | The Worker (wrangler/esbuild) and the web app (Vite) both bundle TS directly; a build step adds nothing |
| 2026-11-13 | Biome 2.6.6 for lint and format, run once at the root (`pnpm lint`, `pnpm format`), not per package through Turbo. Markdown is excluded | One fast tool, no ESLint/Prettier config to keep in step. Biome's Markdown formatter pads tables to a single width, which makes prose docs unreadable in diffs |
| 2026-11-13 | TypeScript 7.0.2 (the native compiler), strict, with `noUncheckedIndexedAccess`. Shared settings in `tsconfig.base.json` | Current stable release. **Review** if a tool added later needs the TypeScript 6 JS API; drop to 6.0.3 in that case |
| 2026-11-13 | pnpm pinned to 10.27.0 through `packageManager`, the version installed on the dev machine. Node `>=22` | pnpm 12 is current; upgrading is a separate, deliberate step. **Review** |
| 2026-11-13 | Dependency versions pinned exactly, and only releases at least a week old | Reproducible installs and a buffer against compromised fresh releases |
| 2026-11-13 | D1 migrations live in the root `migrations/`; wrangler in `apps/worker` should point `migrations_dir` at `../../migrations` | The build prompt puts `migrations` at the top level |
