// The files routes of the page API (/__plinth/api/v1/files...): the caller checks every data-API
// route keeps, the strict JSON part body, who may upload, the declaration and the switch, parts in
// order, sniffing, quotas, rate limits, deletes and the change counter. Cookies are minted through
// the real gate and enter flow. Design: docs/spec.md "Files people add to a page".
import { env } from "cloudflare:workers";
import { FILE_LIMITS } from "@plinth/shared";
import { describe, expect, it, vi } from "vitest";
import { contentCookieName } from "../src/content/serve.ts";
import { signContentCookie } from "../src/content/tokens.ts";
import {
  b64,
  cookieFor,
  DATA_ONLY,
  epochOf,
  errOf,
  FILES_ONLY,
  fileRow,
  filesApi,
  html,
  jpeg,
  mp4,
  ON,
  pdf,
  person,
  png,
  setup,
  svg,
  takeDown,
  upload,
  usage,
} from "./files-helpers.ts";
import {
  BIG_BUNDLE_TIMEOUT_MS,
  browserSession,
  call,
  config,
  contentOrigin,
  json,
  publish,
} from "./helpers.ts";

const noCors = (res: Response) => {
  for (const [k] of res.headers) expect(k.startsWith("access-control-"), k).toBe(false);
};

const create = (id: string, cookie: string, body: unknown) => filesApi(id, "", { cookie, body });

describe("files API: caller checks", () => {
  it("refuses requests that do not come from the page's own fetch, on every files route", async () => {
    const { id, ownerP } = await setup();
    const routes: [string, string, unknown?][] = [
      ["GET", "/session"],
      ["GET", ""],
      ["POST", "", { name: "a.png", type: "image/png", size: 10 }],
      ["GET", `/${"a".repeat(20)}`],
      ["DELETE", `/${"a".repeat(20)}`],
      ["PUT", `/${"a".repeat(20)}/parts/1`, { data: "AAAA" }],
    ];
    const bad: Record<string, string | null>[] = [
      { "x-plinth-data": null },
      { "sec-fetch-site": "same-site" },
      { "sec-fetch-dest": "image" },
      { origin: "null" },
      { origin: contentOrigin("b".repeat(20)) },
    ];
    for (const [method, path, body] of routes) {
      for (const headers of bad) {
        const res = await filesApi(id, path, { method, cookie: ownerP.cookie, body, headers });
        expect(res.status, `${method} ${path} ${JSON.stringify(headers)}`).toBe(403);
        noCors(res);
      }
    }
    const pre = await filesApi(id, "", {
      method: "OPTIONS",
      headers: {
        origin: contentOrigin("b".repeat(20)),
        "access-control-request-method": "POST",
      },
    });
    expect(pre.status).toBe(405);
    noCors(pre);
  });

  it("takes JSON bodies only, on create and on parts", async () => {
    const { id, ownerP } = await setup();
    for (const type of ["image/png", "text/plain", "multipart/form-data; boundary=x"]) {
      const res = await filesApi(id, "", {
        cookie: ownerP.cookie,
        body: '{"name":"a.png","type":"image/png","size":10}',
        headers: { "content-type": type },
      });
      expect(res.status, type).toBe(400);
      const part = await filesApi(id, `/${"a".repeat(20)}/parts/1`, {
        method: "PUT",
        cookie: ownerP.cookie,
        body: '{"data":"AAAA"}',
        headers: { "content-type": type },
      });
      expect(part.status, type).toBe(400);
    }
    const big = await create(id, ownerP.cookie, {
      name: "x".repeat(3000),
      type: "image/png",
      size: 1,
    });
    expect(big.status).toBe(413);
  });

  it(
    'refuses a part body that is not exactly {"data":"<base64>"}',
    async () => {
      const { id, ownerP } = await setup();
      const bytes = png(300);
      const { created } = await (async () => {
        const r = await create(id, ownerP.cookie, { name: "a.png", type: "image/png", size: 300 });
        return { created: await json(r) };
      })();
      const fid = created.file.id as string;
      const put = (body: string, headers: Record<string, string | null> = {}) =>
        filesApi(id, `/${fid}/parts/1`, { method: "PUT", cookie: ownerP.cookie, body, headers });
      const good = b64(bytes);
      for (const body of [
        `{"data":"${good}","extra":1}`,
        `{"extra":1,"data":"${good}"}`,
        `{"data":"${good.slice(0, 4)}\\u0041${good.slice(4)}"}`,
        `{"data":${JSON.stringify({ v: good })}}`,
        `["${good}"]`,
        `{"data":"${good}"} x`,
        `{"dat":"${good}"}`,
        `{"data":"${good.slice(0, -1)}"}`,
        `{"data":"A=AA"}`,
        "{",
      ]) {
        const res = await put(body);
        expect(res.status, body.slice(0, 40)).toBe(400);
        expect((await errOf(res)).code).toBe("invalid_input");
      }
      // The right shape with the wrong decoded length.
      const short = await put(`{"data":"${b64(bytes.subarray(0, 299))}"}`);
      expect(short.status).toBe(400);
      // Over the cap, with and without a declared length.
      const huge = `{"data":"${"A".repeat(4 * Math.ceil(FILE_LIMITS.partBytes / 3) + 400)}"}`;
      expect((await put(huge)).status).toBe(413);
      const stream = new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode(huge));
          c.close();
        },
      });
      const res = await filesApi(id, `/${fid}/parts/1`, {
        method: "PUT",
        cookie: ownerP.cookie,
        body: stream as unknown as string,
      });
      expect(res.status).toBe(413);
      // Whitespace between the tokens is fine.
      const ok = await put(` { "data" : "${good}" } `);
      expect(ok.status).toBe(200);
      expect((await json(ok)).file).toMatchObject({ id: fid, type: "image/png", size: 300 });
    },
    BIG_BUNDLE_TIMEOUT_MS,
  );
});

