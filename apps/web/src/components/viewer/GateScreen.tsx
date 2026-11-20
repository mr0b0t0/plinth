// What a viewer sees before the artifact when it is not "ok": a password form, an email check, a
// takedown notice, or not found. Used by the artifact page and by /open (direct content links).
import { LockSimpleIcon, ProhibitIcon, UserListIcon } from "@phosphor-icons/react";
import { APP_ROUTES, type ViewGate } from "@plinth/shared";
import { useEffect, useState } from "react";
import { Link } from "../../lib/router.tsx";
import { useSession } from "../../lib/session.ts";
import NotFound from "../../pages/NotFound.tsx";
import { PublicShell } from "../layout/PublicShell.tsx";
import { ButtonLink, ICON_SIZE } from "../ui/index.ts";
import { type CodeStep, codeLead, codeSignsInFor, EmailForm, PasswordForm } from "./GateForms.tsx";
import type { GateQuery } from "./gate.ts";
import "./viewer.css";

type ClosedGate = Exclude<ViewGate, { status: "ok" }>;

export interface GateScreenProps {
  gate: ClosedGate;
  /** Artifact id or slug used for the gate calls. */
  artifactRef: string;
  query: GateQuery;
  onGate: (gate: ViewGate) => void;
}

export function GateScreen({ gate, artifactRef, query, onGate }: GateScreenProps) {
  const { me, config } = useSession();
  const codeSignsIn = codeSignsInFor(config);
  const [step, setStep] = useState<CodeStep>("email");
  const title = gate.status === "not_found" ? null : gate.artifact.title;

  useEffect(() => {
    const what =
      gate.status === "password_required"
        ? "Password required"
        : gate.status === "email_required"
          ? "Confirm your email"
          : gate.status === "taken_down"
            ? "Taken down"
            : "Not found";
    document.title = title ? `${what}: ${title} · Plinth` : `${what} · Plinth`;
  }, [gate.status, title]);

  if (gate.status === "not_found") return <NotFound />;

  if (gate.status === "taken_down") {
    return (
      <PublicShell centered width="reading">
        <section className="pl-gate pl-gate--notice" aria-labelledby="gate-title">
          <ProhibitIcon size={ICON_SIZE.xl} aria-hidden="true" className="pl-gate__icon" />
          <p className="pl-gate__eyebrow">No longer on view</p>
          <h1 id="gate-title" className="pl-gate__title">
            {gate.artifact.title}
          </h1>
          <p className="pl-gate__lead">
            The people who run this Plinth instance took this artifact down after a report, and its
            link no longer opens it. If you own it and think this is a mistake, the{" "}
            <Link to={APP_ROUTES.acceptableUse}>acceptable use policy</Link> says how to reach them.
          </p>
          <div>
            <ButtonLink to={me ? APP_ROUTES.dashboard : APP_ROUTES.home} variant="secondary">
              {me ? "Go to dashboard" : "Go to home"}
            </ButtonLink>
          </div>
        </section>
      </PublicShell>
    );
  }

  const password = gate.status === "password_required";
  const Icon = password ? LockSimpleIcon : UserListIcon;
  const signedInEmail = me?.email ?? null;
  // One explanation at a time: the code step's sent line stands alone, and a signed-in person
  // reads the signed-in notice rather than an invitation to sign in.
  const lead = password
    ? "Enter the password the owner gave you to open this artifact."
    : step === "code"
      ? null
      : signedInEmail
        ? "Only the people the owner listed can open this artifact."
        : `Only the people the owner listed can open this artifact. ${codeLead(codeSignsIn)}`;
  return (
    <PublicShell centered>
      <section className="pl-gate" aria-labelledby="gate-title">
        <Icon size={ICON_SIZE.xl} aria-hidden="true" className="pl-gate__icon" />
        <p className="pl-gate__eyebrow">{password ? "Protected with a password" : "Private"}</p>
        <h1 id="gate-title" className="pl-gate__title">
          {gate.artifact.title}
        </h1>
        {lead && <p className="pl-gate__lead">{lead}</p>}
        {password ? (
          <PasswordForm artifactRef={artifactRef} query={query} onGate={onGate} />
        ) : (
          <EmailForm
            artifactRef={artifactRef}
            query={query}
            onGate={onGate}
            signedInEmail={signedInEmail}
            codeSignsIn={codeSignsIn}
            onStep={setStep}
          />
        )}
      </section>
    </PublicShell>
  );
}
