// Cloudflare Worker: app host, content host, /mcp and /api/v1, routed by hostname.
// Placeholder until milestone 1 adds Hono, wrangler and the Workers types.
import { PRODUCT_NAME } from "@plinth/shared";

export const name = PRODUCT_NAME;
