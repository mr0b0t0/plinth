// The listening control in the viewer bar: app chrome, so the page can neither hide nor restyle
// it. While dictation listens it is one red pill: a dot, "Listening" and a stop button. The status
// region stays in the bar (empty while idle) so screen readers hear when listening starts and
// ends. It is never folded into the ⋯ menu, at any width.
import { StopIcon } from "@phosphor-icons/react";
import { Tooltip } from "../ui/index.ts";
import type { Dictation } from "./useDictation.ts";

export function DictationControl({ dictation }: { dictation: Dictation }) {
  if (!dictation.declared) return null;
  return (
    <span className={`pl-viewer__listening${dictation.listening ? " is-on" : ""}`}>
      <span role="status" aria-live="polite" className="pl-viewer__listening-label">
        {dictation.listening && (
          <>
            <span className="pl-viewer__listening-dot" aria-hidden="true" />
            Listening
          </>
        )}
      </span>
      {dictation.listening && (
        <Tooltip content="Stop dictation" placement="bottom">
          <button
            type="button"
            className="pl-viewer__listening-stop"
            aria-label="Stop dictation"
            onClick={dictation.stop}
          >
            <StopIcon size={12} weight="fill" aria-hidden="true" />
          </button>
        </Tooltip>
      )}
    </span>
  );
}
