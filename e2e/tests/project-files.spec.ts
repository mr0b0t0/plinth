// Project files for a page (docs/spec.md, "Project files for a page"): a page reads the snapshot of
// project files published with it, by relative URL, from its own origin. A refresh is a new version,
// and a version link keeps the files of that version. Origin isolation only: under opaque isolation
// a page cannot fetch its own files, which the opaque suite already covers.
import { expect, type Page, test } from "@playwright/test";
import { uniqueEmail } from "../support/api.ts";
import { mcpClient, tool } from "../support/mcp.ts";
import { seedToken } from "../support/tokens.ts";

// The frame being shown. A reload keeps the outgoing frame (marked) until the new one loads.
const CURRENT_FRAME = "iframe.pl-viewer-frame:not(.pl-viewer-frame--outgoing)";

/** A page that fetches files/data.csv and shows how many data rows it holds. */
const PAGE = [
  "<!doctype html>",
  '<html lang="en">',
  '<head><meta charset="utf-8"><title>Sales rows</title></head>',
  "<body>",
  '<h1 id="out">Loading</h1>',
  "<script>",
  'fetch("./files/data.csv")',
  "  .then((r) => (r.ok ? r.text() : Promise.reject(new Error(String(r.status)))))",
  "  .then((text) => {",
  '    const rows = text.trim().split("\\n").slice(1);',
  '    document.getElementById("out").textContent = "Rows: " + rows.length;',
  "  })",
  '  .catch((e) => { document.getElementById("out").textContent = "Failed: " + e.message; });',
  "</script>",
  "</body>",
  "</html>",
].join("\n");

const csv = (n: number) =>
  ["region,amount", ...Array.from({ length: n }, (_, i) => `r${i},${i * 10}`)].join("\n");

async function expectRows(page: Page, n: number) {
  await expect(
    page.frameLocator(CURRENT_FRAME).getByRole("heading", { name: `Rows: ${n}` }),
  ).toBeVisible({ timeout: 10_000 });
}

test("a page reads its project files by relative URL, and a version link keeps its snapshot", async ({
  page,
}) => {
  const { token } = await seedToken(uniqueEmail("files-owner"), { clientType: "claude" });
  const client = await mcpClient(token);
  let slug = "";
  try {
    const pub = await tool<{ id: string; slug: string; warnings: unknown[] }>(
      client,
      "publish_artifact",
      {
        title: "Sales rows",
        html: PAGE,
        visibility: "unlisted",
        assets: [{ path: "files/data.csv", content: csv(3) }],
      },
    );
    expect(pub.isError, pub.text).toBe(false);
    expect(pub.data.warnings).toEqual([]);
    slug = pub.data.slug;

    await page.goto(`/a/${slug}`);
    await expectRows(page, 3);

    // Refresh: the re-read file goes up with content; the page is reused by its hash.
    const up = await tool(client, "update_artifact", {
      id: pub.data.id,
      html: PAGE,
      base_version: 1,
      note: "Refreshed data.csv",
      assets: [{ path: "files/data.csv", content: csv(5) }],
    });
    expect(up.isError, up.text).toBe(false);
  } finally {
    await client.close();
  }

  await page.goto(`/a/${slug}`);
  await expectRows(page, 5);
  await page.goto(`/a/${slug}/v/1`);
  await expect(page.getByText(/You are viewing\s*v1/)).toBeVisible();
  await expectRows(page, 3);
});
