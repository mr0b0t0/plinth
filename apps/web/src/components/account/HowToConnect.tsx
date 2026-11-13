// "How to connect": the MCP endpoint and the short version of docs/mcp.md for Claude and Codex.
import { CopyField } from "./CopyField.tsx";

export function HowToConnect({ endpoint }: { endpoint: string }) {
  return (
    <section className="pl-acct-section" aria-labelledby="how-to-connect">
      <div className="pl-acct-section__head">
        <h2 id="how-to-connect">How to connect</h2>
        <p className="text-muted">
          Every agent connects to the same MCP server. Each connection gets its own name and can be
          revoked on its own.
        </p>
      </div>
      <CopyField
        label="MCP server URL"
        value={endpoint}
        copyLabel="Copy MCP server URL"
        copiedMessage="MCP server URL copied"
      />
      <div className="pl-acct-howto">
        <div className="pl-acct-howto__item">
          <h3 className="type-subhead">Claude</h3>
          <ol className="pl-acct-steps">
            <li>In Claude's connector settings, add a custom connector with the URL above.</li>
            <li>Claude opens a consent page here. Sign in, name the connection and allow it.</li>
            <li>It appears in the list on this page.</li>
          </ol>
          <p className="type-small text-muted">
            Claude Code: <code>claude mcp add --transport http plinth {endpoint}</code>, then run{" "}
            <code>/mcp</code> to sign in.
          </p>
        </div>
        <div className="pl-acct-howto__item">
          <h3 className="type-subhead">Codex</h3>
          <ol className="pl-acct-steps">
            <li>Create a token with “New token” and copy it.</li>
            <li>
              Put it in an environment variable, e.g. <code>PLINTH_TOKEN</code>.
            </li>
            <li>
              Run{" "}
              <code>codex mcp add plinth --url {endpoint} --bearer-token-env-var PLINTH_TOKEN</code>
              .
            </li>
          </ol>
          <p className="type-small text-muted">
            Any other MCP client: use the URL with the streamable HTTP transport, and OAuth or a
            token sent as <code>Authorization: Bearer …</code>.
          </p>
        </div>
      </div>
      <p className="type-small text-muted">
        Full instructions are in <code>docs/mcp.md</code> in the Plinth repository.
      </p>
    </section>
  );
}
