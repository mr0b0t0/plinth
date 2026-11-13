#!/usr/bin/env node
// Seed a local Plinth with a demo user and sample artifacts.
//
//   pnpm dev                      # in another terminal: the Worker on http://app.localhost:8787
//   node scripts/seed.mjs [--origin http://app.localhost:8787] [--persist-to <dir>]
//
// Creates demo@plinth.local and a personal access token directly in the local D1 database (only
// the token's SHA-256 hash is stored), then publishes the samples through the REST API like any
// agent would. Samples that already exist (same title) are skipped, so it is safe to rerun. Each
// run creates a new token and prints it once, for use with an MCP client.
import { execFileSync } from "node:child_process";
import { createHash, randomInt } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workerDir = path.join(root, "apps", "worker");
const wranglerBin = path.join(workerDir, "node_modules", ".bin", "wrangler");

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const origin = (flag("origin") ?? "http://app.localhost:8787").replace(/\/$/, "");
const persistTo = flag("persist-to");
const EMAIL = "demo@plinth.local";

function fail(message) {
  console.error(`seed: ${message}`);
  process.exit(1);
}

// ---------- local D1 ----------

const sql = (v) => (v === null ? "NULL" : `'${String(v).replaceAll("'", "''")}'`);

function d1(statement) {
  if (!existsSync(wranglerBin)) fail("wrangler is not installed. Run `pnpm install` first.");
  const cmd = ["d1", "execute", "DB", "--local", "--json", "--command", statement];
  if (persistTo) cmd.push("--persist-to", path.resolve(persistTo));
  const out = execFileSync(wranglerBin, cmd, {
    cwd: workerDir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
  });
  return JSON.parse(out).at(-1)?.results ?? [];
}

const BASE62 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const LOWER = "abcdefghijklmnopqrstuvwxyz0123456789";
const random = (n, alphabet) =>
  Array.from({ length: n }, () => alphabet[randomInt(alphabet.length)]).join("");

function createUserAndToken() {
  const now = new Date().toISOString();
  const [user] = d1(
    `INSERT INTO users (id, email, name, email_verified_at, is_admin, created_at) ` +
      `VALUES (${sql(random(20, LOWER))}, ${sql(EMAIL)}, 'Demo', ${sql(now)}, 0, ${sql(now)}) ` +
      `ON CONFLICT(email) DO NOTHING; SELECT id FROM users WHERE email = ${sql(EMAIL)};`,
  );
  if (!user?.id) fail(`could not create ${EMAIL}`);
  const token = `plinth_pat_${random(40, BASE62)}`;
  const hash = createHash("sha256").update(token).digest("hex");
  d1(
    `INSERT INTO agent_connections (id, user_id, label, client_type, kind, token_hash, scopes, created_at) ` +
      `VALUES (${sql(random(20, LOWER))}, ${sql(user.id)}, ${sql(`Seed script ${now.slice(0, 16)}`)}, ` +
      `'other', 'token', ${sql(hash)}, 'artifacts:read artifacts:write mentions', ${sql(now)});`,
  );
  return token;
}

// ---------- REST ----------

