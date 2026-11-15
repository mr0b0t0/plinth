// Out-of-band uploads: POST /uploads (start_upload over REST, bearer only) and
// POST /uploads/:id/bundle (the upload token only). The bundle route is mounted in api/index.ts
// before the JSON body limit and `authenticate`: it reads no cookies, sends no CORS headers and
// builds its service context from the ticket alone (services/uploads.ts).
import { API, startUploadInput } from "@plinth/shared";
import { type Handler, Hono } from "hono";
import { unauthorized } from "../lib/errors.ts";
import { redeemBundle, type StageDeps, stageDeps, startUpload } from "../services/uploads.ts";
import { type AppEnv, clientIp, parseBody, serviceCtx } from "./context.ts";

export const uploadsApi = new Hono<AppEnv>();

const BEARER_ONLY =
  "POST /uploads takes a bearer token (OAuth access token, personal access token or ADMIN_TOKEN); a session cookie is not accepted";

/**
 * Runs before `authenticate` on POST /uploads: without an Authorization header the request is
 * refused outright, so a browser's cookies (session, CSRF) never reach the mint.
 */
export const requireBearerHeader: Handler<AppEnv> = async (c, next) => {
  if (!c.req.header("authorization")) throw unauthorized(BEARER_ONLY);
  await next();
};

uploadsApi.post(API.uploads, async (c) => {
  if (c.get("authVia") !== "bearer") throw unauthorized(BEARER_ONLY);
  const input = await parseBody(c, startUploadInput);
  return c.json(await startUpload(serviceCtx(c), input), 201);
});

/** POST /uploads/:id/bundle with the given version-writing functions (tests pass fakes). */
export function bundleHandler(deps: StageDeps = stageDeps): Handler<AppEnv> {
  return async (c) => {
    const { status, body } = await redeemBundle(
      {
        env: c.env,
        config: c.get("config"),
        db: c.get("db"),
        ip: clientIp(c),
        waitUntil: (p) => c.executionCtx.waitUntil(p),
      },
      {
        uploadId: c.req.param("id") ?? "",
        authorization: c.req.header("authorization"),
        contentLength: c.req.header("content-length"),
        body: c.req.raw.body,
        signal: c.req.raw.signal,
      },
      deps,
    );
    return c.json(body, status);
  };
}
