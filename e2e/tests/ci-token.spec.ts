// Publishing from CI (docs/ci.md): the New token dialog makes a token limited to one artifact and
// shows the workflow step; the token publishes a new version of that artifact and gets 404 for any
// other; deleting the artifact revokes it, and Connections says it can no longer open it.
import { expect, test } from "@playwright/test";
import {
  apiDelete,
  apiGet,
  apiPut,
  newApiContext,
  publishArtifact,
  uniqueEmail,
} from "../support/api.ts";
import { seedSession } from "../support/db.ts";
import { seedToken } from "../support/tokens.ts";

test("a token limited to one artifact, from the New token dialog to its end", async ({ page }) => {
  const owner = uniqueEmail("ci");
  const api = await newApiContext();
  try {
    const { token: ownerToken } = await seedToken(owner, { label: "Owner token" });
    const art = await publishArtifact(api, ownerToken, {
      title: "Coverage report",
      html: "<!doctype html><title>Coverage</title><h1>v1</h1>",
    });
    const other = await publishArtifact(api, ownerToken, { title: "Another page" });

    await seedSession(page.context(), owner);
    await page.goto("/connections");
    await page.getByText("Advanced: personal access tokens for scripts and CI").click();
    await page.getByRole("button", { name: "New token" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Name").fill("CI: Coverage report");
    await dialog.getByRole("checkbox", { name: "Limit to one artifact" }).check();
    await expect(dialog.getByRole("option", { name: "Coverage report" })).toBeAttached();
    await dialog.getByLabel("Artifact", { exact: true }).selectOption(art.id);
    await expect(dialog.getByLabel("Client")).toHaveCount(0);
    await expect(dialog.getByRole("checkbox", { name: /Answer mentions/ })).toHaveCount(0);
    await dialog.getByRole("button", { name: "Create token" }).click();
    const field = page.getByRole("textbox", { name: "Token" });
    await expect(field).toHaveValue(/^plinth_pat_/);
    const token = await field.inputValue();
    await expect(page.getByText(`id: ${art.id}`)).toBeVisible();
    await page.getByRole("button", { name: "Done" }).click();
    // Listed with the connections, limited to the artifact; not among the sidebar's agents.
    const item = page.getByRole("listitem").filter({ hasText: "CI: Coverage report" });
    await expect(item).toContainText("Only Coverage report");
    const sidebar = page.getByRole("heading", { name: "Agents" }).locator("..");
    await expect(sidebar.getByRole("link", { name: /CI: Coverage report/ })).toHaveCount(0);

    // It publishes the next version of its artifact, and nothing else exists for it.
    const put = await apiPut(
      api,
      `/artifacts/${art.id}`,
      { html: "<!doctype html><title>Coverage</title><h1>v2</h1>", base_version: 1 },
      { token },
    );
    expect(put.status).toBe(200);
    expect(put.body.version).toBe(2);
    expect((await apiGet(api, `/artifacts/${other.id}`, { token })).status).toBe(404);
    const me = await apiGet(api, "/me", { token });
    expect(me.body.connection).toMatchObject({ bound: true, artifact: { id: art.id } });

    // Deleting the artifact revokes the token.
    expect((await apiDelete(api, `/artifacts/${art.id}`, { token: ownerToken })).status).toBe(204);
    expect((await apiGet(api, "/me", { token })).status).toBe(401);
    await page.goto("/connections");
    const revoked = page.getByRole("region", { name: /Revoked/ });
    const gone = revoked.getByRole("listitem").filter({ hasText: "CI: Coverage report" });
    await expect(gone).toBeVisible();
    await expect(gone).toContainText("Only an artifact you can no longer open");
  } finally {
    await api.dispose();
  }
});
