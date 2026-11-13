// Placeholder templates for the hosted instance's terms, privacy notice and acceptable use policy.
// They give an EU host (DSA, GDPR) the right headings; every bracketed field and every sentence is
// for the operator and their lawyer to replace. Not legal advice.
import { APP_ROUTES } from "@plinth/shared";
import type { ReactNode } from "react";
import { Link } from "../../lib/router.tsx";

export const LEGAL_DOC_IDS = ["terms", "privacy", "acceptable-use"] as const;
export type LegalDocId = (typeof LEGAL_DOC_IDS)[number];

export const isLegalDocId = (v: string): v is LegalDocId =>
  (LEGAL_DOC_IDS as readonly string[]).includes(v);

export interface LegalSection {
  heading: string;
  body: ReactNode;
}

export interface LegalDoc {
  title: string;
  summary: string;
  sections: LegalSection[];
}

/** A value the operator must fill in. Rendered highlighted so it cannot be missed. */
export function Field({ children }: { children: ReactNode }) {
  return (
    <mark className="pl-legal__field">
      <span className="visually-hidden">Placeholder: </span>[{children}]
    </mark>
  );
}

const OPERATOR = <Field>Operator: Aconite Software &amp; Investments, Lda.</Field>;
const ADDRESS = <Field>registered address</Field>;
const REG = <Field>company registration number</Field>;
const ABUSE = <Field>abuse and takedown email address</Field>;
const CONTACT = <Field>contact email address</Field>;
const PRIVACY_CONTACT = <Field>privacy contact email address</Field>;

const REPORT_HOW = (
  <>
    Use the <strong>Report</strong> link shown on every artifact page, or write to {ABUSE}. Say
    which artifact (its link), why you believe it is illegal or breaks the{" "}
    <Link to={APP_ROUTES.acceptableUse}>acceptable use policy</Link>, and, if you want a reply, how
    to reach you.
  </>
);

