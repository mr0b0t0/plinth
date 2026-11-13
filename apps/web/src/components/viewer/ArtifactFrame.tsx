// The exhibit: an artifact in a sandboxed iframe on its own content subdomain. The sandbox keeps
// `allow-same-origin` so the artifact has its *own* origin and storage (a different site from the
// app, see DECISIONS.md); it never gets `allow-top-navigation*`, so it cannot move the app page.
import type { Ref } from "react";

/** The one sandbox every artifact frame uses. Never add allow-top-navigation*. */
export const ARTIFACT_SANDBOX =
  "allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads";

export interface ArtifactFrameProps {
  /** A one-time enter URL from the gate (it trades the token for a cookie, then redirects). */
  src: string;
  /** Accessible name of the frame. */
  title: string;
  ref?: Ref<HTMLIFrameElement>;
  className?: string;
}

export function ArtifactFrame({ src, title, ref, className }: ArtifactFrameProps) {
  return (
    <iframe
      ref={ref}
      src={src}
      title={title}
      sandbox={ARTIFACT_SANDBOX}
      referrerPolicy="no-referrer"
      allow=""
      className={`pl-viewer-frame${className ? ` ${className}` : ""}`}
    />
  );
}
