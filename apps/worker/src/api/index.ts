// /api/v1 on APP_HOST. Each workstream owns one router file; this file only mounts them.
import { API, LIMITS } from "@plinth/shared";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { orRunCliPublish } from "../app/version.ts";
import { ApiError } from "../lib/errors.ts";
import { artifactsApi } from "./artifacts.ts";
import { authApi } from "./auth.ts";
import { categoriesApi } from "./categories.ts";
import { categorySharesApi } from "./categoryShares.ts";
import { commentsApi } from "./comments.ts";
import { connectionsApi } from "./connections.ts";
import { type AppEnv, authenticate } from "./context.ts";
import { dataApi } from "./data.ts";
import { designSystemsApi } from "./designSystems.ts";
import { liveApi } from "./live.ts";
import { meApi } from "./me.ts";
import { portalsApi } from "./portals.ts";
import { reportsApi } from "./reports.ts";
import { sharingApi } from "./sharing.ts";
import { sheetsApi } from "./sheets.ts";
import { statsApi } from "./stats.ts";
import { bundleHandler, requireBearerHeader, uploadStatusHandler, uploadsApi } from "./uploads.ts";
import { viewApi } from "./view.ts";

export const api = new Hono<AppEnv>();

api.use("*", async (c, next) => {
  await next();
  c.header("Cache-Control", c.res.headers.get("Cache-Control") ?? "no-store");
});
// The bundle upload streams its own body (up to maxBundleBytes, every bound enforced while reading)
// and authenticates with its upload token alone, so it sits before the JSON body limit and before
// `authenticate`: no cookie is read and no session or viewer principal can attach to it.
api.post(API.uploadBundle, bundleHandler());
// Its status read (whether a bundle whose answer was lost committed) takes the same token only.
api.get(API.uploadStatus, uploadStatusHandler);
// JSON bodies: inline sources and assets, base64-encoded, plus JSON overhead.
api.use(
  "*",
  bodyLimit({
    maxSize: LIMITS.maxInlineRequestBytes,
    onError: () => {
      throw new ApiError(
        "payload_too_large",
        `Request body is over ${LIMITS.maxInlineRequestBytes / 1024 / 1024} MB. Inline assets travel as base64; send a build with start_upload or the CLI`,
        {
          limit_bytes: LIMITS.maxInlineRequestBytes,
          next: `Send unchanged files as {path, sha256}; for a build folder call start_upload${orRunCliPublish()}`,
        },
      );
    },
  }),
);
// start_upload over REST is bearer only: refused before `authenticate` looks at any cookie.
api.use(API.uploads, requireBearerHeader);
api.use("*", authenticate);

api.route("/", meApi);
api.route("/", authApi);
api.route("/", connectionsApi);
api.route("/", artifactsApi);
api.route("/", categoriesApi);
api.route("/", viewApi);
api.route("/", sharingApi);
api.route("/", commentsApi);
api.route("/", reportsApi);
api.route("/", statsApi);
api.route("/", dataApi);
api.route("/", liveApi);
api.route("/", uploadsApi);
api.route("/", designSystemsApi);
api.route("/", categorySharesApi);
api.route("/", portalsApi);
api.route("/", sheetsApi);

api.all("*", () => {
  throw new ApiError("not_found", "No such API endpoint");
});
