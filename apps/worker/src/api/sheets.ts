// REST mirrors of read_sheet and edit_sheet. Same services, same policy, same validation as the MCP
// tools; a session's write passes the CSRF and exact-Origin checks of every REST write.
import { API, editSheetInput, readSheetInput } from "@plinth/shared";
import { Hono } from "hono";
import { editSheet, readSheet } from "../services/sheets.ts";
import { type AppEnv, parseInput, serviceCtx } from "./context.ts";

export const sheetsApi = new Hono<AppEnv>();

sheetsApi.get(API.sheet, async (c) => {
  const q = (k: string) => {
    const v = c.req.query(k);
    return v === undefined || v === "" ? undefined : v;
  };
  const version = q("version");
  const limit = q("limit_cells");
  const values = q("values");
  const input = parseInput(readSheetInput, {
    id: c.req.param("ref"),
    // A query string is text: a non-number fails the schema's integer check (400).
    version: version === undefined ? undefined : Number(version),
    range: q("range"),
    values:
      values === undefined
        ? undefined
        : values === "true"
          ? true
          : values === "false"
            ? false
            : values,
    limit_cells: limit === undefined ? undefined : Number(limit),
  });
  return c.json(await readSheet(serviceCtx(c), input));
});

sheetsApi.post(API.sheetEdits, async (c) => {
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  const input = parseInput(editSheetInput, { ...(body ?? {}), id: c.req.param("ref") });
  return c.json(await editSheet(serviceCtx(c), input), 201);
});
