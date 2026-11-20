// The newest draft that passed its type's checks, for the preview to keep while the draft has
// problems. Recorded in an effect after a render whose draft was valid, never during render.
import { useEffect, useRef } from "react";

/**
 * `text` while `valid`; otherwise the last `text` that was valid, or null when none has been yet
 * (a draft that does not parse on first load has no render to keep).
 */
export function useLastValid(text: string, valid: boolean): string | null {
  const last = useRef<string | null>(null);
  useEffect(() => {
    if (valid) last.current = text;
  }, [text, valid]);
  return valid ? text : last.current;
}