describe("files API: availability and who may upload", () => {
  it("reports unavailable while ALLOW_FILES is off, under opaque isolation, without the declaration and in a preview", async () => {
    const { id, ownerP } = await setup();
    const off = await filesApi(id, "/session", {
      cookie: ownerP.cookie,
      vars: { ALLOW_FILES: "false" },
    });
    expect(await json(off)).toEqual({ available: false, reason: "disabled" });
    const list = await filesApi(id, "", { cookie: ownerP.cookie, vars: { ALLOW_FILES: "false" } });
    expect(list.status).toBe(404);
    expect((await errOf(list)).details).toEqual({ reason: "disabled" });
    const opaque = await filesApi(id, "/session", {
      cookie: ownerP.cookie,
      vars: { CONTENT_ISOLATION: "opaque" },
    });
    expect(await json(opaque)).toEqual({ available: false, reason: "opaque_isolation" });

    const data = await setup(DATA_ONLY);
    const nd = await filesApi(data.id, "/session", { cookie: data.ownerP.cookie });
    expect(await json(nd)).toEqual({ available: false, reason: "not_declared" });
    const ndCreate = await create(data.id, data.ownerP.cookie, {
      name: "a.png",
      type: "image/png",
      size: 10,
    });
    expect(ndCreate.status).toBe(404);

    const c = config();
    const name = contentCookieName(c, new URL(contentOrigin(id)));
    const preview = await signContentCookie(c, id, await epochOf(id), undefined, "preview", 1);
    const pv = await filesApi(id, "/session", { cookie: `${name}=${preview}` });
    expect(await json(pv)).toEqual({ available: false, reason: "preview" });
    // No pass at all: a JSON 401, never the gate redirect.
    const none = await filesApi(id, "/session");
    expect(none.status).toBe(401);
  });

  it("lets identified viewers upload; anonymous link viewers only read; a thumbnail capture gets nothing", async () => {
    const { id, ownerP } = await setup(FILES_PAGE_UNLISTED, "unlisted");
    const s = await json(await filesApi(id, "/session", { cookie: ownerP.cookie }));
    expect(s).toMatchObject({ available: true, can_upload: true, usage: { files: 0, bytes: 0 } });
    expect(s.accept).toContain("image/png");
    expect(s.accept).not.toContain("image/svg+xml");
    expect(s.limits.part_bytes).toBe(FILE_LIMITS.partBytes);

    const anon = await cookieFor(id);
    expect(await json(await filesApi(id, "/session", { cookie: anon }))).toMatchObject({
      available: true,
      can_upload: false,
    });
    const refused = await create(id, anon, { name: "a.png", type: "image/png", size: 10 });
    expect(refused.status).toBe(403);
    expect((await errOf(refused)).details).toEqual({ reason: "read_only" });

    const c = config();
    const name = contentCookieName(c, new URL(contentOrigin(id)));
    // A capture reads as a preview: no upload ever ends up in a thumbnail or a link preview.
    const capture = `${name}=${await signContentCookie(c, id, await epochOf(id), undefined, "capture")}`;
    expect(await json(await filesApi(id, "/session", { cookie: capture }))).toEqual({
      available: false,
      reason: "preview",
    });
    const captured = await filesApi(id, "", { cookie: capture });
    expect(captured.status).toBe(404);
    expect((await errOf(captured)).details).toEqual({ reason: "preview" });
    expect((await create(id, capture, { name: "a.png", type: "image/png", size: 10 })).status).toBe(
      404,
    );

    // Every role with a grant uploads.
    for (const role of ["viewer", "commenter", "editor"] as const) {
      const p = await person(id, role);
      const up = await upload(id, p, png(), "image/png");
      expect(up.last.file.mine).toBe(true);
    }
  });
});

