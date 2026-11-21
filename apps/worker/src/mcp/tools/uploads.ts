// MCP tool for big builds: start_upload, a single-use ticket and a command that publishes a tar.
import { LIMITS, startUploadInput } from "@plinth/shared";
import { startUpload } from "../../services/uploads.ts";
import { MCP_TOOL_ANNOTATIONS, toolName } from "../catalog.ts";
import {
  CATEGORY_NOTE,
  COPY_FILES_NOTE,
  categoryShareNote,
  PROJECT_FILES_NOTE,
  UNTRUSTED_NOTE,
  UPLOAD_NOTE,
} from "../notes.ts";
import { run, type ToolRegistrar } from "./context.ts";

export const registerUploadTools: ToolRegistrar = ({ server, ctx, opaque }) => {
  server.registerTool(
    toolName("start_upload"),
    {
      title: "Start upload",
      annotations: MCP_TOOL_ANNOTATIONS.start_upload,
      description:
        "Publish a build folder or a big page out of band: returns a single-use upload ticket (30 minutes, " +
        `at most ${LIMITS.maxTicketAttempts} attempts) and commands.curl, one shell line (bash or zsh) that ` +
        "tars the folder and sends it; the bundle request itself publishes the version and prints the " +
        "result (url, warnings, stored). Omit id for a new artifact (optional type and title; the title " +
        "defaults to the page's <title>; a deck folder has slides.md, or deck.json with deck.css and " +
        "slides/<id>.html for an HTML deck, at its top). With id it updates that artifact (with id, category is owner " +
        "only): base_version, the version you " +
        "read with get_artifact, is required, and a stale base is refused instead of overwriting " +
        "(list_versions gives the current number without the page's files). Run " +
        "commands.curl with a shell timeout of at least 10 minutes and give the user the url it prints; " +
        "commands.npx, when present, does the same with Node. The result carries this instance's limits " +
        "and content_isolation; target.id is the artifact it updates or, for a new one, the id it will " +
        "create. If the command ends without its JSON (a curl error or a timeout), it may still have " +
        "published once the whole folder was sent: before anything else, GET the upload_url without " +
        "/bundle with the same Authorization header (state used: this upload published it; dead: " +
        "someone else published first and this change was not saved; taken_down: the artifact was " +
        "taken down, nothing was published, tell the user and do not resend; open: nothing was " +
        "published). " +
        "Only if that cannot be read, call get_artifact with target.id, and compare a new version's " +
        "files with what you sent before you call it yours (a collaborator may have published it). " +
        "Call start_upload again (with the same base_version) only when nothing was published. An " +
        "upload never commits twice: sending it again answers upload_used. " +
        COPY_FILES_NOTE +
        CATEGORY_NOTE +
        categoryShareNote(ctx.config) +
        UPLOAD_NOTE +
        opaque +
        PROJECT_FILES_NOTE +
        UNTRUSTED_NOTE,
      inputSchema: startUploadInput,
    },
    (args) => run(() => startUpload(ctx, args)),
  );
};
