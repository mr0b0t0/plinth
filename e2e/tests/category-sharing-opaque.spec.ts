// Category sharing under opaque content isolation (the second e2e Worker): the portal works as with
// origin isolation, the client opens a shared artifact from it, and shared data and rooms stay off
// there as before (the gate carries neither).
import { expect, test } from "@playwright/test";
import { OPAQUE_APP_ORIGIN, uniqueEmail } from "../support/api.ts";
import { seedSession, seedToken } from "../support/db.ts";

const API = `${OPAQUE_APP_ORIGIN}/api/v1`;

async function codeFor(email: string, since: string): Promise<string> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const res = await fetch(`${API}/__dev/outbox?to=${encodeURIComponent(email)}`);
    const { items } = (await res.json()) as { items: { text: string; created_at: string }[] };
    const mail = items.find((m) => m.created_at >= since);
    const code = mail ? /\b(\d{6})\b/.exec(mail.text)?.[1] : undefined;
    if (code) return code;
    if (Date.now() > deadline) throw new Error(`no code mailed to ${email}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

test("a portal works with an opaque-origin content host", async ({ page, browser }) => {
  test.setTimeout(90_000);
  const owner = uniqueEmail("cat-opaque-owner");
  const client = uniqueEmail("cat-opaque-client");
  const { token } = await seedToken(owner, { origin: OPAQUE_APP_ORIGIN });
  const res = await fetch(`${API}/artifacts`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      title: "Opaque report",
      html: '<!doctype html><title>Opaque report</title><meta name="plinth-capabilities" content="data room"><h1>Opaque report</h1>',
      category: "Acme",
    }),
  });
  const art = (await res.json()) as { id: string; slug: string };
  expect(res.status, JSON.stringify(art)).toBe(201);

  // The owner shares it through the API, as the dialog does.
  await seedSession(page.context(), owner, OPAQUE_APP_ORIGIN);
  await page.goto("/dashboard");
  const preview = await page.request.get(`${API}/category-shares/preview?category=Acme`);
  const rows = (
    (await preview.json()) as {
      artifacts: { id: string; current_version: number; category_rev: number }[];
    }
  ).artifacts;
  const csrf = (await page.context().cookies()).find((c) => c.name === "__Host-plinth_csrf")?.value;
  const made = await page.request.post(`${API}/category-shares`, {
    headers: { "x-plinth-csrf": csrf ?? "", Origin: OPAQUE_APP_ORIGIN },
    data: {
      category: "Acme",
      people: [{ email: client, role: "commenter" }],
      review: rows.map((r) => ({
        id: r.id,
        version: r.current_version,
        category_rev: r.category_rev,
        decision: "shared",
      })),
    },
  });
  expect(made.status()).toBe(201);
  const { share } = (await made.json()) as { share: { id: string } };

  const ctx = await browser.newContext({ baseURL: OPAQUE_APP_ORIGIN });
  const cp = await ctx.newPage();
  try {
    await cp.goto(`/p/${share.id}`);
    const since = new Date(Date.now() - 1000).toISOString();
    await cp.getByLabel("Email", { exact: true }).fill(client);
    await cp.getByRole("button", { name: "Send code" }).click();
    await cp.getByLabel("Six-digit code").fill(await codeFor(client, since));
    await cp.getByRole("button", { name: "Confirm code" }).click();
    await expect(cp.getByRole("link", { name: "Opaque report" })).toBeVisible();

    const gate = (await (await cp.request.get(`${API}/view/${art.slug}`)).json()) as {
      status: string;
      role: string;
      data?: { available: boolean; identified: boolean };
    };
    expect(gate.status).toBe("ok");
    expect(gate.role).toBe("commenter");
    // Under opaque isolation shared data and rooms stay off, with or without a category grant.
    expect(gate.data?.available ?? false).toBe(false);

    await cp.getByRole("link", { name: "Opaque report" }).click();
    await expect(cp.locator("iframe.pl-viewer-frame")).toBeVisible();
  } finally {
    await ctx.close();
  }
});