const FILES_PAGE_UNLISTED = `<!doctype html><title>Wall</title>
<meta name="plinth-capabilities" content="files viewer"><p>wall</p>`;

describe("files API: uploads", () => {
  it("uploads a small PNG in one part, then lists it, oldest first, with who uploaded it", async () => {
    const { id, ownerP } = await setup();
    const viewer = await person(id, "viewer");
    const a = await upload(id, viewer, png(400), "image/png", "../../evil‮gnp.html");
    expect(a.created).toMatchObject({ parts: 1, part_bytes: FILE_LIMITS.partBytes });
    expect(a.created.file.state).toBe("pending");
    const file = a.last.file;
    expect(file).toMatchObject({
      id: a.id,
      type: "image/png",
      size: 400,
      url: `/__plinth/files/${a.id}`,
      mine: true,
      // The page declares `viewer`, so identified readers see the uploader.
      uploaded_by: { email: viewer.email, role: "viewer", via: "page" },
    });
    // Basename, no bidi override, and the proven type's extension appended.
    expect(file.name).toBe("evilgnp.html.png");
    const b = await upload(id, ownerP, jpeg(), "image/jpeg", "b.jpg");
    const list = await json(await filesApi(id, "", { cookie: ownerP.cookie }));
    expect(list.files.map((f: { id: string }) => f.id)).toEqual([a.id, b.id]);
    expect(list.files[0].mine).toBe(false);
    expect(list.next_cursor).toBeNull();
    const mine = await json(await filesApi(id, "?mine=1", { cookie: viewer.cookie }));
    expect(mine.files.map((f: { id: string }) => f.id)).toEqual([a.id]);
    const one = await json(await filesApi(id, `/${b.id}`, { cookie: viewer.cookie }));
    expect(one).toMatchObject({ id: b.id, name: "b.jpg", type: "image/jpeg" });
    expect(await usage(id)).toMatchObject({ files: 2, bytes: 700 });

    // Without `viewer`, nobody sees who uploaded.
    const plain = await setup(FILES_ONLY);
    const up = await upload(plain.id, plain.ownerP, png(), "image/png");
    expect(up.last.file.uploaded_by).toBeUndefined();
  });

  it(
    "uploads an 11 MiB MP4 in three ordered parts; a part out of order is a conflict",
    async () => {
      const { id, ownerP } = await setup();
      const size = 11 * 1024 * 1024;
      const bytes = mp4(size);
      const created = await json(
        await create(id, ownerP.cookie, { name: "clip.mp4", type: "video/mp4", size }),
      );
      expect(created.parts).toBe(3);
      const fid = created.file.id as string;
      expect((await fileRow(fid))?.multipart_id).toBeTruthy();
      const part = (n: number) =>
        filesApi(id, `/${fid}/parts/${n}`, {
          method: "PUT",
          cookie: ownerP.cookie,
          body: {
            data: b64(bytes.subarray((n - 1) * FILE_LIMITS.partBytes, n * FILE_LIMITS.partBytes)),
          },
        });
      const early = await part(2);
      expect(early.status).toBe(409);
      expect((await errOf(early)).details).toEqual({ parts_done: 0 });
      expect(await json(await part(1))).toEqual({ parts_done: 1, parts: 3 });
      // The last accepted part again (its answer was lost): accepted, still in order.
      expect(await json(await part(1))).toEqual({ parts_done: 1, parts: 3 });
      expect((await part(3)).status).toBe(409);
      expect(await json(await part(2))).toEqual({ parts_done: 2, parts: 3 });
      const last = await json(await part(3));
      expect(last).toMatchObject({ parts_done: 3, parts: 3, file: { id: fid, size } });
      // The final part again after ready: the same answer.
      expect(await json(await part(3))).toMatchObject({ parts_done: 3, file: { id: fid } });
      const row = await fileRow(fid);
      expect(row).toMatchObject({ state: "ready", multipart_id: null, part_etags: null });
      const obj = await env.FILES.get(row?.r2_key as string);
      expect(obj?.size).toBe(size);
      expect(new Uint8Array(await (obj as R2ObjectBody).arrayBuffer())).toEqual(bytes);
    },
    BIG_BUNDLE_TIMEOUT_MS,
  );

  it("refuses markup types at create, and bytes that do not prove the declared type", async () => {
    const { id, ownerP } = await setup();
    for (const type of ["image/svg+xml", "text/html", "application/xml", "text/plain"]) {
      const res = await create(id, ownerP.cookie, { name: "x", type, size: 10 });
      expect(res.status, type).toBe(400);
      expect((await errOf(res)).details, type).toEqual({ reason: "unsupported_type" });
    }
    for (const [bytes, type] of [
      [svg(), "image/png"],
      [html(), "application/pdf"],
      [jpeg(), "image/png"],
      [pdf(), "video/mp4"],
    ] as const) {
      const created = await json(
        await create(id, ownerP.cookie, { name: "x", type, size: bytes.byteLength }),
      );
      const res = await filesApi(id, `/${created.file.id}/parts/1`, {
        method: "PUT",
        cookie: ownerP.cookie,
        body: { data: b64(bytes) },
      });
      expect(res.status, type).toBe(400);
      expect((await errOf(res)).details, type).toEqual({ reason: "type_mismatch" });
      expect((await fileRow(created.file.id))?.state).toBe("deleting");
    }
    expect((await usage(id)).files).toBe(0);
    const big = await create(id, ownerP.cookie, {
      name: "x.png",
      type: "image/png",
      size: config().files.maxFileBytes + 1,
    });
    expect(big.status).toBe(413);
  });
});

