// The instance's terms of use, privacy notice and acceptable use policy: short, plain-language and
// final. Operator details come from the instance's OPERATOR_* settings (AppConfig.operator), so the
// hosted instance names Aconite and a self-hosted copy names its own operator. Terms and privacy
// exist only when an operator is set; the acceptable use policy applies on every instance.
import type { AppConfig, OperatorInfo } from "@plinth/shared";
import { APP_ROUTES } from "@plinth/shared";
import type { ReactNode } from "react";
import { Link } from "../../lib/router.tsx";

export const LEGAL_DOC_IDS = ["terms", "privacy", "acceptable-use"] as const;
export type LegalDocId = (typeof LEGAL_DOC_IDS)[number];

/** When the text of these pages last changed. Update it with any change to the wording. */
export const LEGAL_UPDATED = "20 November 2026";

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

/** Days an open is kept with who made it when the instance does not say (VIEW_LOG_RETENTION_DAYS). */
export const DEFAULT_VIEW_LOG_RETENTION_DAYS = 365;

/** The instance settings the pages use. */
export type LegalConfig = Pick<
  AppConfig,
  "operator" | "email_provider" | "max_artifacts_per_user" | "category_sharing"
> & {
  /** VIEW_LOG_RETENTION_DAYS; DEFAULT_VIEW_LOG_RETENTION_DAYS when absent. */
  view_log_retention_days?: number;
};

const EMAIL_SERVICE: Record<AppConfig["email_provider"], string | null> = {
  sendgrid: "Twilio SendGrid",
  resend: "Resend",
  console: null,
};

function Mail({ to }: { to: string }) {
  return <a href={`mailto:${to}`}>{to}</a>;
}

/** "Aconite Software & Investments, Lda., Avenida …, VAT PT…" */
function OperatorLine({ op }: { op: OperatorInfo }) {
  return (
    <>
      {op.name}
      {op.address ? `, ${op.address}` : ""}
      {op.registration ? ` (${op.registration})` : ""}
    </>
  );
}

function terms(op: OperatorInfo, cfg: LegalConfig): LegalDoc {
  return {
    title: "Terms of use",
    summary: "The rules for using this Plinth service, in plain words.",
    sections: [
      {
        heading: "Who runs this service",
        body: (
          <p>
            This Plinth service is run by <OperatorLine op={op} />. Write to us at{" "}
            <Mail to={op.email} /> about anything: questions, privacy, reports, or a request from an
            authority. Plinth is open-source software; these terms cover this service only, not
            copies other people run.
          </p>
        ),
      },
      {
        heading: "What Plinth does",
        body: (
          <p>
            Plinth stores web pages ("artifacts") that you, or AI agents you connect, publish. It
            keeps every version and shows each artifact only to the people you choose. New artifacts
            are private until you share them.
          </p>
        ),
      },
      {
        heading: "Your account and your agents",
        body: (
          <ul>
            <li>You sign in with your email address. Keep that mailbox secure.</li>
            <li>
              You are responsible for everything published through your account, including by the
              agents you connect. Disconnect an agent as soon as you stop trusting it.
            </li>
            <li>
              Each account can keep up to {cfg.max_artifacts_per_user} artifacts, and publishing is
              rate-limited to keep the service fair.
            </li>
          </ul>
        ),
      },
      {
        heading: "Your content",
        body: (
          <p>
            What you publish stays yours. You let us store, copy and show it only as needed to run
            the service for you and the people you share it with. You confirm that you have the
            right to publish it and that it follows the{" "}
            <Link to={APP_ROUTES.acceptableUse}>acceptable use policy</Link>.
          </p>
        ),
      },
      {
        heading: "Reporting content",
        body: (
          <p>
            If you believe an artifact is illegal or breaks the acceptable use policy, use the{" "}
            <strong>Report</strong> link on its page or write to <Mail to={op.email} />. We look at
            every report. If we take an artifact down or limit an account, we tell its owner why,
            and the owner can ask us to reconsider by replying to that message or writing to{" "}
            <Mail to={op.email} />.
          </p>
        ),
      },
      {
        heading: "No guarantees",
        body: (
          <p>
            We work to keep Plinth available and your data safe, but we provide it as it is, without
            a promise that it will always work. Keep your own copy of anything important. As far as
            the law allows, we are not liable for losses caused by using or being unable to use the
            service. Nothing in these terms limits rights you have under consumer law.
          </p>
        ),
      },
      {
        heading: "Ending",
        body: (
          <p>
            You can delete your artifacts at any time, and ask us to close your account by writing
            to <Mail to={op.email} />. We may suspend an account that seriously or repeatedly breaks
            these terms.
          </p>
        ),
      },
      {
        heading: "Changes",
        body: (
          <p>
            If we change these terms in a way that matters, we will say so on this page before the
            change applies. The date below shows when they last changed.
          </p>
        ),
      },
    ],
  };
}

