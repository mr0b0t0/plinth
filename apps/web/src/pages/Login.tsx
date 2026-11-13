// Page: /login. Email, then the six-digit code from the email (the email's link works too).
// Contract with e2e/support/auth.ts signIn(): an input labelled "Email", a button "Send sign-in
// link", then an input labelled "Six-digit code" and a button "Sign in".
import { API, emailSchema, TTL } from "@plinth/shared";
import { type FormEvent, useEffect, useRef, useState } from "react";
import "../components/account/account.css";
import { useDocumentTitle } from "../components/account/hooks.tsx";
import { Note } from "../components/account/Note.tsx";
import { safeNext } from "../components/account/nav.ts";
import { PublicShell } from "../components/layout/PublicShell.tsx";
import { Button, Input, Stack, useToast } from "../components/ui/index.ts";
import { ApiRequestError, api } from "../lib/api.ts";
import { navigate, Redirect, useLocation } from "../lib/router.tsx";
import { useSession } from "../lib/session.ts";

const MINUTES = Math.round(TTL.loginCodeMs / 60_000);

function errorText(e: unknown, fallback: string): string {
  if (e instanceof ApiRequestError) {
    if (e.code === "rate_limited" || e.code === "invalid_input") return e.message;
    if (e.status >= 500) return "Something went wrong on our side. Try again in a moment.";
    return e.message || fallback;
  }
  return "Could not reach Plinth. Check your connection and try again.";
}

export default function Login() {
  const { loading, me, config, refresh } = useSession();
  const { search } = useLocation();
  const next = safeNext(search.get("next"));
  const toast = useToast();

  const [step, setStep] = useState<"email" | "code">("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [emailError, setEmailError] = useState<string | null>(null);
  const [codeError, setCodeError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [resent, setResent] = useState(false);
  const codeRef = useRef<HTMLInputElement>(null);
  const emailRef = useRef<HTMLInputElement>(null);

  useDocumentTitle(step === "code" ? "Check your email" : "Sign in");

  useEffect(() => {
    if (step === "code") codeRef.current?.focus();
  }, [step]);

  if (!loading && me && !verifying) return <Redirect to={next} />;

  const send = async (address: string): Promise<boolean> => {
    setSending(true);
    try {
      await api(API.loginRequest, { method: "POST", body: { email: address } });
      return true;
    } catch (e) {
      const msg = errorText(e, "Could not send the email.");
      if (step === "email") setEmailError(msg);
      else setCodeError(msg);
      return false;
    } finally {
      setSending(false);
    }
  };

  const onEmail = async (e: FormEvent) => {
    e.preventDefault();
    if (sending) return;
    const parsed = emailSchema.safeParse(email);
    if (!parsed.success) {
      setEmailError("Enter a valid email address.");
      emailRef.current?.focus();
      return;
    }
    setEmailError(null);
    if (await send(parsed.data)) {
      setEmail(parsed.data);
      setCode("");
      setCodeError(null);
      setResent(false);
      setStep("code");
    }
  };

  const onCode = async (e: FormEvent) => {
    e.preventDefault();
    if (verifying) return;
    if (!/^\d{6}$/.test(code)) {
      setCodeError("Enter the six digits from the email.");
      codeRef.current?.focus();
      return;
    }
    setCodeError(null);
    setVerifying(true);
    try {
      await api(API.loginVerifyCode, { method: "POST", body: { email, code } });
      await refresh();
      navigate(next, { replace: true });
    } catch (err) {
      setVerifying(false);
      setCodeError(errorText(err, "That code did not work."));
      codeRef.current?.focus();
    }
  };

  const onResend = async () => {
    if (sending) return;
    setCodeError(null);
    if (await send(email)) {
      setCode("");
      setResent(true);
      toast.success("New code sent", `Check ${email}. The previous code no longer works.`);
      codeRef.current?.focus();
    }
  };

  const onChangeEmail = () => {
    setStep("email");
    setCode("");
    setCodeError(null);
    setResent(false);
    window.setTimeout(() => emailRef.current?.focus(), 0);
  };

  const singleUser = config?.single_user_mode === true;

  return (
    <PublicShell centered>
      <div className="pl-acct-auth">
        {step === "email" ? (
          <Stack gap={6}>
            <Stack gap={3}>
              <h1 className="type-title">Sign in</h1>
              <p className="type-lead">
                We'll email you a sign-in link and a six-digit code. There is no password.
              </p>
            </Stack>
            {singleUser && (
              <Note>
                This is a single-user instance. Only its operator's email address can sign in; other
                addresses get no email.
              </Note>
            )}
            <form className="pl-acct-form" onSubmit={onEmail} noValidate>
              <Input
                ref={emailRef}
                label="Email"
                type="email"
                name="email"
                autoComplete="email"
                inputMode="email"
                autoCapitalize="none"
                spellCheck={false}
                required
                value={email}
                error={emailError ?? undefined}
                onChange={(e) => {
                  setEmail(e.target.value);
                  if (emailError) setEmailError(null);
                }}
              />
              <Button type="submit" variant="primary" size="lg" block loading={sending}>
                Send sign-in link
              </Button>
            </form>
            {!singleUser && (
              <p className="type-small text-muted">
                New to Plinth? Signing in for the first time creates your account.
              </p>
            )}
          </Stack>
        ) : (
          <Stack gap={6}>
            <Stack gap={3}>
              <h1 className="type-title">Check your email</h1>
              <p className="type-lead">
                We sent a sign-in link and a code to{" "}
                <strong className="pl-acct-auth__email">{email}</strong>. Open the link on this
                device, or type the code here.
              </p>
            </Stack>
            <form className="pl-acct-form" onSubmit={onCode} noValidate>
              <Input
                ref={codeRef}
                label="Six-digit code"
                name="code"
                mono
                className="pl-acct-code"
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9]*"
                maxLength={6}
                required
                value={code}
                hint={`It works once and expires in ${MINUTES} minutes.`}
                error={codeError ?? undefined}
                onChange={(e) => {
                  setCode(e.target.value.replace(/\D/g, "").slice(0, 6));
                  if (codeError) setCodeError(null);
                }}
              />
              <Button type="submit" variant="primary" size="lg" block loading={verifying}>
                Sign in
              </Button>
            </form>
            {resent && (
              <p className="type-small text-muted" role="status">
                A new code is on its way. Only the newest code works.
              </p>
            )}
            <div className="pl-acct-auth__alt">
              <Button variant="ghost" size="sm" onClick={onResend} loading={sending}>
                Send a new code
              </Button>
              <Button variant="ghost" size="sm" onClick={onChangeEmail}>
                Use a different email
              </Button>
            </div>
            <p className="type-small text-muted">
              Nothing arrived? Check your spam folder, or make sure the address is right.
            </p>
          </Stack>
        )}
      </div>
    </PublicShell>
  );
}