describe("files API: quotas and rate limits", () => {
  it("maps each quota to its limit", async () => {
    const small = {
      ...ON,
      FILES_MAX_FILE_BYTES: String(1024 * 1024),
      FILES_MAX_PER_ARTIFACT: "3",
      FILES_MAX_BYTES_PER_ARTIFACT: String(3 * 1024 * 1024),
      FILES_MAX_BYTES_PER_UPLOADER: String(1024 * 1024),
      FILES_MAX_BYTES_PER_USER: String(3 * 1024 * 1024),
    };
    const { id, ownerP } = await setup();
    const viewer = await person(id, "viewer");
    const start = (who: { cookie: string }, size: number) =>
      filesApi(id, "", {
        cookie: who.cookie,
        body: { name: "a.png", type: "image/png", size },
        vars: small,
      });
    const limitOf = async (res: Response) => {
      expect(res.status).toBe(403);
      return (await errOf(res)).details.limit;
    };
    // The viewer's own cap (the owner is exempt).
    expect((await start(viewer, 1024 * 1024)).status).toBe(201);
    expect(await limitOf(await start(viewer, 1))).toBe("uploader_bytes");
    expect((await start(ownerP, 1024 * 1024)).status).toBe(201);
    expect((await start(ownerP, 1024 * 1024)).status).toBe(201);
    // Three files: the count, then the bytes.
    expect(await limitOf(await start(ownerP, 1))).toBe("files");
    const other = await setup();
    const more = (size: number) =>
      filesApi(other.id, "", {
        cookie: other.ownerP.cookie,
        body: { name: "a.png", type: "image/png", size },
        vars: {
          ...small,
          FILES_MAX_PER_ARTIFACT: "100",
          FILES_MAX_BYTES_PER_ARTIFACT: String(10 * 1024 * 1024),
          FILES_MAX_BYTES_PER_USER: String(10 * 1024 * 1024),
        },
      });
    for (let i = 0; i < 3; i++) expect((await more(1024 * 1024)).status).toBe(201);
    expect(await limitOf(await more(1))).toBe("pending");
  });

  it("caps an owner's files across artifacts, and pending uploads per person", async () => {
    const vars = {
      ...ON,
      FILES_MAX_FILE_BYTES: String(1024 * 1024),
      FILES_MAX_BYTES_PER_ARTIFACT: String(1024 * 1024),
      FILES_MAX_BYTES_PER_UPLOADER: String(1024 * 1024),
      FILES_MAX_BYTES_PER_USER: String(1024 * 1024),
    };
    const { owner, id, ownerP } = await setup();
    const first = await filesApi(id, "", {
      cookie: ownerP.cookie,
      body: { name: "a.png", type: "image/png", size: 1024 * 1024 },
      vars,
    });
    expect(first.status).toBe(201);
    const { body } = await publish(owner.auth, { html: FILES_ONLY, visibility: "allowlist" });
    const second = body.id as string;
    const s = await browserSession(owner.user.id);
    const cookie = await cookieFor(second, s.headers);
    const res = await filesApi(second, "", {
      cookie,
      body: { name: "a.png", type: "image/png", size: 10 },
      vars,
    });
    expect(res.status).toBe(403);
    expect((await errOf(res)).details.limit).toBe("user_bytes");
  });

  it("limits uploads per person per hour, with Retry-After", async () => {
    const { id, ownerP } = await setup();
    const vars = { ...ON, FILES_UPLOADS_PER_UPLOADER_PER_HOUR: "2" };
    for (let i = 0; i < 2; i++) {
      const r = await filesApi(id, "", {
        cookie: ownerP.cookie,
        body: { name: "a.png", type: "image/png", size: 10 },
        vars,
      });
      expect(r.status).toBe(201);
      // Finish nothing; cancel so the pending cap stays out of the way.
      await filesApi(id, `/${(await json(r)).file.id}`, {
        method: "DELETE",
        cookie: ownerP.cookie,
        vars,
      });
    }
    const limited = await filesApi(id, "", {
      cookie: ownerP.cookie,
      body: { name: "a.png", type: "image/png", size: 10 },
      vars,
    });
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
  });
});

