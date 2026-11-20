// The consent dialog for dictation: app chrome above the artifact frame, so the page cannot draw
// over it or click it. It opens only from a start the page asked for within the viewer's click,
// says who gets the words (the page, by its owner's email) and who turns speech into text, and
// starts on "Not now". Both buttons ignore input for a moment after it opens, so a click aimed at
// the page cannot land on "Allow". Escape answers like closing it (`dismissed`).
import { useEffect, useRef, useState } from "react";
import { Button, Dialog } from "../ui/index.ts";
import type { DictationConsentRequest } from "./useDictation.ts";
import { VOICE_LIMITS, vendorLine } from "./voiceProtocol.ts";

export function DictationConsent({ request }: { request: DictationConsentRequest | null }) {
  return request ? <ConsentPanel key={request.title} request={request} /> : null;
}

function ConsentPanel({ request }: { request: DictationConsentRequest }) {
  const notNowRef = useRef<HTMLButtonElement>(null);
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    const t = window.setTimeout(() => setArmed(true), VOICE_LIMITS.dialogArmMs);
    return () => window.clearTimeout(t);
  }, []);
  const when = (fn: () => void) => () => {
    if (armed) fn();
  };
  return (
    <Dialog
      open
      onClose={request.dismiss}
      title="Allow dictation on this page?"
      size="sm"
      hideClose
      initialFocus={notNowRef}
      footer={
        <>
          <Button ref={notNowRef} variant="ghost" onClick={when(request.notNow)}>
            Not now
          </Button>
          <Button variant="primary" onClick={when(request.allow)}>
            Allow
          </Button>
        </>
      }
    >
      <p>
        <strong>{request.title}</strong>, by {request.owner}, gets the words you say and may save
        them for others with access. {vendorLine(request.vendor)}
      </p>
    </Dialog>
  );
}
