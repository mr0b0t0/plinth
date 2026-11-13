// Personal access tokens for e2e tests.
import type { APIRequestContext } from "@playwright/test";
import { apiPost } from "./api.ts";

export { type SeededToken, seedToken } from "./db.ts";

export interface CreatedToken {
  token: string;
  connection: { id: string; label: string; client_type: string; scopes: string[] };
}

/**
 * Create a token the way the Connections page does: POST /api/v1/connections with a signed-in
 * request context (see signIn / signInApi). For setup without signing in, use seedToken().
 */
export async function createToken(
  request: APIRequestContext,
  input: { label?: string; client_type?: "claude" | "codex" | "other"; scopes?: string[] } = {},
): Promise<CreatedToken> {
  const res = await apiPost<CreatedToken>(request, "/connections", {
    label: "E2E token",
    client_type: "other",
    ...input,
  });
  if (res.status !== 201 && res.status !== 200) {
    throw new Error(`POST /connections failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.body;
}
