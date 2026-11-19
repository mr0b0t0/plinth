// The strip under the bar while a deck is presented from this window (Presenter view, Audience
// window, Exit, and a newer version that waits until it is shown), or while this window is a
// deck's audience window (a hint to go full screen on this screen).
import { PresentationIcon } from "@phosphor-icons/react";
import { Button } from "../ui/index.ts";
import type { Presentation } from "./usePresentation.ts";

export interface PresentStripProps {
  present: Presentation;
  /** The version on view and the newest one. */
  version: number;
  currentVersion: number;
  /** Load the newest version (the frame keeps the slide). */
  onShowNewer: () => void;
}

export function PresentStrip({ present, version, currentVersion, onShowNewer }: PresentStripProps) {
  if (!present.available) return null;
  if (present.mode === "audience") {
    return (
      <p className="pl-viewer__notice pl-viewer__present" role="status">
        <PresentationIcon size={14} aria-hidden="true" />
        <span>Audience window. Click Present to go full screen on this screen.</span>
      </p>
    );
  }
  if (present.mode !== "presenter") return null;
  const newer = currentVersion > version;
  return (
    <section className="pl-viewer__notice pl-viewer__present" aria-label="Presenter view">
      <PresentationIcon size={14} aria-hidden="true" />
      <span className="pl-viewer__present-title">Presenter view</span>
      {present.slide !== null && present.count !== null && (
        <span className="type-num">
          Slide {present.slide} of {present.count}
        </span>
      )}
      {newer && (
        <span>
          <span className="type-num">v{currentVersion}</span> was published
          <span aria-hidden="true"> · </span>
          <Button variant="ghost" size="sm" onClick={onShowNewer}>
            Show
          </Button>
        </span>
      )}
      <span className="pl-viewer__present-actions">
        <Button variant="secondary" size="sm" onClick={present.openAudience}>
          Audience window
        </Button>
        <Button variant="ghost" size="sm" onClick={present.exit}>
          Exit
        </Button>
      </span>
    </section>
  );
}
