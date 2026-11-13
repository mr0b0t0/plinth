// Starts the Worker for Playwright (webServer.command). Run with Node 22.18+ (type stripping).
//  1. Builds the web app if apps/web/dist/index.html is missing.
//  2. Wipes e2e/.wrangler-state and applies the D1 migrations into it.
//  3. Runs `wrangler dev` on port 8787 with the development vars and throwaway secrets, passed
//     with --var so a developer's own apps/worker/.dev.vars cannot change the test setup.
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import { ROOT, STATE_DIR, WORKER_DIR, WRANGLER } from "./paths.ts";

const PORT = Number(process.env.PLINTH_E2E_PORT ?? 8787);

export const DEV_VARS: Record<string, string> = {
  ENVIRONMENT: "development",
  APP_HOST: `app.localhost:${PORT}`,
  CONTENT_HOST: `content.localhost:${PORT}`,
  PUBLIC_SCHEME: "http",
  DEV_OUTBOX: "true",
  // Many sign-ins from one address; per-email limits still apply. Honoured only in development.
  DEV_IGNORE_CLIENT_IP: "true",
  EMAIL_PROVIDER: "console",
  SINGLE_USER_MODE: "false",
  ADMIN_EMAIL: "admin@plinth.local",
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

rmSync(STATE_DIR, { recursive: true, force: true });
run(
  WRANGLER,
  ["d1", "migrations", "apply", "DB", "--local", "--persist-to", STATE_DIR],
  WORKER_DIR,
);

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
    STATE_DIR,
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
