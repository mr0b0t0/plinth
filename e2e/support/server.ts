// Starts the Worker for Playwright (webServer.command). Run with Node 22.18+ (type stripping).
//  1. Builds the web app if apps/web/dist/index.html is missing.
//  2. Wipes this server's state directory (e2e/.wrangler-state) and applies the D1 migrations.
//  3. Runs `wrangler dev` on PLINTH_E2E_PORT (default 8787) with apps/worker/wrangler.jsonc (its
//     bindings, the live-rooms Durable Object included), the development vars and throwaway
//     secrets, passed with --var so a developer's own apps/worker/.dev.vars cannot change the test
//     setup.
// With PLINTH_E2E_CONTENT_ISOLATION=opaque it is the second Worker, the one the "opaque" Playwright
// project uses: CONTENT_ISOLATION=opaque, with its own state directory. With PLINTH_E2E_ROOMS=false
// it is the "solo" project's Worker: no live rooms, so editing on the page is solo.
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import { ROOT, STATE_DIR, WORKER_DIR, WRANGLER } from "./paths.ts";

const PORT = Number(process.env.PLINTH_E2E_PORT ?? 8787);
const ISOLATION = process.env.PLINTH_E2E_CONTENT_ISOLATION === "opaque" ? "opaque" : "origin";
const ROOMS = process.env.PLINTH_E2E_ROOMS !== "false";
const STATE =
  ISOLATION === "opaque" ? `${STATE_DIR}-opaque` : ROOMS ? STATE_DIR : `${STATE_DIR}-solo`;

export const DEV_VARS: Record<string, string> = {
  ENVIRONMENT: "development",
  APP_HOST: `app.localhost:${PORT}`,
  CONTENT_HOST: `content.localhost:${PORT}`,
  PUBLIC_SCHEME: "http",
  CONTENT_ISOLATION: ISOLATION,
  DEV_OUTBOX: "true",
  // Many sign-ins from one address; per-email limits still apply. Honoured only in development.
  DEV_IGNORE_CLIENT_IP: "true",
  // POST /__dev/seed for test setup (users, tokens, sessions). Development only.
  DEV_SEED: "true",
  EMAIL_PROVIDER: "console",
  SINGLE_USER_MODE: "false",
  ADMIN_EMAIL: "admin@plinth.local",
  // An operator, so the terms and privacy notice are published.
  OPERATOR_NAME: "Example Operator, Lda.",
  OPERATOR_EMAIL: "hello@operator.example",
  OPERATOR_ADDRESS: "Rua Exemplo 1, 1000-001 Lisboa, Portugal",
  OPERATOR_REGISTRATION: "VAT PT000000000",
  // Live rooms and on-page doc editing (#36), on whatever a developer's .dev.vars says. The ROOMS
  // Durable Object binding and its rooms-v1 migration come from apps/worker/wrangler.jsonc, which
  // `wrangler dev` reads in WORKER_DIR. On the opaque server they have no effect: rooms need
  // origin isolation.
  ALLOW_ROOMS: ROOMS ? "true" : "false",
  ALLOW_LIVE_EDITING: "true",
  // Live views (docs/spec.md "Live views"): pushed versions and data changes over the app's watch
  // socket, on both servers (it needs only the ROOMS binding, not origin isolation).
  ALLOW_LIVE_VIEWS: "true",
  // Category sharing (docs/spec.md "Category sharing and personal categories"), on by default.
  ALLOW_CATEGORY_SHARING: "true",
  // Following the presenter in a deck (docs/spec.md "Slides"), on by default. On the opaque server
  // it has no effect: it runs over live rooms, which need origin isolation.
  ALLOW_SLIDES_FOLLOW: "true",
  // Design export's instance and per-artifact hourly caps, at their defaults. The local Worker has
  // no Browser Rendering binding, so exports stay off (typed-design-export.spec.ts).
  DESIGN_EXPORTS_PER_INSTANCE_PER_HOUR: "120",
  DESIGN_EXPORTS_PER_ARTIFACT_PER_HOUR: "20",
  // Fresh for every run; never committed, never reused.
  SESSION_SECRET: randomBytes(48).toString("base64url"),
  TOKEN_SIGNING_KEY: randomBytes(48).toString("base64url"),
};

function run(cmd: string, args: string[], cwd: string): void {
  const r = spawnSync(cmd, args, { cwd, stdio: ["ignore", "inherit", "inherit"] });
  if (r.status !== 0) {
    console.error(`e2e server: ${cmd} ${args.join(" ")} failed (${r.status ?? r.error})`);
    process.exit(1);
  }
}

if (!existsSync(path.join(ROOT, "apps", "web", "dist", "index.html"))) {
  console.log("e2e server: building the web app");
  run("pnpm", ["--filter", "@plinth/web", "build"], ROOT);
}

rmSync(STATE, { recursive: true, force: true });
run(WRANGLER, ["d1", "migrations", "apply", "DB", "--local", "--persist-to", STATE], WORKER_DIR);

const vars = Object.entries(DEV_VARS).flatMap(([k, v]) => ["--var", `${k}:${v}`]);
const child: ChildProcess = spawn(
  WRANGLER,
  [
    "dev",
    "--port",
    String(PORT),
    "--inspector-port",
    String(PORT + 1000),
    "--persist-to",
    STATE,
    "--show-interactive-dev-session=false",
    "--log-level",
    "warn",
    ...vars,
  ],
  { cwd: WORKER_DIR, stdio: ["ignore", "inherit", "inherit"] },
);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => child.kill(signal));
}
child.on("exit", (code) => process.exit(code ?? 0));