function privacy(op: OperatorInfo, cfg: LegalConfig): LegalDoc {
  const emailService = EMAIL_SERVICE[cfg.email_provider];
  const openDays = cfg.view_log_retention_days ?? DEFAULT_VIEW_LOG_RETENTION_DAYS;
  return {
    title: "Privacy notice",
    summary: "What personal data this Plinth service keeps, why, and what you can ask for.",
    sections: [
      {
        heading: "Who is responsible",
        body: (
          <p>
            <OperatorLine op={op} /> is responsible for your personal data on this service. Write to{" "}
            <Mail to={op.email} /> with any privacy question or request.
          </p>
        ),
      },
      {
        heading: "What we keep",
        body: (
          <ul>
            <li>
              <strong>Your email address</strong>, and a name if you add one: to sign you in and to
              show who owns, edits or comments on an artifact. On pages that show who is viewing,
              they are also shown to the page and to the people it is shared with. A page can also
              let its owner, its editors and their agents see everyone it is shared with, by email
              address and role, and by name once that person has commented, entered something or
              published a version on it.
            </li>
            <li>
              <strong>Your artifacts</strong>: every version of the pages, files, titles, categories
              and notes you or your agents publish. They contain whatever you put in them. The
              categories you file artifacts shared with you under are seen by you only.
            </li>
            <li>
              <strong>What people enter on shared pages</strong>: some pages can save what their
              viewers enter (votes, sign-ups, entries on a tracker). We store what you enter, with
              your email address, your role and the time, and show them, with your name if you added
              one, to the page, its owner and the agents the owner connects. Only people the owner
              invited can enter anything.
            </li>
            <li>
              <strong>Sharing settings</strong>: the email addresses you give access to, and a
              scrambled (hashed) password if you set one.
            </li>
            {cfg.category_sharing && (
              <li>
                <strong>Shared categories</strong>: when you share a category, the email addresses
                of the people you share it with and their roles, the name they see for it, and which
                of its artifacts you chose to show them. They see that name and those artifacts,
                never the category's own name. If you are one of those people, the owner sees your
                email address and role, as for an artifact shared with you.
              </li>
            )}
            <li>
              <strong>Comments</strong>: their text, who wrote them, and requests made to agents.
            </li>
            <li>
              <strong>Connected agents</strong>: their names, permissions and when they were last
              used. We store only scrambled versions of their tokens.
            </li>
            <li>
              <strong>Reports</strong>: what was reported, why, and the reporter's email address if
              they gave one.
            </li>
            <li>
              <strong>Who opened a page</strong>: when someone other than its owner opens a page, we
              record when, which version, and who it was: the name and email address of people
              signed in to this service, and the email address of viewers who confirmed it with a
              code. Anyone else is recorded only by a random id in their viewing cookie, so the
              owner sees an approximate number of anonymous visitors, never who they are. No IP
              address or browser details are kept with an open. The page's owner sees this for their
              own pages, and the people who run this service see only totals across all pages.
            </li>
            <li>
              <strong>Unsaved page edits</strong>: when you edit a document on its page, we keep the
              unsaved draft and who last changed it until it is saved as a version or discarded, or
              until 30 days pass without a change. Who is on a page, where their cursor is, and live
              messages between people on a page are passed along and never stored.
            </li>
            <li>
              <strong>Technical logs</strong>: IP addresses, times and requests, to keep the service
              secure and stop abuse.
            </li>
          </ul>
        ),
      },
      {
        heading: "Why",
        body: (
          <p>
            To run the service you asked for, to keep it secure and free of abuse (our legitimate
            interest), and to handle reports of illegal content as the law requires. We do not sell
            your data, show ads, or use third-party analytics or tracking cookies. Opens are
            recorded by the service itself, to show owners who opened their pages and us how the
            service is used.
          </p>
        ),
      },
      {
        heading: "Who helps us",
        body: (
          <p>
            {op.hosting} hosts the service and its data.
            {emailService ? ` ${emailService} sends our sign-in and sharing emails.` : ""} They
            handle data only on our instructions, under data processing agreements. Where data
            leaves the European Economic Area, it is protected by the European Commission's standard
            contractual clauses or an adequacy decision.
          </p>
        ),
      },
      {
        heading: "How long",
        body: (
          <ul>
            <li>Your account, artifacts and comments: while your account exists.</li>
            <li>
              What people enter on shared pages: until the page's owner clears it or deletes the
              page.
            </li>
            <li>
              Who opened a page: {openDays} days, then only the number of opens, until the page's
              stored copy is erased. Erasing a person also removes who they were from these records.
            </li>
            <li>
              Unsaved page drafts: until saved or discarded, or 30 days after the last change.
            </li>
            <li>
              A deleted artifact disappears from Plinth at once. Its stored copy is erased when you
              ask us to, or when your account is closed.
            </li>
            <li>When you ask us to close your account, we erase it with everything above.</li>
            <li>Sign-in and viewing codes: 15 minutes. Technical logs: a few days.</li>
          </ul>
        ),
      },
      {
        heading: "Cookies",
        body: (
          <p>
            Only the cookies the service needs to work: your sign-in, protection against forged
            requests, proof that you entered an artifact's password or confirmed your email, and a
            viewing cookie for each artifact you open. On a page that saves what its viewers enter,
            that cookie also says who you are, so the page cannot pretend to be someone else. The
            viewing cookie also holds a random visitor id, so opening the page again within 12 hours
            is not counted twice and anonymous visitors can be counted. It lasts up to 30 days and
            adds nothing else about you.
          </p>
        ),
      },
      {
        heading: "Your rights",
        body: (
          <p>
            You can ask for a copy of your data, or to correct or erase it, or to limit or object to
            how we use it, by writing to <Mail to={op.email} />. If you are not happy with our
            answer, you can complain to a data protection authority (for example, the CNPD in
            Portugal).
          </p>
        ),
      },
    ],
  };
}

