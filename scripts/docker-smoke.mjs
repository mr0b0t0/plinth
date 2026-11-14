#!/usr/bin/env node
// Smoke test for the Docker image (docs/docker.md): build it, run it in localhost mode on a free
// port with a fresh volume, then use it the way its owner and an agent do: sign in with the code
// from `docker logs`, connect an agent with OAuth, publish over /mcp and open the artifact on its
// own *.localhost host. Then restart (the data and secrets survive, setup does not rerun) and
// stop (cleanly). Removes its container and volume. Exit code 0 when every check passes.
//
//   pnpm test:docker
//   PLINTH_DOCKER_IMAGE=ghcr.io/mr0b0t0/plinth:0.1.0 pnpm test:docker   # test a built image
//   PLINTH_DOCKER_PLATFORM=linux/amd64 pnpm test:docker                 # another platform
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  appClient,
  connectAgent,
  getWithHost,
  publishArtifact,
  signIn,
} from "../packages/cli/scripts/agent-flow.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { PLINTH_DOCKER_IMAGE: givenImage, PLINTH_DOCKER_PLATFORM: platform } = process.env;
const image = givenImage || "plinth:smoke";
const platformArgs = platform ? ["--platform", platform] : [];
const EMAIL = "me@example.com";
const name = `plinth-smoke-${randomBytes(4).toString("hex")}`;
const volume = `${name}-data`;

const docker = (...args) => spawnSync("docker", args, { encoding: "utf8" });
function cleanup() {
  docker("rm", "-f", name);
  docker("volume", "rm", "-f", volume);
}
process.on("exit", cleanup);
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => process.exit(130));

const results = [];
async function check(label, fn) {
  try {
    const detail = await fn();
    results.push(true);
    console.log(`PASS  ${label}${detail ? ` — ${detail}` : ""}`);
  } catch (e) {
    results.push(false);
    console.log(`FAIL  ${label} — ${e.message}`);
  }
}
const assert = (cond, msg) => {
  if (!cond) throw new Error(msg);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (docker("version", "--format", "{{.Server.Version}}").status !== 0) {
  console.error("docker-smoke: Docker is not running");
  process.exit(2);
}

// ---------- the image ----------
if (!givenImage) {
  console.log(`> docker build -t ${image} ${platform ? `--platform ${platform} ` : ""}.`);
  const b = spawnSync("docker", ["build", ...platformArgs, "-t", image, root], {
    stdio: "inherit",
  });
  if (b.status !== 0) {
    console.error("docker-smoke: the image build failed");
    process.exit(1);
  }
}

/** A free TCP port on 127.0.0.1. The app's host includes the port, so host and container match. */
const port = await new Promise((resolve, reject) => {
  const s = net.createServer();
  s.on("error", reject);
  s.listen(0, "127.0.0.1", () => {
    const p = s.address().port;
    s.close(() => resolve(p));
  });
});
const APP = `http://127.0.0.1:${port}`;
/** The container's stdout and stderr in the order it wrote them (one pipe for both). */
const logs = () =>
  spawnSync("sh", ["-c", 'exec docker logs "$0" 2>&1', name], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  }).stdout;
const state = () =>
  docker("inspect", "--format", "{{.State.Status}} {{.State.Health.Status}}", name).stdout.trim();

async function waitHealthy(seconds) {
  for (let i = 0; i < seconds; i++) {
    const s = state();
    if (s === "running healthy") return i;
    if (s.startsWith("exited") || s.startsWith("dead"))
      throw new Error(`container ${s}:\n${logs()}`);
    await sleep(1000);
  }
  throw new Error(`not healthy after ${seconds}s (${state()}):\n${logs()}`);
}

await check("the image carries the OCI labels and runs as a non-root user", () => {
  const r = docker("image", "inspect", "--format", "{{json .Config}}", image);
  assert(r.status === 0, r.stderr);
  const cfg = JSON.parse(r.stdout);
  const labels = cfg.Labels ?? {};
  assert(
    labels["org.opencontainers.image.source"] === "https://github.com/mr0b0t0/plinth",
    "source label",
  );
  assert(labels["org.opencontainers.image.licenses"] === "MIT", "licence label");
  assert(cfg.User && cfg.User !== "root" && cfg.User !== "0", `user ${cfg.User}`);
  assert(Object.keys(cfg.ExposedPorts ?? {}).includes("8788/tcp"), "port 8788 not exposed");
  assert(Object.keys(cfg.Volumes ?? {}).includes("/data"), "no /data volume");
  const size = docker("image", "inspect", "--format", "{{.Size}}", image).stdout.trim();
  return `user ${cfg.User}, ${Math.round(Number(size) / 1e6)} MB`;
});

