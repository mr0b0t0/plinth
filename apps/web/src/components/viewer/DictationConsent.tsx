// The consent dialog for dictation: app chrome above the artifact frame, so the page cannot draw
// over it or click it. It opens only from a start the page asked for within the viewer's click,
// says who gets the words and who turns speech into text, and starts on "Not now". Both buttons
// ignore input for a moment after it opens, so a click aimed at the page cannot land on "Allow".
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
      title="Let this page take dictation?"
      size="sm"
      initialFocus={notNowRef}
      footer={
        <>
          <Button ref={notNowRef} variant="ghost" onClick={when(request.notNow)}>
            Not now
          </Button>
          <Button variant="primary" onClick={when(request.allow)}>
            Allow on this page
          </Button>
        </>
      }
    >
      <p>
        When you start dictation on <strong>{request.title}</strong>, the words you say are sent to
        this page, which {request.owner ?? "its owner"} wrote. The page may save them where others
        with access can see them.
      </p>
      <p>
        Your browser turns your speech into text. {vendorLine(request.vendor)} Plinth does not
        receive or keep the audio.
      </p>
      <p>
        You can stop at any time with <strong>Stop</strong> at the top of the page, and turn
        dictation off for this page in the <strong>⋯</strong> menu.
      </p>
    </Dialog>
  );
}
