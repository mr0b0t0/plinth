// The caller's own category names (docs/spec.md "Categories"). Listing is open to the signed-in
// person and to bearer tokens with artifacts:read; renaming, merging and clearing a category across
// artifacts is the signed-in owner's alone (session cookie, CSRF and exact Origin via
// `authenticate`), never an agent or bearer token (policy.ts mayBulkEditCategories).
import { API, myCategoryInput, renameCategoryInput } from "@plinth/shared";
import { Hono } from "hono";
import { listCategories, renameCategory, setMyCategory } from "../services/categories.ts";
import { type AppEnv, parseBody, serviceCtx } from "./context.ts";

export const categoriesApi = new Hono<AppEnv>();

categoriesApi.get(API.categories, async (c) => {
  return c.json({ items: await listCategories(serviceCtx(c)) });
});

categoriesApi.post(API.categoryRename, async (c) => {
  const ctx = serviceCtx(c);
  const input = await parseBody(c, renameCategoryInput);
  return c.json(await renameCategory(ctx, input));
});

/**
 * The signed-in person's own category for an artifact shared with them (issue #42): seen and set
 * by that person only, never by an agent or bearer token, never on their own artifacts.
 */
categoriesApi.put(API.myCategory, async (c) => {
  const ctx = serviceCtx(c);
  const { category } = await parseBody(c, myCategoryInput);
  return c.json(await setMyCategory(ctx, c.req.param("ref"), category));
});
