// Page: /legal/terms, /legal/privacy, /legal/acceptable-use. Final text built from the instance's
// operator settings (components/viewer/legalDocs.tsx); terms and privacy exist only when the
// instance names an operator.
import { useEffect } from "react";
import { PublicShell } from "../components/layout/PublicShell.tsx";
import { PageHeader } from "../components/ui/index.ts";
import { isLegalDocId, LEGAL_UPDATED, legalDoc } from "../components/viewer/legalDocs.tsx";
import { useSession } from "../lib/session.ts";
import "../components/viewer/legal.css";
import NotFound from "./NotFound.tsx";

export default function Legal({ params }: { params: Record<string, string> }) {
  const id = params.doc ?? "";
  const { config, loading } = useSession();
  const doc = isLegalDocId(id) && config ? legalDoc(id, config) : null;

  useEffect(() => {
    if (doc) document.title = `${doc.title} · Plinth`;
  }, [doc]);

  if (loading && !config) return <PublicShell width="reading">{null}</PublicShell>;
  if (!doc) return <NotFound />;

  return (
    <PublicShell width="reading">
      <article className="pl-legal">
        <PageHeader title={doc.title} description={doc.summary} />
        {doc.sections.map((s, i) => (
          <section key={s.heading} className="pl-legal__section" aria-labelledby={`legal-s${i}`}>
            <h2 id={`legal-s${i}`}>{s.heading}</h2>
            {s.body}
          </section>
        ))}
        <p className="pl-legal__updated">Last updated: {LEGAL_UPDATED}</p>
      </article>
    </PublicShell>
  );
}
