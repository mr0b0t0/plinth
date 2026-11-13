// Page: /a/:slug/report. Anyone who can open an artifact can report it to the instance's admins.
import { CheckCircleIcon } from "@phosphor-icons/react";
import { API, APP_ROUTES, LIMITS, route } from "@plinth/shared";
import { type FormEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { PublicShell } from "../components/layout/PublicShell.tsx";
import {
  Button,
  ButtonLink,
  EmptyState,
  ICON_SIZE,
  Input,
  PageHeader,
  SkeletonText,
  Stack,
  Textarea,
} from "../components/ui/index.ts";
import { useGate } from "../components/viewer/useGate.ts";
import "../components/viewer/viewer.css";
import { ApiRequestError, api } from "../lib/api.ts";
import { Link } from "../lib/router.tsx";
import { useSession } from "../lib/session.ts";
import NotFound from "./NotFound.tsx";

const NEXT_STEP =
  "The people who run this Plinth instance review every report and take down artifacts that break the acceptable use policy.";

export default function Report({ params }: { params: Record<string, string> }) {
  const slug = params.slug ?? "";
  const { me } = useSession();
  const { state } = useGate(slug, {});
  const [reason, setReason] = useState("");
  const [email, setEmail] = useState("");
  const [emailTouched, setEmailTouched] = useState(false);
  const [error, setError] = useState<{ reason?: string; email?: string; form?: string }>({});
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const reasonRef = useRef<HTMLTextAreaElement>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  const artifactHref = route(APP_ROUTES.artifact, { slug });

  // Prefill the signed-in person's address once, unless they already typed one.
  useEffect(() => {
    if (me && !emailTouched) setEmail(me.email);
  }, [me, emailTouched]);

  const title =
    state.kind === "gate" && state.gate.status !== "not_found" ? state.gate.artifact.title : null;
  useEffect(() => {
    document.title = title ? `Report ${title} · Plinth` : "Report an artifact · Plinth";
  }, [title]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const r = reason.trim();
    const m = email.trim();
    if (!r) {
      setError({ reason: "Say what is wrong with this artifact." });
      reasonRef.current?.focus();
      return;
    }
    if (m && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(m)) {
      setError({ email: "Enter a valid email address, or leave it empty." });
      emailRef.current?.focus();
      return;
    }
    setBusy(true);
    setError({});
    try {
      await api(route(API.report, { ref: slug }), {
        method: "POST",
        body: m ? { reason: r, reporter_email: m } : { reason: r },
      });
      setSent(true);
    } catch (err) {
      if (err instanceof ApiRequestError && err.code === "rate_limited") {
        setError({ form: "Too many reports from this network. Try again later." });
      } else if (err instanceof ApiRequestError && err.code === "not_found") {
        setError({ form: "This artifact is no longer available, so it cannot be reported." });
      } else if (err instanceof ApiRequestError && err.code === "invalid_input") {
        setError({ form: "Check the reason and the email address, then try again." });
      } else {
        setError({ form: "The report could not be sent. Try again." });
      }
    } finally {
      setBusy(false);
    }
  };

  if (state.kind === "gate" && state.gate.status === "not_found") return <NotFound />;

  let body: ReactNode;
  if (state.kind === "loading") {
    body = (
      <div aria-busy="true">
        <SkeletonText lines={4} />
      </div>
    );
  } else if (state.kind === "gate" && state.gate.status === "taken_down") {
    body = (
      <EmptyState
        title="Already taken down"
        description="This artifact was taken down after an earlier report. Its link no longer opens it, so there is nothing more to report."
      />
    );
  } else if (
    state.kind === "gate" &&
    (state.gate.status === "password_required" || state.gate.status === "email_required")
  ) {
    body = (
      <EmptyState
        title="Open the artifact first"
        description="This artifact is protected. Open it with its password or your email address, then come back to report it."
        action={
          <ButtonLink to={artifactHref} variant="primary">
            Open the artifact
          </ButtonLink>
        }
      />
    );
  } else if (sent) {
    body = (
      <section className="pl-gate" aria-labelledby="report-sent" role="status">
        <CheckCircleIcon size={ICON_SIZE.xl} aria-hidden="true" className="pl-gate__icon" />
        <h2 id="report-sent">Thank you. Your report was sent.</h2>
        <p className="pl-gate__lead">{NEXT_STEP}</p>
        <div>
          <ButtonLink to={artifactHref} variant="secondary">
            Back to the artifact
          </ButtonLink>
        </div>
      </section>
    );
  } else {
    body = (
      <form onSubmit={submit} noValidate>
        <Stack gap={5}>
          <Textarea
            ref={reasonRef}
            label="What is wrong with this artifact?"
            hint="For example: phishing, malware, someone else's private data, or anything else that breaks the acceptable use policy."
            rows={6}
            maxLength={LIMITS.maxReportReasonLength}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            error={error.reason}
          />
          <Input
            ref={emailRef}
            label="Your email (optional)"
            hint="Only used if the reviewers need to ask you about this report."
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => {
              setEmailTouched(true);
              setEmail(e.target.value);
            }}
            error={error.email}
          />
          {error.form && (
            <p className="text-danger" role="alert">
              {error.form}
            </p>
          )}
          <div className="pl-gate__links">
            <Button type="submit" variant="primary" loading={busy}>
              Send report
            </Button>
            <Link to={artifactHref}>Cancel</Link>
          </div>
        </Stack>
      </form>
    );
  }

  return (
    <PublicShell width="reading">
      <PageHeader
        title="Report this artifact"
        description={
          <>
            {title && (
              <>
                You are reporting <strong>{title}</strong>.{" "}
              </>
            )}
            {!sent && (
              <>
                {NEXT_STEP} Read the{" "}
                <Link to={APP_ROUTES.acceptableUse}>acceptable use policy</Link>.
              </>
            )}
          </>
        }
      />
      {body}
    </PublicShell>
  );
}
