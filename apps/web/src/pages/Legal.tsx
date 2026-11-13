// Page: /legal/terms, /legal/privacy, /legal/acceptable-use. Placeholder templates the operator of
// an instance must replace; they are marked as such at the top and in every bracketed field.
import { WarningIcon } from "@phosphor-icons/react";
import { useEffect } from "react";
import { PublicShell } from "../components/layout/PublicShell.tsx";
import { ICON_SIZE, PageHeader } from "../components/ui/index.ts";
import { isLegalDocId, LEGAL_DOCS } from "../components/viewer/legalDocs.tsx";
import "../components/viewer/legal.css";
import NotFound from "./NotFound.tsx";

export default function Legal({ params }: { params: Record<string, string> }) {
  const id = params.doc ?? "";
  const doc = isLegalDocId(id) ? LEGAL_DOCS[id] : null;

  useEffect(() => {
    if (doc) document.title = `${doc.title} · Plinth`;
  }, [doc]);

  if (!doc) return <NotFound />;

  return (
    <PublicShell width="reading">
      <article className="pl-legal">
        <PageHeader title={doc.title} description={doc.summary} />
        <aside className="pl-legal__template" aria-label="Template notice">
          <WarningIcon size={ICON_SIZE.md} aria-hidden="true" />
          <div>
            <p className="pl-legal__template-title">
              Template — not legal advice; the operator must replace this text.
            </p>
            <p>
              This page is a starting point shipped with Plinth. Until the operator of this instance
              has reviewed it with a lawyer and filled in every highlighted field, it is not an
              agreement or a notice anyone can rely on.
            </p>
          </div>
        </aside>
        {doc.sections.map((s, i) => (
          <section key={s.heading} className="pl-legal__section" aria-labelledby={`legal-s${i}`}>
            <h2 id={`legal-s${i}`}>{s.heading}</h2>
            {s.body}
          </section>
        ))}
        <p className="pl-legal__updated">
          Last updated: <mark className="pl-legal__field">[date]</mark>
        </p>
      </article>
    </PublicShell>
  );
}
