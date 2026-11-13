// Accounts and dashboard: sign-in (code and magic link), the dashboard, connections and tokens,
// the OAuth consent screen, and per-artifact settings. Runs in the light, dark and mobile projects.
import { createHash, randomBytes } from "node:crypto";
import { expect, type Page, test } from "@playwright/test";
import {
  APP_ORIGIN,
  apiGet,
  apiPut,
  newApiContext,
  publishArtifact,
  uniqueEmail,
} from "../support/api.ts";
import { signIn } from "../support/auth.ts";
import { seedSession as seedContextSession } from "../support/db.ts";
import { latestCode, latestLink } from "../support/mail.ts";
import { mcpClient, tool } from "../support/mcp.ts";
import { seedToken } from "../support/tokens.ts";

const HTML = (h: string) => `<!doctype html><html><body><h1>${h}</h1></body></html>`;
const b64url = (b: Buffer) => b.toString("base64url");

function pkce() {
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

/** Register a public OAuth client with a loopback redirect URI, the way MCP clients do. */
async function registerClient(page: Page, name: string, redirectUri: string): Promise<string> {
  const res = await page.request.post("/oauth/register", {
    data: {
      client_name: name,
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    },
  });
  expect(res.status()).toBe(201);
  return ((await res.json()) as { client_id: string }).client_id;
}

function authorizeUrl(clientId: string, redirectUri: string, challenge: string, state: string) {
  const q = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
    scope: "artifacts:read artifacts:write mentions",
    resource: `${APP_ORIGIN}/mcp`,
  });
  return `/oauth/authorize?${q}`;
}

/** A loopback port nobody listens on; the browser never reaches it because page.route answers. */
const loopbackRedirect = () =>
  `http://127.0.0.1:${40000 + Math.floor(Math.random() * 9000)}/callback`;

test.describe("sign-in", () => {
  test("signed-out pages send you to sign in and back", async ({ page }) => {
    await page.goto("/dashboard");
    await expect(page).toHaveURL(/\/login\?next=%2Fdashboard$/);
    await expect(page).toHaveTitle("Sign in · Plinth");

    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(page.getByText("Works with Claude, Codex and any MCP client.")).toBeVisible();
    await page.getByRole("link", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/\/login$/);
  });

  test("code sign-in: wrong code, resend, then success, home redirects", async ({ page }) => {
    const email = uniqueEmail("code");
    const since = new Date(Date.now() - 1000).toISOString();
    await page.goto("/login?next=%2Fconnections");
    await page.getByLabel("Email").fill(email);
    await page.getByRole("button", { name: "Send sign-in link" }).click();
    await expect(page.getByRole("heading", { name: "Check your email" })).toBeVisible();
    await expect(page.getByText(email)).toBeVisible();
    const first = await latestCode(page.request, email, { since });

    const wrong = first === "000000" ? "111111" : "000000";
    await page.getByLabel("Six-digit code").fill(wrong);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByText(/wrong or has expired/)).toBeVisible();

    const resendAt = new Date(Date.now() - 500).toISOString();
    await page.getByRole("button", { name: "Send a new code" }).click();
    await expect(page.getByText("A new code is on its way.", { exact: false })).toBeVisible();
    const second = await latestCode(page.request, email, { since: resendAt });
    await page.getByLabel("Six-digit code").fill(second);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/\/connections$/);

    await page.goto("/");
    await expect(page).toHaveURL(/\/dashboard$/);
    await page.goto("/login");
    await expect(page).toHaveURL(/\/dashboard$/);
  });

  test("magic link is not used on load, only on the button", async ({ page }) => {
    const email = uniqueEmail("magic");
    const since = new Date(Date.now() - 1000).toISOString();
    await page.goto("/login");
    await page.getByLabel("Email").fill(email);
    await page.getByRole("button", { name: "Send sign-in link" }).click();
    await expect(page.getByRole("heading", { name: "Check your email" })).toBeVisible();
    const link = await latestLink(page.request, email, { since });
    expect(link).toContain("/login/magic#token=");

    await page.goto(link);
    await expect(page.getByRole("heading", { name: "Finish signing in" })).toBeVisible();
    // Opening the link did not sign anyone in.
    expect((await apiGet(page.request, "/me")).status).toBe(401);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/\/dashboard$/);
    expect((await apiGet(page.request, "/me")).body.email).toBe(email);

    // The link works once.
    await page.goto(link);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(
      page.getByRole("alert").filter({ hasText: "expired or was already used" }),
    ).toBeVisible();
  });

  test("sign out from the account menu", async ({ page }) => {
    const email = uniqueEmail("signout");
    await seedContextSession(page.context(), email);
    await page.goto("/dashboard");
    await page.getByRole("button", { name: `Account: ${email}` }).click();
    await page.getByRole("menuitem", { name: "Sign out" }).click();
    await expect(page).toHaveURL(/\/login$/);
    expect((await apiGet(page.request, "/me")).status).toBe(401);
  });
});

