// What the MCP server tells agents about making an artifact good, not only valid (the
// plinth-artifacts skill's "Making it good (craft)" and its guides in craft/<type>.md). The
// descriptions carry the shared rules in a line and point at the guides; the guides themselves
// live in the skill, so the tool list stays short for every client.

/**
 * The guide for each type is craft/<type id>.md in the skill folder (apps/worker/test/
 * craft-guides.test.ts checks that each one exists).
 */
const CRAFT_POINTER =
  "The plinth-artifacts skill has a craft guide for each type (craft/<type>.md, such as " +
  "craft/slides.md): read it before you write one.";

/** What publish_artifact says about craft. */
export const CRAFT_NOTE =
  "Make it good, not only valid: lead with the point and put the summary before the detail, take " +
  "every number from data the user gave you or you read (never invent one), add no filler, and " +
  `keep text at 4.5:1 contrast in both themes. ${CRAFT_POINTER} `;

/** What update_artifact says about craft. */
export const CRAFT_UPDATE_NOTE =
  "Change only what was asked: every other word, color, position and setting stays as it is. ";

/** The server instructions' sentence about craft. */
export const CRAFT_INSTRUCTION =
  "Make it read well too: the point first, every number from real data, no filler, and on an " +
  "update only what was asked; the plinth-artifacts skill's craft guides have the rest.";
