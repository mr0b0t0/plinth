// REST for data sources (docs/spec.md "Live data from the owner's agents"): the mirror of
// set_data_sources and get_artifact's data_sources, plus the owner's confirmation, which has no MCP
// tool and refuses every bearer token (policy.ts sources_confirm: the signed-in owner only).
// Cookie requests pass the CSRF check in context.ts. Same services, same policy, same validation;
// the caller's right on the artifact is checked before the body is read, so a stranger learns
// nothing from a validation error.
import {
  API,
  confirmDataSourceInput,
  DATA_SOURCE_ID_RE,
  setDataSourcesInput,
} from "@plinth/shared";
import { Hono } from "hono";
import { ApiError } from "../lib/errors.ts";
import { requireArtifact } from "../services/artifacts.ts";
import {
  confirmDataSource,
  listDataSources,
  removeDataSource,
  setDataSources,
} from "../services/dataSources.ts";
import { type AppEnv, parseInput, serviceCtx } from "./context.ts";

export const dataSourcesApi = new Hono<AppEnv>();

function sourceParam(v: string): string {
  if (!DATA_SOURCE_ID_RE.test(v)) throw new ApiError("not_found", "Data source not found");
  return v;
}

const jsonBody = async (c: { req: { json: () => Promise<unknown> } }) =>
  ((await c.req.json().catch(() => null)) ?? {}) as Record<string, unknown>;

dataSourcesApi.get(API.dataSources, async (c) => {
  return c.json(await listDataSources(serviceCtx(c), c.req.param("ref")));
});

dataSourcesApi.put(API.dataSources, async (c) => {
  const ctx = serviceCtx(c);
  const ref = c.req.param("ref");
  await requireArtifact(ctx, ref, "sources_manage");
  const input = parseInput(setDataSourcesInput, { ...(await jsonBody(c)), id: ref });
  return c.json(await setDataSources(ctx, input));
});

dataSourcesApi.delete(API.dataSource, async (c) => {
  const ctx = serviceCtx(c);
  const ref = c.req.param("ref");
  await requireArtifact(ctx, ref, "sources_manage");
  return c.json(await removeDataSource(ctx, ref, sourceParam(c.req.param("source"))));
});

dataSourcesApi.post(API.dataSourceConfirm, async (c) => {
  const ctx = serviceCtx(c);
  const ref = c.req.param("ref");
  await requireArtifact(ctx, ref, "sources_confirm");
  const input = parseInput(confirmDataSourceInput, await jsonBody(c));
  const source = sourceParam(c.req.param("source"));
  return c.json(await confirmDataSource(ctx, ref, source, input));
});
