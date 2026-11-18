// On-page doc editing (#36): the live draft of a doc, for signed-in owners and editors in the app
// (session cookie, CSRF and the exact Origin from `authenticate`). Agents are refused by policy
// (`live_edit`): they publish versions. Not mirrored to MCP.
import { API, liveCheckpointInput, liveDiscardQuery } from "@plinth/shared";
import { Hono } from "hono";
import { discardLiveDraft, getLiveDraft, getLiveInfo, liveCheckpoint } from "../services/live.ts";
import { type AppEnv, parseInput, serviceCtx } from "./context.ts";

export const liveApi = new Hono<AppEnv>();

liveApi.get(API.live, async (c) => c.json(await getLiveInfo(serviceCtx(c), c.req.param("ref"))));

liveApi.get(API.liveDraft, async (c) =>
  c.json(await getLiveDraft(serviceCtx(c), c.req.param("ref"))),
);

// Policy runs before the input is validated, so strangers learn nothing from a 400.
liveApi.post(API.liveCheckpoint, async (c) => {
  const raw = await c.req.json().catch(() => undefined);
  return c.json(
    await liveCheckpoint(serviceCtx(c), c.req.param("ref"), () =>
      parseInput(liveCheckpointInput, raw),
    ),
  );
});

liveApi.delete(API.liveDraft, async (c) => {
  const rev = c.req.query("rev");
  await discardLiveDraft(
    serviceCtx(c),
    c.req.param("ref"),
    () => parseInput(liveDiscardQuery, { rev }).rev,
  );
  return c.body(null, 204);
});
