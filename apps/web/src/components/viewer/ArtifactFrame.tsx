// The exhibit: an artifact in a sandboxed iframe on its own content subdomain. Under origin
// isolation the sandbox keeps `allow-same-origin` so the artifact has its *own* origin and storage
// (a different site from the app, see DECISIONS.md); under opaque isolation it drops it, matching
// the CSP sandbox on every content response. It never gets `allow-top-navigation*`, so it cannot
// move the app page.

import {
  ARTIFACT_IFRAME_SANDBOX,
  artifactIframeSandbox,
  type ContentIsolation,
} from "@plinth/shared";
import type { Ref } from "react";

/** The sandbox artifact frames use under origin isolation (never allow-top-navigation). */
export const ARTIFACT_SANDBOX = ARTIFACT_IFRAME_SANDBOX;

export interface ArtifactFrameProps {
  /** A one-time enter URL from the gate (it trades the token for a cookie, then redirects). */
  src: string;
  /** Accessible name of the frame. */
  title: string;
  /** The instance's content isolation (AppConfig.content_isolation). */
  isolation?: ContentIsolation;
  ref?: Ref<HTMLIFrameElement>;
  className?: string;
}

export function ArtifactFrame({ src, title, isolation, ref, className }: ArtifactFrameProps) {
  return (
    <iframe
      ref={ref}
      src={src}
      title={title}
      sandbox={artifactIframeSandbox(isolation)}
      referrerPolicy="no-referrer"
      allow=""
      className={`pl-viewer-frame${className ? ` ${className}` : ""}`}
    />
  );
}
