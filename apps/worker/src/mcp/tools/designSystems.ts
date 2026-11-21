// MCP tools for design systems (type design_system): read one to build another artifact with it.
import { getDesignSystemInput } from "@plinth/shared";
import { getDesignSystem } from "../../services/designSystems.ts";
import { MCP_TOOL_ANNOTATIONS, toolName } from "../catalog.ts";
import { DESIGN_SYSTEM_UNTRUSTED_NOTE, UNTRUSTED_NOTE } from "../notes.ts";
import { run, type ToolRegistrar } from "./context.ts";

export const registerDesignSystemTools: ToolRegistrar = ({ server, ctx }) => {
  server.registerTool(
    toolName("get_design_system"),
    {
      title: "Get design system",
      annotations: MCP_TOOL_ANNOTATIONS.get_design_system,
      description:
        "Read a design system (type design_system) to build another artifact with it: its tokens " +
        "resolved to values, css (custom properties for light and dark; put it in a <style> in your " +
        "page or in an asset such as tokens.css, and use var(--<prefix>-...)), font_links (Google " +
        "Fonts stylesheets to add as <link>), guidelines (Markdown) and component examples (HTML and " +
        "CSS to adapt). Any design system the user can open works, including ones shared with them; " +
        "list_artifacts with type design_system finds them (default: true marks the user's default, " +
        "to use without asking). Pages cannot load another artifact's files at runtime: install the " +
        "design system by passing install.copy_files as copy_files to publish_artifact or " +
        "update_artifact (the server copies tokens.css, fonts.css, components.css, tokens.json and " +
        "the font and image files they name under install.folder), link install.stylesheets, and add " +
        '<meta name="plinth-design-system" content="<id>@<version>"> to the head (a design: its ' +
        "shared section) so later updates know which version it was built on. A design takes no " +
        "fonts.css, font files or tokens.json: leave those entries out. files lists every path " +
        "copy_files can take. include and components trim the result. problems lists why a stored " +
        "version no longer parses. " +
        DESIGN_SYSTEM_UNTRUSTED_NOTE +
        UNTRUSTED_NOTE,
      inputSchema: getDesignSystemInput,
    },
    (args) => run(() => getDesignSystem(ctx, args)),
  );
};