describe("files API: deletes", () => {
  it("lets the uploader, the owner and editors delete a ready file; others cannot", async () => {
    const { id, ownerP } = await setup(FILES_PAGE_UNLISTED, "unlisted");
    const a = await person(id, "commenter");
    const b = await person(id, "commenter");
    const editor = await person(id, "editor");
    const del = (who: string | null, fid: string) =>
      filesApi(id, `/${fid}`, { method: "DELETE", cookie: who });
    const f1 = await upload(id, a, png(), "image/png");
    expect((await del(b.cookie, f1.id)).status).toBe(403);
    const anon = await cookieFor(id);
    const ro = await del(anon, f1.id);
    expect(ro.status).toBe(403);
    expect((await errOf(ro)).details).toEqual({ reason: "read_only" });
    expect((await del(a.cookie, f1.id)).status).toBe(204);
    // A ready file's object and row go right after the answer.
    await vi.waitFor(async () => expect(await fileRow(f1.id)).toBeNull());
    expect((await filesApi(id, `/${f1.id}`, { cookie: a.cookie })).status).toBe(404);
    const f2 = await upload(id, a, png(), "image/png");
    expect((await del(editor.cookie, f2.id)).status).toBe(204);
    const f3 = await upload(id, a, png(), "image/png");
    expect((await del(ownerP.cookie, f3.id)).status).toBe(204);
    expect((await usage(id)).files).toBe(0);
  });

  it("cancels a pending upload for its uploader only; to anyone else it does not exist", async () => {
    const { id, ownerP } = await setup();
    const viewer = await person(id, "viewer");
    const created = await json(
      await create(id, viewer.cookie, { name: "a.png", type: "image/png", size: 300 }),
    );
    const fid = created.file.id as string;
    expect(
      (await filesApi(id, `/${fid}`, { method: "DELETE", cookie: ownerP.cookie })).status,
    ).toBe(404);
    expect(
      (
        await filesApi(id, `/${fid}/parts/1`, {
          method: "PUT",
          cookie: ownerP.cookie,
          body: { data: b64(png(300)) },
        })
      ).status,
    ).toBe(404);
    expect(
      (await filesApi(id, `/${fid}`, { method: "DELETE", cookie: viewer.cookie })).status,
    ).toBe(204);
    const row = await fileRow(fid);
    expect(row?.state).toBe("deleting");
    // The cancelled upload's next part finds nothing.
    const late = await filesApi(id, `/${fid}/parts/1`, {
      method: "PUT",
      cookie: viewer.cookie,
      body: { data: b64(png(300)) },
    });
    expect(late.status).toBe(404);
  });

  it(
    "a takedown or a delete while an upload is in flight: the next part finds nothing",
    async () => {
      for (const how of ["takedown", "delete"] as const) {
        const { owner, id, ownerP } = await setup();
        const size = FILE_LIMITS.partBytes + 100;
        const bytes = mp4(size);
        const created = await json(
          await create(id, ownerP.cookie, { name: "a.mp4", type: "video/mp4", size }),
        );
        const fid = created.file.id as string;
        const first = await filesApi(id, `/${fid}/parts/1`, {
          method: "PUT",
          cookie: ownerP.cookie,
          body: { data: b64(bytes.subarray(0, FILE_LIMITS.partBytes)) },
        });
        expect(first.status).toBe(200);
        if (how === "takedown") await takeDown(id);
        else {
          const r = await call(`/api/v1/artifacts/${id}`, {
            method: "DELETE",
            headers: owner.auth,
          });
          expect(r.status).toBeLessThan(300);
        }
        const next = await filesApi(id, `/${fid}/parts/2`, {
          method: "PUT",
          cookie: ownerP.cookie,
          body: { data: b64(bytes.subarray(FILE_LIMITS.partBytes)) },
        });
        expect([401, 404], how).toContain(next.status);
        const row = await fileRow(fid);
        expect(row?.state ?? "gone", how).not.toBe("ready");
      }
    },
    BIG_BUNDLE_TIMEOUT_MS,
  );
});