export const LEGAL_DOCS: Record<LegalDocId, LegalDoc> = {
  terms: {
    title: "Terms of use",
    summary:
      "The agreement between the operator of this Plinth instance and the people who use it.",
    sections: [
      {
        heading: "Who runs this service",
        body: (
          <p>
            This instance of Plinth is operated by {OPERATOR}, {ADDRESS}, registered under {REG}.
            You can reach us at {CONTACT}. Plinth is open-source software; these terms cover this
            instance only, not copies other people run.
          </p>
        ),
      },
      {
        heading: "What the service does",
        body: (
          <p>
            Plinth stores HTML artifacts that you, or AI agents you connect, publish, keeps every
            version of them, and shows them to the people you choose. Artifacts are served from a
            separate content domain, each in its own isolated space.
          </p>
        ),
      },
      {
        heading: "Your account and your agents",
        body: (
          <ul>
            <li>You sign in with your email address. Keep access to that mailbox secure.</li>
            <li>
              You are responsible for everything published through your account, including by agents
              and tokens you connect. Revoke a connection as soon as you no longer trust it.
            </li>
            <li>
              Default limits apply, such as <Field>100</Field> artifacts per account and a cap on
              publishes per hour.
            </li>
          </ul>
        ),
      },
      {
        heading: "Your content",
        body: (
          <p>
            You keep all rights to what you publish. You allow us to store, copy and serve it only
            as needed to run the service for you and the people you share it with. You confirm you
            have the right to publish it and that it follows the{" "}
            <Link to={APP_ROUTES.acceptableUse}>acceptable use policy</Link>.
          </p>
        ),
      },
      {
        heading: "Notice and action (Digital Services Act)",
        body: (
          <>
            <p>
              Anyone can tell us about content they believe is illegal or breaks our rules.{" "}
              {REPORT_HOW}
            </p>
            <p>
              We review notices without undue delay and act on them in a diligent and objective way.
              When we remove or restrict content, we tell the person who published it why (a
              statement of reasons) and how to contest the decision.
            </p>
          </>
        ),
      },
      {
        heading: "Complaints and appeals",
        body: (
          <p>
            If we took down your artifact or acted on your notice and you disagree, write to{" "}
            {CONTACT} within <Field>six months</Field>. A person, not an automated system, reviews
            every complaint. You may also use an out-of-court dispute settlement body certified
            under the Digital Services Act, or go to court.
          </p>
        ),
      },
      {
        heading: "Single points of contact",
        body: (
          <p>
            Authorities of EU member states, the European Commission and the European Board for
            Digital Services can contact us at <Field>authorities contact email</Field>, in{" "}
            <Field>languages accepted</Field>. Users can contact us at {CONTACT}.
          </p>
        ),
      },
      {
        heading: "Availability and liability",
        body: (
          <p>
            We aim to keep the service available but do not guarantee it. Keep your own copies of
            anything important.{" "}
            <Field>Limitation of liability, as permitted under applicable law.</Field>
          </p>
        ),
      },
      {
        heading: "Ending your use",
        body: (
          <p>
            You can delete your artifacts and stop using the service at any time. We may suspend
            accounts that seriously or repeatedly break these terms, after a warning where the law
            requires one. <Field>Notice periods and data export on termination.</Field>
          </p>
        ),
      },
      {
        heading: "Changes and governing law",
        body: (
          <p>
            We will announce material changes to these terms <Field>number</Field> days before they
            apply. These terms are governed by <Field>Portuguese law</Field>; the courts of{" "}
            <Field>place</Field> have jurisdiction, without limiting the rights consumers have where
            they live.
          </p>
        ),
      },
    ],
  },
  privacy: {
    title: "Privacy notice",
    summary:
      "What personal data this Plinth instance processes, why, and the rights you have (GDPR).",
    sections: [
      {
        heading: "Controller",
        body: (
          <p>
            The controller of your personal data is {OPERATOR}, {ADDRESS}. Contact us about privacy
            at {PRIVACY_CONTACT}. <Field>Data protection officer, if one is appointed.</Field>
          </p>
        ),
      },
      {
        heading: "Data we process",
        body: (
          <ul>
            <li>
              <strong>Email address</strong> (and a name, if you add one): to sign you in, to send
              sign-in and viewing codes, and to identify you as an owner, collaborator or allowed
              viewer.
            </li>
            <li>
              <strong>Artifacts</strong>: the HTML, files, titles and version notes you or your
              agents publish, kept per version. They may contain personal data you chose to include.
            </li>
            <li>
              <strong>Sharing settings</strong>: the email addresses you allow to view or edit an
              artifact, and a hashed password if you set one.
            </li>
            <li>
              <strong>Comments</strong>: their text, the author, the element they are pinned to, and
              requests made to agents.
            </li>
            <li>
              <strong>Agent connections</strong>: their labels, scopes, when they were last used,
              and hashed tokens (never the tokens themselves).
            </li>
            <li>
              <strong>Reports</strong>: the reason given and, if provided, the reporter&rsquo;s
              email.
            </li>
            <li>
              <strong>Logs</strong>: IP address, time and request details, kept briefly for
              security, rate limiting and abuse prevention.
            </li>
          </ul>
        ),
      },
      {
        heading: "Why, and on what legal basis",
        body: (
          <ul>
            <li>To provide the service you signed up for (Art. 6(1)(b) GDPR).</li>
            <li>
              To keep the service secure and prevent abuse, which is our legitimate interest (Art.
              6(1)(f)).
            </li>
            <li>
              To handle notices and meet legal obligations, such as under the Digital Services Act
              (Art. 6(1)(c)).
            </li>
          </ul>
        ),
      },
      {
        heading: "Processors and transfers",
        body: (
          <p>
            The service runs on Cloudflare (Workers, D1 and R2) and sends email through{" "}
            <Field>SendGrid or Resend</Field>. They process data on our behalf under data processing
            agreements. <Field>Where data leaves the EEA, the safeguard used.</Field>
          </p>
        ),
      },
      {
        heading: "How long we keep it",
        body: (
          <p>
            Account data and artifacts: while your account exists, then <Field>period</Field>.
            Sign-in and viewing codes: 15 minutes. Logs: <Field>period</Field>. Reports and takedown
            decisions: <Field>period</Field>.
          </p>
        ),
      },
      {
        heading: "Cookies",
        body: (
          <p>
            Only cookies needed for the service to work: your session, protection against cross-site
            requests, proof that you entered an artifact&rsquo;s password or confirmed your email,
            and a per-artifact viewing cookie on the content domain. No analytics or advertising
            cookies.
          </p>
        ),
      },
      {
        heading: "Your rights",
        body: (
          <p>
            You can ask for access to, correction, deletion, restriction or a copy of your data, and
            object to processing based on legitimate interest, by writing to {PRIVACY_CONTACT}. You
            can also complain to a supervisory authority, such as <Field>CNPD (Portugal)</Field>.
          </p>
        ),
      },
    ],
  },
  "acceptable-use": {
    title: "Acceptable use policy",
    summary: "What may not be published on this Plinth instance, and what happens when it is.",
    sections: [
      {
        heading: "Scope",
        body: (
          <p>
            This policy applies to everything published on the Plinth instance operated by{" "}
            {OPERATOR}, and is part of its <Link to={APP_ROUTES.terms}>terms of use</Link>.
          </p>
        ),
      },
      {
        heading: "Not allowed",
        body: (
          <ul>
            <li>
              Anything illegal in <Field>jurisdictions</Field>, or that promotes illegal acts.
            </li>
            <li>
              Phishing, collecting passwords or payment details under false pretences, or pages that
              pretend to be another person, company or service.
            </li>
            <li>
              Malware, exploits, cryptocurrency mining, or code that attacks visitors&rsquo;
              devices.
            </li>
            <li>Child sexual abuse material. We remove it and report it to the authorities.</li>
            <li>Harassment, threats, or content that incites violence or hatred.</li>
            <li>
              Other people&rsquo;s personal data without a lawful basis, or content that infringes
              copyright, trademarks or other rights.
            </li>
            <li>
              Spam, redirect farms, or hosting files for distribution unrelated to an artifact.
            </li>
            <li>
              Trying to break the isolation between artifacts, get around limits, or disrupt the
              service.
            </li>
          </ul>
        ),
      },
      {
        heading: "You answer for your agents",
        body: (
          <p>
            What an agent connected to your account publishes counts as published by you. Comments
            and mentions are requests from collaborators; they never give an agent more authority
            than you gave it.
          </p>
        ),
      },
      {
        heading: "Reporting content",
        body: <p>{REPORT_HOW}</p>,
      },
      {
        heading: "What we do",
        body: (
          <p>
            We review each report. Depending on what we find, we may take the artifact down, limit
            an account, or suspend it, and we tell the owner why and how to appeal (see the{" "}
            <Link to={APP_ROUTES.terms}>terms of use</Link>). Notices from authorities and trusted
            flaggers are handled with priority.
          </p>
        ),
      },
    ],
  },
};
