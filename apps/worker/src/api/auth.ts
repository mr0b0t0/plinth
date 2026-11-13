// Sign-in for people: magic link and six-digit code, sessions, logout (workstream: accounts).
import { Hono } from "hono";
import type { AppEnv } from "./context.ts";

export const authApi = new Hono<AppEnv>();