describe("files API: changes", () => {
  it("moves the counter when a file becomes ready and when one is deleted", async () => {
    const { id, ownerP } = await setup();
    const seq = async () =>
      (await json(await filesApi(id, "/changes", { cookie: ownerP.cookie }))).seq;
    const s0 = await seq();
    const f = await upload(id, ownerP, png(), "image/png");
    const s1 = await seq();
    expect(s1).toBeGreaterThan(s0);
    await filesApi(id, `/${f.id}`, { method: "DELETE", cookie: ownerP.cookie });
    expect(await seq()).toBeGreaterThan(s1);
    const session = await json(await filesApi(id, "/session", { cookie: ownerP.cookie }));
    expect(session.seq).toBe(await seq());
  });
});

describe("files API: unfinished uploads past their deadline", () => {
  const expire = (ids: readonly string[]) =>
    env.DB.batch(
      ids.map((f) =>
        env.DB.prepare("UPDATE artifact_files SET expires_at = ?2 WHERE id = ?1").bind(
          f,
          Date.now() - 1,
        ),
      ),
    );

  it("stop counting toward the pending cap and the totals at the next upload, with no sweep", async () => {
    const { id } = await setup();
    const viewer = await person(id, "viewer");
    const start = () => create(id, viewer.cookie, { name: "a.png", type: "image/png", size: 1000 });
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const r = await start();
      expect(r.status).toBe(201);
      ids.push((await json(r)).file.id as string);
    }
    const blocked = await start();
    expect(blocked.status).toBe(403);
    expect((await errOf(blocked)).details).toEqual({ limit: "pending" });
    // The tab closed, so nothing cancelled them, and their deadline passed.
    await expire(ids);
    const fourth = await start();
    expect(fourth.status).toBe(201);
    expect(await usage(id)).toMatchObject({ files: 1, bytes: 1000 });
    for (const f of ids) expect((await fileRow(f))?.state).toBe("deleting");
  });

  it("free the owner's file bytes on their other artifacts too", async () => {
    const vars = {
      ...ON,
      FILES_MAX_FILE_BYTES: String(1024 * 1024),
      FILES_MAX_BYTES_PER_ARTIFACT: String(1024 * 1024),
      FILES_MAX_BYTES_PER_UPLOADER: String(1024 * 1024),
      FILES_MAX_BYTES_PER_USER: String(1024 * 1024),
    };
    const { owner, id, ownerP } = await setup();
    const first = await filesApi(id, "", {
      cookie: ownerP.cookie,
      body: { name: "a.png", type: "image/png", size: 1024 * 1024 },
      vars,
    });
    expect(first.status).toBe(201);
    const { body } = await publish(owner.auth, { html: FILES_ONLY, visibility: "allowlist" });
    const second = body.id as string;
    const cookie = await cookieFor(second, (await browserSession(owner.user.id)).headers);
    const again = () =>
      filesApi(second, "", {
        cookie,
        body: { name: "b.png", type: "image/png", size: 10 },
        vars,
      });
    expect((await errOf(await again())).details.limit).toBe("user_bytes");
    await expire([(await json(first)).file.id as string]);
    expect((await again()).status).toBe(201);
  });
});

