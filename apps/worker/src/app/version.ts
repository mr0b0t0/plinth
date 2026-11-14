// The release version of this Worker: the npm CLI's version, which `pnpm release` sets and which
// the Docker image shares (docs/releasing.md). Reported by the MCP server and its server card.
import { version } from "../../../../packages/cli/package.json";

export const PLINTH_VERSION: string = version;
