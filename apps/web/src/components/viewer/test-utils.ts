// Test helpers: a fetch stub that routes /api/v1 calls to handlers, and a fixed config.
import type { AppConfig, Me } from "@plinth/shared";
import { vi } from "vitest";

export const CONFIG: AppConfig = {
  app_origin: "http://app.localhost:8787",
  content_host: "content.localhost:8787",
  content_protocol: "http:",
  single_user_mode: false,
  public_visibility_enabled: false,
  content_path_fallback: false,
  content_isolation: "origin",
  environment: "development",
  operator: {
    name: "Example Operator, Lda.",
    address: "Rua Exemplo 1, 1000-001 Lisboa, Portugal",
    registration: "VAT PT000000000",
    email: "hello@example.org",
    hosting: "Cloudflare",
  },
  email_provider: "sendgrid",
  max_artifacts_per_user: 100,
};

export const ME: Me = {
  id: "u1",
  email: "ada@example.org",
  name: null,
  created_at: "2026-11-01T00:00:00.000Z",
  artifact_limit: 100,
  artifact_count: 1,
  is_admin: false,
};

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export const apiError = (status: number, code: string, message = "error") =>
  json({ error: { code, message } }, status);

export interface Call {
  method: string;
  path: string;
  body: unknown;
  /** Request headers, names lowercased. */
  headers: Record<string, string>;
}

type Handler = (call: Call) => Response | Promise<Response> | undefined;

/**
 * Stub fetch. `me` null answers /me with 401. Handlers get calls under /api/v1 (path includes the
 * query) and return a Response, or undefined to fall through to a 404. `config` replaces CONFIG.
 */
export function stubApi(opts: { me?: Me | null; handle?: Handler; config?: AppConfig } = {}) {
  const calls: Call[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://app.localhost:8787");
    const path = `${url.pathname.replace(/^\/api\/v1/, "")}${url.search}`;
    const call: Call = {
      method: init?.method ?? "GET",
      path,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      headers: Object.fromEntries(new Headers(init?.headers)),
    };
    calls.push(call);
    if (path === "/config") return json(opts.config ?? CONFIG);
    if (path === "/me") return opts.me ? json(opts.me) : apiError(401, "unauthorized");
    return (await opts.handle?.(call)) ?? apiError(404, "not_found", "Not found");
  });
  vi.stubGlobal("fetch", fetchMock);
  return { calls, fetchMock };
}
