// The two viewer checks that come before an artifact: a password, or an allowlisted email confirmed
// by a six-digit code. Both end with a ViewGate from the server (usually "ok" with an enter URL).
import type { ViewGate } from "@plinth/shared";
import { type FormEvent, useId, useRef, useState } from "react";
import { api } from "../../lib/api.ts";
import { refreshSession } from "../../lib/session.ts";
import { Button, Input, Stack } from "../ui/index.ts";
import { type GateQuery, gateErrorMessage, gatePath } from "./gate.ts";

interface StepProps {
  /** Artifact id or slug. */
  artifactRef: string;
  query: GateQuery;
  onGate: (gate: ViewGate) => void;
}

export function PasswordForm({ artifactRef, query, onGate }: StepProps) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if (!password) {
      setError("Enter the password.");
      inputRef.current?.focus();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const gate = await api<ViewGate>(gatePath("viewPassword", artifactRef, query), {
        method: "POST",
        body: { password },
      });
      onGate(gate);
    } catch (err) {
      setError(gateErrorMessage(err, "password"));
      setPassword("");
      inputRef.current?.focus();
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} noValidate>
      <Stack gap={4}>
        <Input
          ref={inputRef}
          label="Password"
          type="password"
          name="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          error={error ?? undefined}
          autoFocus
        />
        <Button type="submit" variant="primary" loading={busy} block>
          Open artifact
        </Button>
      </Stack>
    </form>
  );
}

/**
 * What confirming a viewing code does, said before anyone asks for one (docs/spec.md "Auth and
 * permissions", Viewers). `codeSignsIn` is false on a single-user instance, where an invited
 * address cannot sign in and the code only opens what is shared with it.
 */
export function codeLead(codeSignsIn: boolean): string {
  return codeSignsIn
    ? "Sign in with a one-time code. New addresses get an account."
    : "Confirm your email with a one-time code. You do not need an account.";
}

/** Does a viewing code sign the address in on this instance? Everywhere but single-user mode. */
export const codeSignsInFor = (config: { single_user_mode: boolean } | null): boolean =>
  config?.single_user_mode !== true;

/**
 * Told to a signed-in person whose own address has no access, before they ask for a code: a code
 * confirmed for another address signs them in with it instead (DECISIONS 2026-11-19), so switching
 * accounts is never a surprise. The artifact gate and the portal both show it.
 */
export function SignedInNotice({ email, codeSignsIn }: { email: string; codeSignsIn: boolean }) {
  return (
    <p className="pl-gate__signed-in">
      You are signed in as <strong>{email}</strong>, which has no access.{" "}
      {codeSignsIn
        ? "Confirming another address switches you to it."
        : "You can confirm another address below."}
    </p>
  );
}

export interface EmailFormProps extends StepProps {
  /** Shown when a signed-in person's own address is not on the list. */
  signedInEmail?: string | null;
  /** Confirming the code signs the address in (every instance but a single-user one). */
  codeSignsIn?: boolean;
}

export function EmailForm({
  artifactRef,
  query,
  onGate,
  signedInEmail,
  codeSignsIn = true,
}: EmailFormProps) {
  const [step, setStep] = useState<"email" | "code">("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const codeRef = useRef<HTMLInputElement>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  const sentId = useId();

  const requestCode = async () => {
    await api(gatePath("viewEmail", artifactRef, query), {
      method: "POST",
      body: { email: email.trim() },
    });
  };

  const submitEmail = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      setError("Enter a valid email address.");
      emailRef.current?.focus();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await requestCode();
      setStep("code");
      setCode("");
      setNotice(null);
    } catch (err) {
      setError(gateErrorMessage(err, "email"));
    } finally {
      setBusy(false);
    }
  };

  const submitCode = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if (!/^\d{6}$/.test(code.trim())) {
      setError("Enter the six digits from the email.");
      codeRef.current?.focus();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const gate = await api<ViewGate>(gatePath("viewCode", artifactRef, query), {
        method: "POST",
        body: { email: email.trim(), code: code.trim() },
      });
      if (gate.status === "email_required") {
        setError("That code did not work. Check it, or ask for a new one.");
        return;
      }
      // A confirmed code signs the address in to the app (except where it may not sign in, as on
      // a single-user instance); pick that up so the header shows it.
      await refreshSession().catch(() => {});
      onGate(gate);
    } catch (err) {
      setError(gateErrorMessage(err, "code"));
      codeRef.current?.focus();
    } finally {
      setBusy(false);
    }
  };

  const resend = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await requestCode();
      setNotice("If this address has access, a new code is on its way.");
    } catch (err) {
      setError(gateErrorMessage(err, "email"));
    } finally {
      setBusy(false);
    }
  };

  if (step === "code") {
    return (
      <form onSubmit={submitCode} noValidate>
        <Stack gap={4}>
          <p id={sentId} className="pl-gate__sent" role="status">
            If this address has access, we sent a code to <strong>{email.trim()}</strong>. It
            expires in 15 minutes.
          </p>
          <Input
            ref={codeRef}
            label="Six-digit code"
            name="code"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            mono
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
            error={error ?? undefined}
            hint={notice ?? undefined}
            autoFocus
          />
          <Button type="submit" variant="primary" loading={busy} block>
            Confirm code
          </Button>
          <div className="pl-gate__links">
            <button type="button" className="pl-gate__link" onClick={resend}>
              Send a new code
            </button>
            <button
              type="button"
              className="pl-gate__link"
              onClick={() => {
                setStep("email");
                setError(null);
                setNotice(null);
              }}
            >
              Use a different email
            </button>
          </div>
        </Stack>
      </form>
    );
  }

  return (
    <form onSubmit={submitEmail} noValidate>
      <Stack gap={4}>
        {signedInEmail && <SignedInNotice email={signedInEmail} codeSignsIn={codeSignsIn} />}
        <Input
          ref={emailRef}
          label="Email"
          type="email"
          name="email"
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          error={error ?? undefined}
          autoFocus
        />
        <Button type="submit" variant="primary" loading={busy} block>
          Send code
        </Button>
      </Stack>
    </form>
  );
}
