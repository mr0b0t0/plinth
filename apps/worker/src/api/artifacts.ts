// REST mirror of the artifact MCP tools. Same services, same policy, same validation.
import {
  getArtifactInput,
  listArtifactsInput,
  publishArtifactInput,
  renameArtifactInput,
  restoreVersionInput,
  setVisibilityInput,
  updateArtifactInput,
} from "@plinth/shared";
import { Hono } from "hono";
import {
  deleteArtifact,
  getArtifact,
  listArtifacts,
  listVersions,
  publishArtifact,
  renameArtifact,
  restoreVersion,
  setVisibility,
  updateArtifact,
} from "../services/artifacts.ts";
import { type AppEnv, parseBody, parseInput, serviceCtx } from "./context.ts";

export const artifactsApi = new Hono<AppEnv>();

artifactsApi.get("/artifacts", async (c) => {
  const { query } = parseInput(listArtifactsInput, {
    query: c.req.query("query") ?? c.req.query("q"),
  });
  return c.json({ items: await listArtifacts(serviceCtx(c), query) });
});

artifactsApi.post("/artifacts", async (c) => {
  const input = await parseBody(c, publishArtifactInput);
  return c.json(await publishArtifact(serviceCtx(c), input), 201);
});

artifactsApi.get("/artifacts/:ref", async (c) => {
  const v = c.req.query("version");
  const input = parseInput(getArtifactInput, {
    id: c.req.param("ref"),
    version: v ? Number(v) : undefined,
  });
  return c.json(await getArtifact(serviceCtx(c), input.id, input.version));
});

artifactsApi.put("/artifacts/:ref", async (c) => {
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  const input = parseInput(updateArtifactInput, { ...(body ?? {}), id: c.req.param("ref") });
  return c.json(await updateArtifact(serviceCtx(c), input));
});

artifactsApi.patch("/artifacts/:ref", async (c) => {
  const { title } = await parseBody(c, renameArtifactInput);
  return c.json(await renameArtifact(serviceCtx(c), c.req.param("ref"), title));
});

artifactsApi.delete("/artifacts/:ref", async (c) => {
  await deleteArtifact(serviceCtx(c), c.req.param("ref"));
  return c.body(null, 204);
});

artifactsApi.get("/artifacts/:ref/versions", async (c) => {
  return c.json({ items: await listVersions(serviceCtx(c), c.req.param("ref")) });
});

artifactsApi.get("/artifacts/:ref/versions/:n", async (c) => {
  const input = parseInput(getArtifactInput, {
    id: c.req.param("ref"),
    version: Number(c.req.param("n")),
  });
  return c.json(await getArtifact(serviceCtx(c), input.id, input.version));
});

artifactsApi.post("/artifacts/:ref/versions/:n/restore", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const input = parseInput(restoreVersionInput, {
    ...body,
    id: c.req.param("ref"),
    version: Number(c.req.param("n")),
  });
  return c.json(
    await restoreVersion(serviceCtx(c), input.id, input.version, input.base_version),
    201,
  );
});

artifactsApi.put("/artifacts/:ref/visibility", async (c) => {
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  const input = parseInput(setVisibilityInput, { ...(body ?? {}), id: c.req.param("ref") });
  return c.json(await setVisibility(serviceCtx(c), input));
});