async function call(token, method, apiPath, body) {
  const res = await fetch(`${origin}/api/v1${apiPath}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) fail(`${method} ${apiPath} -> ${res.status} ${JSON.stringify(data)}`);
  return data;
}

// ---------- samples ----------
// Exhibits: self-contained, no network calls (the content CSP blocks them). Fonts come from Google
// Fonts, which the CSP allows; everything else is inline or an asset of the artifact.

const fonts =
  '<link rel="preconnect" href="https://fonts.googleapis.com">' +
  '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>' +
  '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,600&family=Inter:wght@400;500;600&display=swap">';

const page = (title, body, extraHead = "") => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
${fonts}
${extraHead}
</head>
<body>
${body}
</body>
</html>
`;

const baseStyle = `<style>
  :root { color-scheme: light dark; --ink: #1d2321; --muted: #5d6763; --paper: #f6f5f1; --line: #dcdad3; --accent: #2f7d6d; }
  @media (prefers-color-scheme: dark) { :root { --ink: #e7e6e1; --muted: #a3aaa6; --paper: #191c1b; --line: #343937; --accent: #6cc2ad; } }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--paper); color: var(--ink); font: 16px/1.6 Inter, system-ui, sans-serif; }
  main { max-width: 760px; margin: 0 auto; padding: 56px 24px 80px; }
  h1, h2 { font-family: Fraunces, Georgia, serif; font-weight: 600; letter-spacing: -0.01em; line-height: 1.15; }
  h1 { font-size: clamp(2rem, 5vw, 3rem); margin: 0 0 12px; }
  h2 { font-size: 1.4rem; margin: 40px 0 8px; }
  .kicker { text-transform: uppercase; letter-spacing: 0.12em; font-size: 12px; color: var(--accent); font-weight: 600; }
  .lede { font-size: 1.15rem; color: var(--muted); max-width: 60ch; }
  table { width: 100%; border-collapse: collapse; margin-top: 16px; font-variant-numeric: tabular-nums; }
  th, td { text-align: left; padding: 10px 8px; border-bottom: 1px solid var(--line); }
  th { font-size: 12px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--muted); font-weight: 600; }
  td.num, th.num { text-align: right; }
</style>`;

const surveyRows = [
  ["Alfama", 14, 1.1],
  ["Baixa", 22, 1.4],
  ["Príncipe Real", 17, 1.6],
  ["Cais do Sodré", 19, 1.3],
  ["Campo de Ourique", 11, 1.2],
];
const table = `<table><thead><tr><th>Neighbourhood</th><th class="num">Cafés visited</th><th class="num">Bica, €</th></tr></thead><tbody>${surveyRows
  .map(
    ([n, c, p]) =>
      `<tr><td>${n}</td><td class="num">${c}</td><td class="num">${p.toFixed(2)}</td></tr>`,
  )
  .join("")}</tbody></table>`;

const chart = (() => {
  const w = 640;
  const barH = 28;
  const gap = 14;
  const max = Math.max(...surveyRows.map((r) => r[2]));
  const bars = surveyRows
    .map(([n, , p], i) => {
      const y = i * (barH + gap);
      const len = Math.round((p / max) * (w - 220));
      return `<text x="0" y="${y + 19}" fill="currentColor" font-size="14">${n}</text><rect x="150" y="${y}" width="${len}" height="${barH}" rx="4" fill="var(--accent)"/><text x="${158 + len}" y="${y + 19}" fill="currentColor" font-size="13">€${p.toFixed(2)}</text>`;
    })
    .join("");
  const h = surveyRows.length * (barH + gap);
  return `<svg viewBox="0 0 ${w} ${h}" width="100%" role="img" aria-label="Price of a bica by neighbourhood" style="font-family: Inter, sans-serif; margin-top: 16px">${bars}</svg>`;
})();

const fieldNotes = (withChart) =>
  page(
    "Field notes: a Lisbon coffee survey",
    `${baseStyle}
<main>
  <div class="kicker">Field notes · November 2026</div>
  <h1>What a bica costs in Lisbon</h1>
  <p class="lede">${
    withChart
      ? "Eighty-three cafés, five neighbourhoods. The espresso is cheap everywhere, and cheapest where tourists are fewest."
      : "We visited eighty-three cafés across five neighbourhoods over three weeks and wrote down the price of a bica, the short Lisbon espresso, at each one. Prices were taken at the counter, not the table."
  }</p>
  ${withChart ? `<h2>Average price</h2>${chart}` : ""}
  <h2>By neighbourhood</h2>
  ${table}
  <h2>Method</h2>
  <p>Counter prices only, paid in cash, between 8 and 11 in the morning. Chains were excluded.</p>
</main>`,
  );

const paletteCss = `:root { color-scheme: light dark; --ink: #1b1f1e; --paper: #f4f4f0; --muted: #626a67; }
@media (prefers-color-scheme: dark) { :root { --ink: #e9e8e3; --paper: #161918; --muted: #a0a7a4; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--paper); color: var(--ink); font: 15px/1.5 Inter, system-ui, sans-serif; }
main { max-width: 960px; margin: 0 auto; padding: 56px 24px; }
h1 { font-family: Fraunces, Georgia, serif; font-weight: 600; font-size: clamp(2rem, 5vw, 2.8rem); margin: 0 0 8px; }
p.lede { color: var(--muted); max-width: 56ch; margin: 0 0 32px; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 16px; }
.swatch { border-radius: 10px; overflow: hidden; border: 1px solid rgba(127, 127, 127, 0.25); background: var(--paper); }
.chip { height: 110px; }
.meta { padding: 10px 12px; }
.meta strong { display: block; font-weight: 600; }
.meta code { font-family: ui-monospace, "JetBrains Mono", monospace; font-size: 12px; color: var(--muted); }
`;

const swatches = [
  ["Verdigris", "#2f7d6d"],
  ["Patina", "#5fa894"],
  ["Lichen", "#a7c4b5"],
  ["Bronze", "#8a5a2b"],
  ["Plaster", "#e8e4da"],
  ["Slate", "#3d4846"],
  ["Ink", "#1b1f1e"],
  ["Ochre", "#c99a3c"],
];

const palette = page(
  "Palette study: weathered bronze",
  `<main>
  <h1>Weathered bronze</h1>
  <p class="lede">A palette taken from a park statue after fifty winters: the green of oxidised copper, the brown of the metal underneath, and the stone of the plinth it stands on.</p>
  <div class="grid">
    ${swatches
      .map(
        ([name, hex]) =>
          `<div class="swatch"><div class="chip" style="background:${hex}"></div><div class="meta"><strong>${name}</strong><code>${hex}</code></div></div>`,
      )
      .join("\n    ")}
  </div>
</main>`,
  '<link rel="stylesheet" href="styles.css">',
);

const books = [
  [
    "The Rings of Saturn",
    "W. G. Sebald",
    "A walk along the Suffolk coast that keeps wandering off the map.",
  ],
  [
    "Pilgrim at Tinker Creek",
    "Annie Dillard",
    "One year of paying very close attention to a creek.",
  ],
  ["The Peregrine", "J. A. Baker", "Ten winters following falcons, written like a fever."],
  ["Invisible Cities", "Italo Calvino", "Marco Polo describes fifty-five cities, or maybe one."],
];

const readingList = page(
  "Reading list, winter 2026",
  `${baseStyle}
<style>
  ol { list-style: none; padding: 0; margin: 32px 0 0; counter-reset: book; }
  li { counter-increment: book; display: grid; grid-template-columns: 48px 1fr; gap: 4px 16px; padding: 20px 0; border-top: 1px solid var(--line); }
  li::before { content: counter(book, decimal-leading-zero); font-family: Fraunces, serif; font-size: 1.6rem; color: var(--accent); grid-row: span 3; }
  .title { font-family: Fraunces, serif; font-size: 1.25rem; font-weight: 600; }
  .author { color: var(--muted); font-size: 14px; }
</style>
<main>
  <div class="kicker">Shared with friends</div>
  <h1>Reading list, winter 2026</h1>
  <p class="lede">Four books for long evenings. All of them are about looking at one place for a long time.</p>
  <ol>
    ${books.map(([t, a, d]) => `<li><span class="title">${t}</span><span class="author">${a}</span><span>${d}</span></li>`).join("\n    ")}
  </ol>
</main>`,
);

const tipSplitter = page(
  "Tip splitter",
  `${baseStyle}
<style>
  form { display: grid; gap: 20px; margin-top: 32px; max-width: 420px; }
  label { display: grid; gap: 6px; font-weight: 500; }
  input { font: inherit; padding: 10px 12px; border-radius: 8px; border: 1px solid var(--line); background: transparent; color: inherit; }
  input:focus { outline: 2px solid var(--accent); outline-offset: 1px; }
  output { display: block; font-family: Fraunces, serif; font-size: 2.6rem; color: var(--accent); }
  .row { display: flex; justify-content: space-between; color: var(--muted); }
</style>
<main>
  <div class="kicker">Small tools</div>
  <h1>Tip splitter</h1>
  <p class="lede">Everything runs in the page. Nothing is sent anywhere.</p>
  <form id="f" oninput="calc()">
    <label>Bill (€) <input id="bill" type="number" min="0" step="0.01" value="64.50"></label>
    <label>Tip (%) <input id="tip" type="number" min="0" max="100" step="1" value="10"></label>
    <label>People <input id="people" type="number" min="1" step="1" value="3"></label>
    <div>
      <div class="row"><span>Each pays</span><span id="tipline"></span></div>
      <output id="each" aria-live="polite"></output>
    </div>
  </form>
</main>
<script>
  function calc() {
    var bill = parseFloat(document.getElementById("bill").value) || 0;
    var tip = parseFloat(document.getElementById("tip").value) || 0;
    var people = Math.max(1, parseInt(document.getElementById("people").value, 10) || 1);
    var total = bill * (1 + tip / 100);
    document.getElementById("each").textContent = "€" + (total / people).toFixed(2);
    document.getElementById("tipline").textContent = "total €" + total.toFixed(2);
  }
  calc();
</script>`,
);

const SAMPLES = [
  {
    title: "Field notes: a Lisbon coffee survey",
    visibility: "unlisted",
    html: fieldNotes(false),
    update: { html: fieldNotes(true), note: "Add the price chart and tighten the summary" },
  },
  {
    title: "Palette study: weathered bronze",
    visibility: "password",
    password: "plinth-demo",
    html: palette,
    assets: [{ path: "styles.css", content: paletteCss, content_type: "text/css" }],
  },
  {
    title: "Reading list, winter 2026",
    visibility: "allowlist",
    emails: ["friend@plinth.local"],
    html: readingList,
  },
  { title: "Tip splitter", visibility: "unlisted", html: tipSplitter },
];

// ---------- run ----------

const health = await fetch(`${origin}/healthz`).catch(() => null);
if (!health?.ok) fail(`No Worker at ${origin}. Start it with \`pnpm dev\` first.`);

console.log(`Seeding ${origin} as ${EMAIL}`);
const token = createUserAndToken();
const existing = new Set((await call(token, "GET", "/artifacts")).items.map((a) => a.title));

for (const s of SAMPLES) {
  if (existing.has(s.title)) {
    console.log(`  skip     ${s.title} (exists)`);
    continue;
  }
  const { update, ...input } = s;
  const p = await call(token, "POST", "/artifacts", input);
  let version = p.version;
  if (update) version = (await call(token, "PUT", `/artifacts/${p.id}`, update)).version;
  console.log(`  publish  ${s.title}  [${s.visibility}, v${version}]  ${p.url}`);
}

console.log(
  "\nSign in at",
  `${origin}/login`,
  `as ${EMAIL} (the code is printed in the wrangler dev log).`,
);
console.log(
  'The password artifact\'s password is "plinth-demo"; the allowlist has friend@plinth.local.',
);
console.log("\nPersonal access token for an MCP client (shown once):");
console.log(`  ${token}`);
console.log(`  MCP URL: ${origin}/mcp`);
