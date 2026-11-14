// Out-of-band uploads: POST /uploads (start_upload, bearer only) and POST /uploads/:id/bundle
// (the upload token only). Contract placeholder: both routes exist so the API map, the OpenAPI
// document and the router agree; they refuse every request until the uploads work lands.
import { API } from "@plinth/shared";
import { Hono } from "hono";
import { ApiError } from "../lib/errors.ts";
import type { AppEnv } from "./context.ts";

export const uploadsApi = new Hono<AppEnv>();

const unavailable = () => {
  throw new ApiError("feature_disabled", "Uploads are not available on this instance");
};

uploadsApi.post(API.uploads, unavailable);
uploadsApi.post(API.uploadBundle, unavailable);
