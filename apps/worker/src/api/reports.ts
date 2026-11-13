// Abuse reports and the admin takedown queue (workstream: content and hosted flags).
import { Hono } from "hono";
import type { AppEnv } from "./context.ts";

export const reportsApi = new Hono<AppEnv>();
