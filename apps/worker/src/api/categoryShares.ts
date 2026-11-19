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
import { Hono } from "hono";
import {
  createShare,
  deleteShare,
  getShare,
  listShares,
  previewShare,
  reviewShare,
  updateShare,
} from "../services/categoryShares.ts";
import { type AppEnv, parseBody, serviceCtx } from "./context.ts";

export const categorySharesApi = new Hono<AppEnv>();

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
