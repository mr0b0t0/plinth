// The artifact frame on the viewer stage, with seamless reloads. Every gate carries a one-time
// enter URL, so the frame must load again when the gate changes (review mode turns on, a newer
// version arrives). Instead of swapping the iframe in place, which flashes an empty canvas, the
// new frame loads underneath while the old one stays on top; the old one goes once the new one
// has loaded (or after SWAP_TIMEOUT_MS, so a stalled load cannot pin the old page forever). A thin
// bar shows while the shown frame is loading.
import type { ContentIsolation } from "@plinth/shared";
import { type Ref, useEffect, useState } from "react";
import { ArtifactFrame } from "./ArtifactFrame.tsx";

export const SWAP_TIMEOUT_MS = 8000;

interface Layer {
  src: string;
  /** The frame's accessible name, kept with it: an outgoing frame still shows its own version. */
  title?: string;
  loaded: boolean;
}

/** The layers after `src` becomes the one to show: at most one old frame stays, until it loads. */
export function addLayer(layers: Layer[], src: string, title?: string): Layer[] {
  const top = layers.at(-1);
  if (top?.src === src) {
    return top.title === title ? layers : [...layers.slice(0, -1), { ...top, title }];
  }
  const shown = layers.filter((l) => l.loaded).at(-1);
  return [...(shown ? [shown] : []), { src, title, loaded: false }];
}

/** The layers once `src` has loaded: it alone remains (if it is still the one to show). */
export function markLoaded(layers: Layer[], src: string): Layer[] {
  const top = layers.at(-1);
  if (!top || top.src !== src) return layers;
  return [{ ...top, loaded: true }];
}

export interface StageFrameProps {
  src: string;
  title: string;
  isolation?: ContentIsolation;
  /** The frame being shown (the newest one), for the comments bridge. */
  ref?: Ref<HTMLIFrameElement>;
  /** Words for the loading status, e.g. "Loading version 3". */
  loadingLabel: string;
}

export function StageFrame({ src, title, isolation, ref, loadingLabel }: StageFrameProps) {
  const [layers, setLayers] = useState<Layer[]>(() => [{ src, title, loaded: false }]);
  // A new src takes effect in the same render, so no commit ever shows the old frame under the
  // new title or hands the ref to it.
  const added = addLayer(layers, src, title);
  if (added !== layers) setLayers(added);

  useEffect(() => {
    const timer = window.setTimeout(() => setLayers((ls) => markLoaded(ls, src)), SWAP_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [src]);

  const loading = layers.at(-1)?.loaded === false;

  return (
    <div className="pl-viewer__frames">
      {layers.map((layer, i) => {
        const current = i === layers.length - 1;
        return (
          <ArtifactFrame
            key={layer.src}
            ref={current ? ref : undefined}
            src={layer.src}
            title={layer.title ?? title}
            isolation={isolation}
            inert={!current}
            className={current ? undefined : "pl-viewer-frame--outgoing"}
            onLoad={() => setLayers((ls) => markLoaded(ls, layer.src))}
          />
        );
      })}
      {loading && <div className="pl-viewer__loading" aria-hidden="true" />}
      <span className="visually-hidden" role="status">
        {loading ? loadingLabel : ""}
      </span>
    </div>
  );
}
