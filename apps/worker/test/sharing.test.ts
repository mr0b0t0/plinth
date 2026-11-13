import { describe, expect, it } from "vitest";
import { agent, browserSession, call, createUser, json, publish } from "./helpers.ts";

const putSharing = (headers: Record<string, string>, ref: string, grants: unknown[]) =>
  call(`/api/v1/artifacts/${ref}/sharing`, {
    method: "PUT",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ grants }),
  });

describe("sharing settings", () => {
  it("owner replaces grants; roles take effect; others cannot read or change them", async () => {
    const owner = await agent();
    const editor = await createUser();
    const stranger = await agent();
    const { body: p } = await publish(owner.auth, { visibility: "allowlist" });

    const r = await putSharing(owner.auth, p.id, [
      { email: editor.email, role: "editor" },
      { email: "Viewer@Example.com", role: "viewer" },
      { email: owner.user.email, role: "viewer" },
    ]);
    expect(r.status).toBe(200);
    const s = await json(r);
    expect(s.grants.map((g: { email: string; role: string }) => `${g.email}:${g.role}`)).toEqual([
      `${editor.email}:editor`,
      "viewer@example.com:viewer",
    ]);
    expect(s).toMatchObject({
      visibility: "allowlist",
      has_password: false,
      public_allowed: false,
    });

    const session = await browserSession(editor.id);
    const upd = await call(`/api/v1/artifacts/${p.id}`, {
      method: "PUT",
      headers: { ...session.headers, "Content-Type": "application/json" },
      body: JSON.stringify({ html: "<p>by editor</p>" }),
    });
    expect(upd.status).toBe(200);
    // Editors may edit but not manage sharing.
    expect(
      (await call(`/api/v1/artifacts/${p.id}/sharing`, { headers: session.headers })).status,
    ).toBe(403);
    expect((await putSharing(session.headers, p.id, [])).status).toBe(403);
    // Strangers do not learn the artifact exists.
    expect(
      (await call(`/api/v1/artifacts/${p.id}/sharing`, { headers: stranger.auth })).status,
    ).toBe(404);

    // Removing the grant removes the access.
    expect((await putSharing(owner.auth, p.id, [])).status).toBe(200);
    const after = await call(`/api/v1/artifacts/${p.id}`, {
      method: "PUT",
      headers: { ...session.headers, "Content-Type": "application/json" },
      body: JSON.stringify({ html: "<p>again</p>" }),
    });
    expect(after.status).toBe(404);
  });

  it("rejects duplicates and bad roles", async () => {
    const owner = await agent();
    const { body: p } = await publish(owner.auth);
    expect(
      (
        await putSharing(owner.auth, p.id, [
          { email: "a@x.com", role: "viewer" },
          { email: "A@x.com", role: "editor" },
        ])
      ).status,
    ).toBe(400);
    expect((await putSharing(owner.auth, p.id, [{ email: "a@x.com", role: "owner" }])).status).toBe(
      400,
    );
  });
});
