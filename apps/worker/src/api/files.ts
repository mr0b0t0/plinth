// REST mirror of the files MCP tools (list_artifact_files, delete_artifact_file), plus the owner's
// "Delete all uploaded files". Metadata only: no route on the app host ever returns a file's bytes.
// Cookie requests pass the CSRF check in context.ts. Same services, same policy, same validation.
import { API, deleteArtifactFileInput, listArtifactFilesInput } from "@plinth/shared";
import { Hono } from "hono";
import {
  clearArtifactFiles,
  deleteArtifactFile,
  listArtifactFiles,
} from "../services/artifactFiles.ts";
import { type AppEnv, parseInput, serviceCtx } from "./context.ts";

export const filesApi = new Hono<AppEnv>();

filesApi.get(API.files, async (c) => {
  const limit = c.req.query("limit");
  const input = parseInput(listArtifactFilesInput, {
    id: c.req.param("ref"),
    limit: limit === undefined ? undefined : Number(limit),
    cursor: c.req.query("cursor") || undefined,
  });
  return c.json(await listArtifactFiles(serviceCtx(c), input));
});

filesApi.delete(API.files, async (c) => {
  return c.json(await clearArtifactFiles(serviceCtx(c), c.req.param("ref")));
});

filesApi.delete(API.file, async (c) => {
  const input = parseInput(deleteArtifactFileInput, {
    id: c.req.param("ref"),
    file_id: c.req.param("file"),
  });
  return c.json(await deleteArtifactFile(serviceCtx(c), input));
});
