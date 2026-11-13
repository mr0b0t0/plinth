// Sign in through the real login flow, reading the code from the dev outbox.
import { type APIRequestContext, expect, type Page } from "@playwright/test";
import { apiPost } from "./api.ts";
import { latestCode } from "./mail.ts";

/** A second of slack so a code sent right now is never filtered out by clock rounding. */
const sinceNow = () => new Date(Date.now() - 1000).toISOString();

/**
 * Sign in through /login in the browser. Contract with the login page: an input labelled "Email",
 * a button "Send sign-in link", an input labelled "Six-digit code" and a button "Sign in".
 * Use a fresh email per test (uniqueEmail()) so an older code is never picked up.
 */
export async function signIn(page: Page, email: string): Promise<void> {
  const since = sinceNow();
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByRole("button", { name: "Send sign-in link" }).click();
  const code = await latestCode(page.request, email, { since });
  await page.getByLabel("Six-digit code").fill(code);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).not.toHaveURL(/\/login(\/|\?|$)/);
}

/**
 * Sign in without the UI: POST /auth/login, read the code, POST /auth/verify-code. The session
 * cookie lands in `request` (use page.request to sign in the page's browser context).
 */
export async function signInApi(request: APIRequestContext, email: string): Promise<void> {
  const since = sinceNow();
  const sent = await apiPost(request, "/auth/login", { email });
  if (sent.status !== 200) throw new Error(`login request failed: ${sent.status}`);
  const code = await latestCode(request, email, { since });
  const verified = await apiPost(request, "/auth/verify-code", { email, code });
  if (verified.status !== 200) throw new Error(`verify-code failed: ${verified.status}`);
}