// ---------- run it ----------
const run = docker(
  "run",
  "-d",
  ...platformArgs,
  "--name",
  name,
  "-e",
  `PLINTH_EMAIL=${EMAIL}`,
  "-e",
  `PLINTH_PORT=${port}`,
  "-p",
  `127.0.0.1:${port}:${port}`,
  "-v",
  `${volume}:/data`,
  image,
);
if (run.status !== 0) {
  console.error(`docker-smoke: docker run failed:\n${run.stderr}`);
  process.exit(1);
}

await check("the container sets itself up and becomes healthy", async () => {
  const s = await waitHealthy(180);
  assert(logs().includes("first start: setting up (localhost)"), "no first-start setup in the log");
  return `healthy after ${s}s`;
});

await check("the Worker runs as uid 1000, listening on 0.0.0.0 inside the container", () => {
  const id = docker("exec", name, "id", "-u").stdout.trim();
  assert(id === "1000", `uid ${id}`);
  assert(logs().includes(`Starting the Worker on http://0.0.0.0:${port}`), "listen address");
});

await check("the app answers on 127.0.0.1 with artifacts on *.localhost", async () => {
  const h = await (await fetch(`${APP}/healthz`)).json();
  assert(h.ok === true, JSON.stringify(h));
  const c = await (await fetch(`${APP}/api/v1/config`)).json();
  assert(c.content_host === `localhost:${port}`, `content_host ${c.content_host}`);
  assert(c.content_isolation === "origin", `isolation ${c.content_isolation}`);
});

const app = appClient(APP);
await check("the owner signs in with the code from docker logs", async () => {
  await signIn(app, EMAIL, logs);
});

let accessToken = null;
await check("an agent connects with OAuth: registration, PKCE, consent, token", async () => {
  accessToken = await connectAgent(app, APP, "Docker smoke");
});

let published = null;
await check("the agent publishes over /mcp with its OAuth access token", async () => {
  published = await publishArtifact(APP, accessToken, "Docker smoke");
  return published.slug;
});

const artifactHost = () => `${published.id}.localhost:${port}`;
await check("the artifact's own *.localhost host answers with the content CSP", async () => {
  const r = await getWithHost(port, artifactHost());
  assert(r.status !== 404, "artifact host not routed");
  const csp = String(r.headers["content-security-policy"] ?? "");
  assert(csp.includes("default-src 'none'"), `CSP: ${csp}`);
  return `HTTP ${r.status}`;
});

await check("secrets stay in the volume (mode 600) and out of the logs", () => {
  const vars = docker("exec", name, "cat", "/data/plinth/.dev.vars").stdout;
  const secrets = [...vars.matchAll(/^(SESSION_SECRET|TOKEN_SIGNING_KEY)=(.+)$/gm)];
  assert(secrets.length === 2, "SESSION_SECRET and TOKEN_SIGNING_KEY not generated");
  const text = logs();
  for (const [, key, v] of secrets) assert(!text.includes(v.trim()), `${key} appears in the logs`);
  const modes = docker(
    "exec",
    name,
    "stat",
    "-c",
    "%a %n",
    "/data/plinth",
    "/data/plinth/.dev.vars",
  );
  assert(/^700 \/data\/plinth$/m.test(modes.stdout), modes.stdout);
  assert(/^600 \/data\/plinth\/.dev.vars$/m.test(modes.stdout), modes.stdout);
});

await check("`plinth connect` in the container prints the local /mcp endpoint", () => {
  const r = docker("exec", name, "plinth", "connect");
  assert(r.status === 0, r.stderr);
  assert(r.stdout.includes(`${APP}/mcp`), r.stdout);
});

// ---------- restart: state survives, setup does not run again ----------
await check("a restart keeps the data and skips setup", async () => {
  const before = logs().length;
  const r = docker("restart", name);
  assert(r.status === 0, r.stderr);
  await waitHealthy(120);
  const after = logs().slice(before);
  assert(after.includes("settings unchanged"), `setup ran again:\n${after}`);
  const a = await getWithHost(port, artifactHost());
  assert(a.status !== 404, "the artifact is gone after a restart");
  const list = await app("/api/v1/artifacts");
  assert(list.status === 200, `the owner's session did not survive: ${list.status}`);
  assert((await list.text()).includes(published.id), "the artifact is not in the owner's list");
});

await check("docker stop shuts it down cleanly", () => {
  const r = docker("stop", name);
  assert(r.status === 0, r.stderr);
  const code = docker("inspect", "--format", "{{.State.ExitCode}}", name).stdout.trim();
  assert(code === "0", `exit code ${code}`);
});

const passed = results.filter(Boolean).length;
console.log(
  `${passed}/${results.length} checks passed (${image}${platform ? `, ${platform}` : ""})`,
);
process.exit(passed === results.length ? 0 : 1);
