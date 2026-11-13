// Page: /open/:id?next=<path>. The content host sends a browser here when it arrives at an artifact
// without a valid viewer cookie (a direct content link). The same gate runs; then the whole tab
// moves to the artifact's own subdomain with a one-time token (no frame, no app chrome).
import { useEffect } from "react";
import { PublicShell } from "../components/layout/PublicShell.tsx";
import { Button, EmptyState, Spinner } from "../components/ui/index.ts";
import { GateScreen } from "../components/viewer/GateScreen.tsx";
import { useGate } from "../components/viewer/useGate.ts";
import "../components/viewer/viewer.css";
import { useLocation } from "../lib/router.tsx";

export default function Open({ params }: { params: Record<string, string> }) {
  const id = params.id ?? "";
  const { search } = useLocation();
  const next = search.get("next") ?? undefined;
  const { state, reload, setGate } = useGate(id, { next });
  const enterUrl =
    state.kind === "gate" && state.gate.status === "ok" ? state.gate.enter_url : null;

  useEffect(() => {
    if (enterUrl) window.location.replace(enterUrl);
  }, [enterUrl]);

  useEffect(() => {
    if (state.kind !== "gate" || state.gate.status === "ok")
      document.title = "Opening artifact · Plinth";
  }, [state]);

  if (state.kind === "error") {
    return (
      <PublicShell centered width="reading">
        <EmptyState
          headingLevel={1}
          title="This artifact could not be opened"
          description={`${state.message} Check your connection and try again.`}
          action={
            <Button variant="primary" onClick={reload}>
              Try again
            </Button>
          }
        />
      </PublicShell>
    );
  }
  if (state.kind === "gate" && state.gate.status !== "ok") {
    return <GateScreen gate={state.gate} artifactRef={id} query={{ next }} onGate={setGate} />;
  }
  const title =
    state.kind === "gate" && state.gate.status === "ok" ? state.gate.artifact.title : null;
  return (
    <PublicShell centered>
      <div className="pl-open">
        <Spinner size={24} />
        <h1 className="type-heading">{title ? `Opening ${title}` : "Opening artifact"}</h1>
        <p role="status">Taking you to the artifact&rsquo;s own address.</p>
      </div>
    </PublicShell>
  );
}
