// Category shares (docs/spec.md "Category sharing and personal categories"): the signed-in owner
// shares a category with people and reviews which of its artifacts they see. Session only (CSRF
// and exact Origin through `authenticate`): agents and bearer tokens get 403 from the service
// (policy.ts mayManageCategoryShares), and there is no MCP tool for any of it.
import {
  API,
  categoryReviewInput,
  createCategoryShareInput,
  updateCategoryShareInput,
} from "@plinth/shared";
import { Hono, type MiddlewareHandler } from "hono";
import {
  createShare,
  deleteShare,
  getShare,
  listShares,
  previewShare,
  refuseBoundToken,
  reviewShare,
  updateShare,
} from "../services/categoryShares.ts";
import { type AppEnv, parseBody, serviceCtx } from "./context.ts";

/**
 * A token limited to one artifact gets 403 `token_bound` from every share, portal and
 * personal-category route before its body is read (the services refuse it too).
 */
export const refuseBoundTokens: MiddlewareHandler<AppEnv> = async (c, next) => {
  refuseBoundToken(c.get("principal"));
  await next();
};

export const categorySharesApi = new Hono<AppEnv>();

categorySharesApi.use(API.categoryShares, refuseBoundTokens);
categorySharesApi.use(`${API.categoryShares}/*`, refuseBoundTokens);

categorySharesApi.get(API.categoryShares, async (c) => {
  return c.json({ items: await listShares(serviceCtx(c)) });
});

categorySharesApi.post(API.categoryShares, async (c) => {
  const ctx = serviceCtx(c);
  const input = await parseBody(c, createCategoryShareInput);
  return c.json(await createShare(ctx, input), 201);
});

// Before the :id route: "preview" is never a share id (ids are 20 lowercase letters and digits).
categorySharesApi.get(API.categorySharePreview, async (c) => {
  return c.json(await previewShare(serviceCtx(c), c.req.query("category") ?? ""));
});

categorySharesApi.get(API.categoryShare, async (c) => {
  return c.json(await getShare(serviceCtx(c), c.req.param("id")));
});

categorySharesApi.patch(API.categoryShare, async (c) => {
  const ctx = serviceCtx(c);
  const input = await parseBody(c, updateCategoryShareInput);
  return c.json(await updateShare(ctx, c.req.param("id"), input));
});

categorySharesApi.delete(API.categoryShare, async (c) => {
  await deleteShare(serviceCtx(c), c.req.param("id"));
  return c.body(null, 204);
});

categorySharesApi.post(API.categoryShareReview, async (c) => {
  const ctx = serviceCtx(c);
  const { items } = await parseBody(c, categoryReviewInput);
  return c.json(await reviewShare(ctx, c.req.param("id"), items));
});
