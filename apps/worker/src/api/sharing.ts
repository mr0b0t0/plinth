// Sharing settings: allowlist and collaborator roles (workstream: dashboard and sharing).
import { Hono } from "hono";
import type { AppEnv } from "./context.ts";

export const sharingApi = new Hono<AppEnv>();
