// /api/v1 on APP_HOST. Each workstream owns one router file; this file only mounts them.
import { Hono } from "hono";
import { ApiError } from "../lib/errors.ts";
import { artifactsApi } from "./artifacts.ts";
import { authApi } from "./auth.ts";
import { commentsApi } from "./comments.ts";
import { connectionsApi } from "./connections.ts";
import { type AppEnv, authenticate } from "./context.ts";
import { meApi } from "./me.ts";
import { reportsApi } from "./reports.ts";
import { sharingApi } from "./sharing.ts";
import { viewApi } from "./view.ts";

export const api = new Hono<AppEnv>();

api.use("*", async (c, next) => {
  await next();
  c.header("Cache-Control", c.res.headers.get("Cache-Control") ?? "no-store");
});
api.use("*", authenticate);

api.route("/", meApi);
api.route("/", authApi);
api.route("/", connectionsApi);
api.route("/", artifactsApi);
api.route("/", viewApi);
api.route("/", sharingApi);
api.route("/", commentsApi);
api.route("/", reportsApi);

api.all("*", () => {
  throw new ApiError("not_found", "No such API endpoint");
});