test("dashboard, tokens, MCP publishing, search, settings and revocation", async ({ page }) => {
  test.setTimeout(120_000);
  const email = uniqueEmail("acct");
  await signIn(page, email);
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(page).toHaveTitle("Dashboard · Plinth");

  // Empty state: how to connect an agent, with the MCP URL.
  await expect(page.getByRole("heading", { name: "Nothing on display yet" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "MCP server URL" })).toHaveValue(
    `${APP_ORIGIN}/mcp`,
  );
  await expect(page.getByText("0 of 100 artifacts")).toBeVisible();

  // Create a token in the UI; it is shown once.
  await page.getByRole("link", { name: "Connect an agent" }).first().click();
  await expect(page).toHaveURL(/\/connections$/);
  await expect(page.getByRole("textbox", { name: "MCP server URL" })).toHaveValue(
    `${APP_ORIGIN}/mcp`,
  );
  await page.getByRole("button", { name: "New token" }).click();
  const create = page.getByRole("dialog", { name: "New token" });
  await create.getByLabel("Name").fill("E2E Codex");
  await create.getByLabel("Client").selectOption("codex");
  await create.getByRole("button", { name: "Create token" }).click();
  const reveal = page.getByRole("dialog", { name: "Copy your new token" });
  const token = await reveal.getByRole("textbox", { name: "Token" }).inputValue();
  expect(token).toMatch(/^plinth_pat_/);
  await expect(reveal.getByText("You won't see this token again.")).toBeVisible();
  await reveal.getByRole("button", { name: "Done" }).click();
  await expect(reveal).toHaveCount(0);
  expect(await page.content()).not.toContain(token);
  const item = page.getByRole("listitem").filter({ hasText: "E2E Codex" });
  await expect(item).toContainText("Token");
  await expect(item).toContainText("Codex");
  await expect(item).toContainText("Never used");

  // Publish two artifacts with the official MCP client and that token.
  const client = await mcpClient(token);
  let first: { id: string; slug: string };
  try {
    const a = await tool<{ id: string; slug: string }>(client, "publish_artifact", {
      title: "Quarterly revenue",
      html: HTML("Revenue"),
    });
    const b = await tool(client, "publish_artifact", {
      title: "Team offsite plan",
      html: HTML("Offsite"),
    });
    expect(a.isError).toBe(false);
    expect(b.isError).toBe(false);
    first = a.data;
  } finally {
    await client.close();
  }
  await page.reload();
  await expect(page.getByRole("listitem").filter({ hasText: "E2E Codex" })).toContainText(
    "Last used",
  );

  // The dashboard lists them, with quota; search filters and is kept in the URL.
  await page.getByRole("link", { name: "Dashboard", exact: true }).click();
  await expect(page.getByRole("link", { name: "Quarterly revenue" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Team offsite plan" })).toBeVisible();
  await expect(page.getByText("2 of 100 artifacts")).toBeVisible();
  const row = page.getByRole("listitem").filter({ hasText: "Quarterly revenue" });
  await expect(row).toContainText("v1");
  await expect(row).toContainText("1 version");
  await expect(row).toContainText("Unlisted");

  await page.getByLabel("Search artifacts").fill("offsite");
  await expect(page).toHaveURL(/\/dashboard\?q=offsite$/);
  await expect(page.getByRole("link", { name: "Quarterly revenue" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Team offsite plan" })).toBeVisible();
  await page.reload();
  await expect(page.getByLabel("Search artifacts")).toHaveValue("offsite");
  await expect(page.getByRole("link", { name: "Quarterly revenue" })).toHaveCount(0);
  await page.getByLabel("Search artifacts").fill("nothing like this");
  await expect(page.getByRole("heading", { name: /Nothing matches/ })).toBeVisible();
  await page.getByRole("button", { name: "Clear search" }).click();
  await expect(page.getByRole("link", { name: "Quarterly revenue" })).toBeVisible();
  await expect(page).toHaveURL(/\/dashboard$/);

  // Settings from the row's actions menu.
  await page.getByRole("button", { name: "Actions for Quarterly revenue" }).click();
  await page.getByRole("menuitem", { name: "Settings" }).click();
  await expect(page).toHaveURL(new RegExp(`/a/${first.slug}/settings$`));
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Quarterly revenue");
  await expect(page.getByLabel("Link", { exact: true })).toHaveValue(
    `${APP_ORIGIN}/a/${first.slug}`,
  );
  await expect(page.getByRole("radio", { name: /^Public/ })).toBeDisabled();
  await expect(page.getByText("Not available on this instance.")).toBeVisible();

  const sharing = async () =>
    (await apiGet(page.request, `/artifacts/${first.id}/sharing`)).body as {
      visibility: string;
      has_password: boolean;
      grants: { email: string; role: string }[];
    };

  // Password: a short one is refused in the page, then saved.
  await page.getByRole("radio", { name: /^Password/ }).check();
  await page.getByRole("button", { name: "Save access" }).click();
  await expect(page.getByText("Set a password.")).toBeVisible();
  await page.getByLabel("Password", { exact: true }).fill("abc");
  await page.getByRole("button", { name: "Save access" }).click();
  await expect(page.getByText("Use at least 6 characters.")).toBeVisible();
  await page.getByLabel("Password", { exact: true }).fill("correct horse");
  await page.getByRole("button", { name: "Save access" }).click();
  await expect(page.getByLabel("New password")).toBeVisible();
  expect(await sharing()).toMatchObject({ visibility: "password", has_password: true });
  await expect(
    page.getByText("Current viewers need to open the link again.", { exact: false }),
  ).toBeVisible();

  // Allowlist ("Specific people"), then a commenter.
  await page.getByRole("radio", { name: /^Specific people/ }).check();
  await expect(page.getByText("Nobody is on the list yet.", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "Save access" }).click();
  await expect.poll(async () => (await sharing()).visibility).toBe("allowlist");

  const collaborator = uniqueEmail("commenter");
  await page.getByRole("textbox", { name: "Email address" }).fill(collaborator.toUpperCase());
  await page.getByLabel("Role", { exact: true }).selectOption("commenter");
  await page.getByRole("button", { name: "Add person" }).click();
  await expect(page.getByLabel(`Role for ${collaborator}`)).toHaveValue("commenter");
  expect((await sharing()).grants).toEqual([
    expect.objectContaining({ email: collaborator, role: "commenter" }),
  ]);
  // Adding the same person again is refused in the page.
  await page.getByRole("textbox", { name: "Email address" }).fill(collaborator);
  await page.getByRole("button", { name: "Add person" }).click();
  await expect(page.getByText("is already on the list", { exact: false })).toBeVisible();
  await page.getByRole("textbox", { name: "Email address" }).fill("");
  // Role change.
  await page.getByLabel(`Role for ${collaborator}`).selectOption("editor");
  await expect.poll(async () => (await sharing()).grants[0]?.role).toBe("editor");
  await page.getByLabel(`Role for ${collaborator}`).selectOption("commenter");
  await expect.poll(async () => (await sharing()).grants[0]?.role).toBe("commenter");

  // Rename.
  await page.getByRole("textbox", { name: "Title", exact: true }).fill("Quarterly revenue, final");
  await page.getByRole("button", { name: "Save title" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Quarterly revenue, final");
  await expect(page).toHaveTitle("Settings · Quarterly revenue, final · Plinth");

  // Delete: the confirm button waits for the exact title.
  await page.getByRole("button", { name: "Delete artifact" }).click();
  const confirm = page.getByRole("alertdialog");
  await expect(confirm.getByRole("button", { name: "Delete artifact" })).toBeDisabled();
  await confirm.getByLabel("Type the title to confirm").fill("Quarterly revenue");
  await expect(confirm.getByRole("button", { name: "Delete artifact" })).toBeDisabled();
  await confirm.getByLabel("Type the title to confirm").fill("Quarterly revenue, final");
  await confirm.getByRole("button", { name: "Delete artifact" }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(page.getByRole("link", { name: "Team offsite plan" })).toBeVisible();
  await expect(page.getByRole("link", { name: /Quarterly revenue/ })).toHaveCount(0);
  await expect(page.getByText("1 of 100 artifacts")).toBeVisible();
  expect((await apiGet(page.request, `/artifacts/${first.id}`)).status).toBe(404);

  // Rename and revoke the token; the MCP client is refused afterwards.
  await page.getByRole("link", { name: "Connections", exact: true }).click();
  await page.getByRole("button", { name: "Rename E2E Codex" }).click();
  const rename = page.getByRole("dialog", { name: "Rename connection" });
  await rename.getByLabel("Name").fill("Laptop Codex");
  await rename.getByRole("button", { name: "Save name" }).click();
  await expect(page.getByRole("heading", { name: "Laptop Codex" })).toBeVisible();

  await page.getByRole("button", { name: "Revoke Laptop Codex" }).click();
  const revoke = page.getByRole("alertdialog", { name: /Revoke/ });
  await revoke.getByRole("button", { name: "Revoke connection" }).click();
  await expect(page.getByRole("heading", { name: /^Revoked/ })).toBeVisible();
  await expect(page.getByRole("listitem").filter({ hasText: "Laptop Codex" })).toContainText(
    "Revoked",
  );
  await expect(page.getByRole("button", { name: "Revoke Laptop Codex" })).toHaveCount(0);

  await expect(mcpClient(token)).rejects.toThrow();
  expect((await apiGet(page.request, "/me", { token })).status).toBe(401);
});

test("settings are for the owner only", async ({ page }) => {
  const owner = uniqueEmail("owner");
  const ownerApi = await newApiContext();
  try {
    const { token } = await seedToken(owner, { label: "Owner token" });
    const art = await publishArtifact(ownerApi, token, {
      title: "Shared plan",
      html: HTML("Shared"),
    });
    const commenter = uniqueEmail("collab");
    const put = await apiPut(
      ownerApi,
      `/artifacts/${art.id}/sharing`,
      { grants: [{ email: commenter, role: "commenter" }] },
      { token },
    );
    expect(put.status).toBe(200);

    // The commenter sees it under "Shared with you", without owner actions or settings.
    await seedContextSession(page.context(), commenter);
    await page.goto("/dashboard");
    await expect(page.getByRole("heading", { name: /Shared with you/ })).toBeVisible();
    const row = page.getByRole("listitem").filter({ hasText: "Shared plan" });
    await expect(row).toContainText("Commenter");
    await expect(row).toContainText(`Shared by ${owner}`);
    await row.getByRole("button", { name: "Actions for Shared plan" }).click();
    await expect(page.getByRole("menuitem", { name: "History" })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: "Settings" })).toHaveCount(0);
    await expect(page.getByRole("menuitem", { name: "Edit" })).toHaveCount(0);
    await page.keyboard.press("Escape");

    await page.goto(`/a/${art.slug}/settings`);
    await expect(
      page.getByRole("heading", { name: "Only the owner can change settings" }),
    ).toBeVisible();
    await page.goto("/a/no-such-artifact-0000000000/settings");
    await expect(page.getByRole("heading", { name: "Artifact not found" })).toBeVisible();
  } finally {
    await ownerApi.dispose();
  }
});

test.describe("OAuth consent", () => {
  test("signed out: sign in, see client and redirect host, Allow returns a working code", async ({
    page,
  }) => {
    const redirectUri = loopbackRedirect();
    const host = new URL(redirectUri).host;
    const clientId = await registerClient(page, "Claude", redirectUri);
    const { verifier, challenge } = pkce();
    const state = b64url(randomBytes(12));
    await page.route(`${new URL(redirectUri).origin}/**`, (route) =>
      route.fulfill({ status: 200, contentType: "text/plain", body: "callback reached" }),
    );

    // Signed out: authorize -> consent -> sign-in with next -> back to consent.
    await page.goto(authorizeUrl(clientId, redirectUri, challenge, state));
    await expect(page).toHaveURL(/\/login\?next=%2Foauth%2Fconsent%3Frequest%3D/);
    const email = uniqueEmail("oauth");
    const since = new Date(Date.now() - 1000).toISOString();
    await page.getByLabel("Email").fill(email);
    await page.getByRole("button", { name: "Send sign-in link" }).click();
    await page.getByLabel("Six-digit code").fill(await latestCode(page.request, email, { since }));
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/\/oauth\/consent\?request=/);

    await expect(page.getByRole("heading", { level: 1 })).toContainText("Connect Claude to Plinth");
    await expect(page.getByText(host, { exact: true })).toBeVisible();
    await expect(page.getByText(email)).toBeVisible();
    await expect(page.getByText("Read artifacts")).toBeVisible();
    await expect(page.getByText("Answer mentions")).toBeVisible();
    await expect(page.getByLabel("Name this connection")).toHaveValue("Claude");
    await expect(page.getByLabel("Client")).toHaveValue("claude");
    await page.getByLabel("Name this connection").fill("Work Claude");
    await page.getByRole("button", { name: "Allow" }).click();

    await page.waitForURL((u) => u.host === host);
    const back = new URL(page.url());
    expect(back.pathname).toBe("/callback");
    expect(back.searchParams.get("state")).toBe(state);
    const code = back.searchParams.get("code");
    expect(code).toBeTruthy();

    // The code is real: exchange it and use the access token over MCP.
    const tok = await page.request.post(`${APP_ORIGIN}/oauth/token`, {
      form: {
        grant_type: "authorization_code",
        code: code ?? "",
        redirect_uri: redirectUri,
        client_id: clientId,
        code_verifier: verifier,
      },
    });
    expect(tok.status()).toBe(200);
    const { access_token } = (await tok.json()) as { access_token: string };
    const client = await mcpClient(access_token);
    try {
      expect((await tool(client, "list_artifacts", {})).isError).toBe(false);
    } finally {
      await client.close();
    }

    await page.goto("/connections");
    const conn = page.getByRole("listitem").filter({ hasText: "Work Claude" });
    await expect(conn).toContainText("OAuth");
    await expect(conn).toContainText("Claude");
  });

  test("Deny returns access_denied; an unknown request says it expired", async ({ page }) => {
    await seedContextSession(page.context(), uniqueEmail("deny"));
    const redirectUri = loopbackRedirect();
    const clientId = await registerClient(page, "Some tool", redirectUri);
    const { challenge } = pkce();
    await page.route(`${new URL(redirectUri).origin}/**`, (route) =>
      route.fulfill({ status: 200, contentType: "text/plain", body: "callback reached" }),
    );
    await page.goto(authorizeUrl(clientId, redirectUri, challenge, "s1"));
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Connect Some tool");
    await expect(page.getByLabel("Client")).toHaveValue("other");
    await page.getByRole("button", { name: "Deny" }).click();
    await page.waitForURL((u) => u.host === new URL(redirectUri).host);
    const back = new URL(page.url());
    expect(back.searchParams.get("error")).toBe("access_denied");
    expect(back.searchParams.get("state")).toBe("s1");
    expect(back.searchParams.get("code")).toBeNull();

    await page.goto("/oauth/consent?request=not-a-real-request");
    await expect(page.getByRole("heading", { name: "This request has expired" })).toBeVisible();
  });
});
