// Personal access tokens and agent connections; OAuth consent endpoints (workstream: OAuth).
import { Hono } from "hono";
import type { AppEnv } from "./context.ts";

export const connectionsApi = new Hono<AppEnv>();
