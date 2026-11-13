// OpenAPI document for /api/v1 (workstream: docs fills in every route from the shared schemas).
import type { Config } from "../config.ts";

export function openApiDocument(config: Config): Record<string, unknown> {
  return {
    openapi: "3.1.0",
    info: { title: "Plinth API", version: "1.0.0" },
    servers: [{ url: `${config.appOrigin}/api/v1` }],
    paths: {},
  };
}
