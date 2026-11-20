// REST mirror of get_design_system. Same service, same policy, same validation as the MCP tool.
import { API, getDesignSystemInput } from "@plinth/shared";
import { Hono } from "hono";
import { getDesignSystem } from "../services/designSystems.ts";
import { type AppEnv, parseInput, serviceCtx } from "./context.ts";

export const designSystemsApi = new Hono<AppEnv>();

/** Comma-separated query values, or undefined when absent or empty. */
const list = (v: string | undefined) =>
  v === undefined || v.trim() === ""
    ? undefined
    : v
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);

designSystemsApi.get(API.designSystem, async (c) => {
  const v = c.req.query("version");
  const input = parseInput(getDesignSystemInput, {
    id: c.req.param("ref"),
    // A query string is text: a non-number fails the schema's integer check (400).
    version: v === undefined || v === "" ? undefined : Number(v),
    include: list(c.req.query("include")),
    components: list(c.req.query("components")),
  });
  return c.json(await getDesignSystem(serviceCtx(c), input));
});