describe("files API: part bodies", () => {
  /** A part body that counts what was read from it: `{"data":"AAAA…` past the part cap. */
  const counted = () => {
    let read = 0;
    const head = new TextEncoder().encode('{"data":"');
    const chunk = new TextEncoder().encode("A".repeat(1024 * 1024));
    const stream = new ReadableStream<Uint8Array>(
      {
        pull(c) {
          if (read > 7 * 1024 * 1024) return c.close();
          const next = read === 0 ? head : chunk;
          read += next.byteLength;
          c.enqueue(next);
        },
      },
      { highWaterMark: 0 },
    );
    return { body: stream as unknown as string, read: () => read };
  };

  it("are never read while files are off, without a pass, without the declaration, or for a reader who cannot upload", async () => {
    const { id, ownerP } = await setup(FILES_PAGE_UNLISTED, "unlisted");
    const data = await setup(DATA_ONLY);
    const fid = "0123456789abcdefghij";
    const anon = await cookieFor(id);
    const cases: [string, string, string | null, Record<string, string>, number][] = [
      ["files off", id, ownerP.cookie, { ALLOW_FILES: "false" }, 404],
      ["opaque isolation", id, ownerP.cookie, { CONTENT_ISOLATION: "opaque" }, 404],
      ["no pass", id, null, {}, 401],
      ["not declared", data.id, data.ownerP.cookie, {}, 404],
      ["an anonymous link viewer", id, anon, {}, 403],
    ];
    for (const [what, artifact, cookie, vars, status] of cases) {
      const b = counted();
      const res = await filesApi(artifact, `/${fid}/parts/1`, {
        method: "PUT",
        cookie,
        body: b.body,
        vars,
      });
      expect(res.status, what).toBe(status);
      noCors(res);
      expect(b.read(), what).toBe(0);
    }
    // The JSON type is still checked before anything else.
    const form = await filesApi(id, `/${fid}/parts/1`, {
      method: "PUT",
      body: "data=1",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      vars: { ALLOW_FILES: "false" },
    });
    expect(form.status).toBe(400);
  });

  it(
    "answer a re-sent part from the row, never writing it to R2 again",
    async () => {
      const { id, ownerP } = await setup();
      const size = FILE_LIMITS.partBytes + 100;
      const bytes = mp4(size);
      const writes: number[] = [];
      const FILES = new Proxy(env.FILES, {
        get(t, k) {
          if (k === "resumeMultipartUpload") {
            return (key: string, uploadId: string) => {
              const mp = t.resumeMultipartUpload(key, uploadId);
              return new Proxy(mp, {
                get(m, j) {
                  if (j === "uploadPart") {
                    return (n: number, value: Uint8Array) => {
                      writes.push(n);
                      return m.uploadPart(n, value);
                    };
                  }
                  const v = Reflect.get(m, j);
                  return typeof v === "function" ? v.bind(m) : v;
                },
              });
            };
          }
          const v = Reflect.get(t, k);
          return typeof v === "function" ? v.bind(t) : v;
        },
      });
      const vars = { FILES } as unknown as Record<string, string>;
      const created = await json(
        await filesApi(id, "", {
          cookie: ownerP.cookie,
          body: { name: "clip.mp4", type: "video/mp4", size },
          vars,
        }),
      );
      const fid = created.file.id as string;
      const part = (n: number) =>
        filesApi(id, `/${fid}/parts/${n}`, {
          method: "PUT",
          cookie: ownerP.cookie,
          body: {
            data: b64(bytes.subarray((n - 1) * FILE_LIMITS.partBytes, n * FILE_LIMITS.partBytes)),
          },
          vars,
        });
      for (let i = 0; i < 4; i++) {
        expect(await json(await part(1))).toEqual({ parts_done: 1, parts: 2 });
      }
      expect(writes).toEqual([1]);
      const last = await json(await part(2));
      expect(last).toMatchObject({ parts_done: 2, parts: 2, file: { id: fid, size } });
      expect(writes).toEqual([1, 2]);
      const obj = await env.FILES.get((await fileRow(fid))?.r2_key as string);
      expect(new Uint8Array(await (obj as R2ObjectBody).arrayBuffer())).toEqual(bytes);
    },
    BIG_BUNDLE_TIMEOUT_MS,
  );

  it("are limited per person per hour, before the body is read", async () => {
    const { id, ownerP } = await setup();
    // One upload an hour, of files of one part: four part requests (a send and three retries).
    const vars = {
      ...ON,
      FILES_UPLOADS_PER_UPLOADER_PER_HOUR: "1",
      FILES_MAX_FILE_BYTES: String(1024 * 1024),
      FILES_MAX_BYTES_PER_UPLOADER: String(1024 * 1024),
    };
    const bytes = png(300);
    const created = await json(
      await filesApi(id, "", {
        cookie: ownerP.cookie,
        body: { name: "a.png", type: "image/png", size: 300 },
        vars,
      }),
    );
    const fid = created.file.id as string;
    const put = (body: unknown) =>
      filesApi(id, `/${fid}/parts/1`, { method: "PUT", cookie: ownerP.cookie, body, vars });
    for (let i = 0; i < FILE_LIMITS.sendsPerPart; i++) {
      expect((await put({ data: b64(bytes) })).status).toBe(200);
    }
    const b = counted();
    const limited = await put(b.body);
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(b.read()).toBe(0);
  });
});