function acceptableUse(op: OperatorInfo | null): LegalDoc {
  return {
    title: "Acceptable use policy",
    summary: "What may not be published on this Plinth service, and what happens if it is.",
    sections: [
      {
        heading: "Not allowed",
        body: (
          <ul>
            <li>Anything illegal, or that promotes illegal acts.</li>
            <li>
              Phishing, collecting passwords or payment details under false pretences, or pages that
              pretend to be another person, company or service.
            </li>
            <li>Malware, exploits, cryptocurrency mining, or code that attacks visitors.</li>
            <li>Child sexual abuse material. We remove it and report it to the authorities.</li>
            <li>Harassment, threats, or content that incites violence or hatred.</li>
            <li>
              Other people's personal data without a lawful reason, or content that infringes
              copyright, trademarks or other rights.
            </li>
            <li>Spam, redirect pages, or hosting files that are not part of an artifact.</li>
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
            Whatever an agent connected to your account publishes counts as published by you.
            Comments and mentions are requests from collaborators; they never give an agent more
            authority than you gave it.
          </p>
        ),
      },
      {
        heading: "Reporting and what we do",
        body: (
          <p>
            Use the <strong>Report</strong> link on any artifact
            {op ? (
              <>
                , or write to <Mail to={op.email} />
              </>
            ) : null}
            . We review every report and may take an artifact down or limit or suspend an account,
            telling its owner why.
          </p>
        ),
      },
    ],
  };
}

/** The legal pages this instance publishes. Terms and privacy only exist with an operator. */
export function legalDoc(id: LegalDocId, cfg: LegalConfig): LegalDoc | null {
  if (id === "acceptable-use") return acceptableUse(cfg.operator);
  if (!cfg.operator) return null;
  return id === "terms" ? terms(cfg.operator, cfg) : privacy(cfg.operator, cfg);
}
