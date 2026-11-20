// A JSON Schema for system.json (format plinth.design-system/1), for the source editor: Monaco's
// JSON language service flags shape mistakes and offers completion while the author types. It
// describes the shape only. parseDesignSystem (designSystem.ts) is the authority on every rule:
// the Worker refuses what it refuses, and the editor shows its problems under the source.
import { DESIGN_SYSTEM_FORMAT, DS_COMPONENT_STATUSES, DS_TOKEN_TYPES } from "./designSystem.ts";

const name = { type: "string", pattern: "^[A-Za-z0-9_-]{1,64}$" };

export const designSystemJsonSchema = {
  $schema: "http://json-schema.org/draft-07/schema#",
  title: "Plinth design system",
  type: "object",
  additionalProperties: false,
  required: ["format", "name", "tokens"],
  properties: {
    format: { const: DESIGN_SYSTEM_FORMAT },
    name: { type: "string", minLength: 1, maxLength: 120 },
    description: { type: "string", description: "Markdown" },
    prefix: {
      type: "string",
      pattern: "^[a-z][a-z0-9]{0,15}$",
      description: "CSS custom properties are --<prefix>-<token path>. Default ds.",
    },
    fonts: {
      type: "array",
      maxItems: 16,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["family"],
        properties: {
          family: { type: "string", pattern: "^[A-Za-z0-9 _-]{1,64}$" },
          google: { type: "string", pattern: "^https://fonts\\.googleapis\\.com/css2\\?" },
          src: {
            type: "string",
            description: "A .woff2, .woff, .ttf or .otf asset of this version",
          },
          weight: { type: "string", pattern: "^\\d{3}( \\d{3})?$" },
          style: { enum: ["normal", "italic"] },
        },
      },
    },
    tokens: { $ref: "#/definitions/group" },
    themes: {
      type: "object",
      additionalProperties: false,
      properties: { dark: { $ref: "#/definitions/themeGroup" } },
    },
    guidelines: { type: "string", description: "Markdown" },
    css: { type: "string", description: "CSS shared by every component" },
    components: {
      type: "array",
      maxItems: 200,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "name", "examples"],
        properties: {
          id: { type: "string", pattern: "^[a-z][a-z0-9-]{0,47}$" },
          name: { type: "string", minLength: 1, maxLength: 120 },
          status: { enum: [...DS_COMPONENT_STATUSES] },
          description: { type: "string" },
          usage: { type: "string" },
          css: { type: "string" },
          examples: {
            type: "array",
            minItems: 1,
            maxItems: 20,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["name", "html"],
              properties: {
                name: { type: "string", minLength: 1, maxLength: 80 },
                html: { type: "string", minLength: 1 },
                height: { type: "integer", minimum: 40, maximum: 1200 },
              },
            },
          },
        },
      },
    },
  },
  definitions: {
    group: {
      type: "object",
      properties: {
        $type: { enum: [...DS_TOKEN_TYPES] },
        $description: { type: "string" },
        $deprecated: { type: ["boolean", "string"] },
        $extensions: { type: "object" },
      },
      propertyNames: {
        anyOf: [{ enum: ["$type", "$description", "$deprecated", "$extensions"] }, name],
      },
      additionalProperties: {
        anyOf: [{ $ref: "#/definitions/token" }, { $ref: "#/definitions/group" }],
      },
    },
    token: {
      type: "object",
      required: ["$value"],
      additionalProperties: false,
      properties: {
        $value: {},
        $type: { enum: [...DS_TOKEN_TYPES] },
        $description: { type: "string" },
        $deprecated: { type: ["boolean", "string"] },
        $extensions: { type: "object" },
      },
    },
    themeGroup: {
      type: "object",
      propertyNames: name,
      additionalProperties: {
        anyOf: [
          {
            type: "object",
            required: ["$value"],
            additionalProperties: false,
            properties: { $value: {} },
          },
          { $ref: "#/definitions/themeGroup" },
        ],
      },
    },
  },
} as const;
