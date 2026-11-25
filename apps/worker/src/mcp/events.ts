// The MCP events extension (io.modelcontextprotocol/events, SEP-3415) for mention wake-ups
// (docs/spec.md "Mention wake-ups"): events/list, events/subscribe, events/unsubscribe and
// events/poll, for the one event type `mention.created` (services/mentionEvents.ts).
//
// Both the extension and the design sketch it grew from are advertised: ChatGPT reads the sketch's
// top-level `events` capability, SEP-3415 clients the `extensions` entry. A request that declares
// the extension in its per-request client capabilities is answered as SEP-3415 (its error codes,
// its webhook-id rule); any other as the sketch.
import { type McpServer, ProtocolError } from "@modelcontextprotocol/server";
import { MCP_EVENTS_EXTENSION } from "@plinth/shared";
import { z } from "zod";
import type { Ctx } from "../services/context.ts";
import {
  EventsError,
  type EventsProfile,
  MENTION_CREATED,
  pollEvents,
  subscribe,
  unsubscribe,
} from "../services/mentionEvents.ts";
import type { RequestExtra } from "./tasks.ts";

const CLIENT_CAPABILITIES_KEY = "io.modelcontextprotocol/clientCapabilities";

/** SEP-3415 when the request declares the extension, else the sketch ChatGPT implements. */
export function eventsProfile(extra: RequestExtra | undefined): EventsProfile {
  const req = extra?.mcpReq;
  const caps = (req?.envelope?.[CLIENT_CAPABILITIES_KEY] ??
    req?._meta?.[CLIENT_CAPABILITIES_KEY]) as { extensions?: Record<string, unknown> } | undefined;
  return caps?.extensions?.[MCP_EVENTS_EXTENSION] ? "final" : "draft";
}

async function eventsCall<T>(profile: EventsProfile, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof EventsError) throw new ProtocolError(e.code(profile), e.kind, e.data);
    throw e;
  }
}

const params = z.object({}).passthrough();

export function registerEventMethods(server: McpServer, ctx: Ctx): void {
  const low = server.server as unknown as {
    registerCapabilities(c: Record<string, unknown>): void;
    setRequestHandler(
      method: string,
      schemas: { params: z.ZodTypeAny },
      handler: (params: never, extra: RequestExtra) => Promise<Record<string, unknown>>,
    ): void;
  };
  low.registerCapabilities({ events: {}, extensions: { [MCP_EVENTS_EXTENSION]: {} } });

  low.setRequestHandler("events/list", { params }, async () => ({ events: [MENTION_CREATED] }));

  low.setRequestHandler(
    "events/subscribe",
    { params },
    async (p: Record<string, unknown>, extra) => {
      const profile = eventsProfile(extra);
      return eventsCall(profile, () => subscribe(ctx, p, profile));
    },
  );

  low.setRequestHandler(
    "events/unsubscribe",
    { params },
    async (p: Record<string, unknown>, extra) =>
      eventsCall(eventsProfile(extra), () => unsubscribe(ctx, p)),
  );

  low.setRequestHandler("events/poll", { params }, async (p: Record<string, unknown>, extra) =>
    eventsCall(eventsProfile(extra), () => pollEvents(ctx, p)),
  );
}
