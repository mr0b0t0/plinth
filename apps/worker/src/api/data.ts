// REST mirror of the shared-data MCP tools (list_artifact_data, write_artifact_data), plus the
// owner's "delete all shared data". Bearer requests write via "agent", cookie requests via "app"
// (and pass the CSRF check in context.ts). Same services, same policy, same validation.
import { API, listArtifactDataInput, writeArtifactDataInput } from "@plinth/shared";
import { Hono } from "hono";
import {
  clearArtifactData,
  listArtifactData,
  writeArtifactData,
} from "../services/artifactData.ts";
import { type AppContext, type AppEnv, parseBody, parseInput, serviceCtx } from "./context.ts";

export const dataApi = new Hono<AppEnv>();

const writeBody = writeArtifactDataInput.omit({ id: true });

function pageQuery(c: AppContext) {
  const limit = c.req.query("limit");
  return {
    limit: limit === undefined ? undefined : Number(limit),
    cursor: c.req.query("cursor") || undefined,
  };
}

dataApi.get(API.data, async (c) => {
  const input = parseInput(listArtifactDataInput, { id: c.req.param("ref") });
  return c.json(await listArtifactData(serviceCtx(c), input));
});

dataApi.post(API.data, async (c) => {
  const { ops } = await parseBody(c, writeBody);
  const input = parseInput(writeArtifactDataInput, { id: c.req.param("ref"), ops });
  return c.json(await writeArtifactData(serviceCtx(c), input));
});

dataApi.delete(API.data, async (c) => {
  return c.json(await clearArtifactData(serviceCtx(c), c.req.param("ref")));
});

dataApi.get(API.dataCollection, async (c) => {
  const input = parseInput(listArtifactDataInput, {
    id: c.req.param("ref"),
    collection: c.req.param("collection"),
    ...pageQuery(c),
  });
  return c.json(await listArtifactData(serviceCtx(c), input));
});

dataApi.get(API.dataDoc, async (c) => {
  const input = parseInput(listArtifactDataInput, {
    id: c.req.param("ref"),
    collection: c.req.param("collection"),
    doc_id: c.req.param("doc"),
  });
  return c.json(await listArtifactData(serviceCtx(c), input));
});
