// Comments, anchors, mention tasks and reply_comment over REST (workstream: comments).
import { Hono } from "hono";
import type { AppEnv } from "./context.ts";

export const commentsApi = new Hono<AppEnv>();
