// What changed in a design system (system.json): its name and description, fonts, tokens (added,
// removed, and their light and dark values, descriptions and deprecation), the guidelines (as a
// doc), and components (added, removed, renamed, their status, description and usage). A
// component's examples and styles are code, so the list only says that they changed.
import {
  type DesignSystem,
  type DsComponent,
  type DsToken,
  parseDesignSystem,
} from "../designSystem.ts";
import { describeMarkdown } from "./doc.ts";
import { changeExcerpt, differenceExcerpts, quoted } from "./text.ts";
import type { ChangeCollector } from "./types.ts";

function tokenValue(t: DsToken, dark: boolean): string {
  const v = dark ? (t.dark ?? t.value) : t.value;
  return t.aliasOf && !dark ? `${t.aliasOf} (${v})` : v;
}

function describeTokens(out: ChangeCollector, a: DesignSystem, b: DesignSystem): void {
  const where = "Tokens";
  const old = new Map(a.tokens.map((t) => [t.path, t]));
  const next = new Map(b.tokens.map((t) => [t.path, t]));
  for (const t of a.tokens) {
    if (!next.has(t.path)) {
      out.add({ kind: "removed", where, what: `${t.path} removed`, before: tokenValue(t, false) });
    }
  }
  for (const t of b.tokens) {
    const was = old.get(t.path);
    if (!was) {
      out.add({ kind: "added", where, what: `${t.path} added`, after: tokenValue(t, false) });
      continue;
    }
    if (tokenValue(was, false) !== tokenValue(t, false)) {
      out.add({
        kind: "changed",
        where,
        what: `${t.path} changed`,
        before: tokenValue(was, false),
        after: tokenValue(t, false),
      });
    }
    if ((was.dark ?? was.value) !== (t.dark ?? t.value) && (was.dark !== null || t.dark !== null)) {
      out.add({
        kind: "changed",
        where,
        what: `${t.path} changed in the dark theme`,
        before: tokenValue(was, true),
        after: tokenValue(t, true),
      });
    }
    if ((was.description ?? "") !== (t.description ?? "")) {
      out.add({
        kind: "changed",
        where,
        what: `${t.path}: description changed`,
        ...differenceExcerpts(was.description ?? "", t.description ?? ""),
      });
    }
    if (Boolean(was.deprecated) !== Boolean(t.deprecated)) {
      out.add({
        kind: "changed",
        where,
        what: t.deprecated ? `${t.path} is now deprecated` : `${t.path} is no longer deprecated`,
      });
    }
    if (out.full) return;
  }
}

function describeComponent(out: ChangeCollector, a: DsComponent, b: DsComponent): void {
  const where = `Component ${quoted(b.name)}`;
  if (a.name !== b.name) {
    out.add({
      kind: "changed",
      where,
      what: `Component ${quoted(a.name)} renamed`,
      before: a.name,
      after: b.name,
    });
  }
  if (a.status !== b.status) {
    out.add({ kind: "changed", where, what: "Status changed", before: a.status, after: b.status });
  }
  if ((a.description ?? "") !== (b.description ?? "")) {
    out.add({
      kind: "changed",
      where,
      what: "Description changed",
      ...differenceExcerpts(a.description ?? "", b.description ?? ""),
    });
  }
  if ((a.usage ?? "") !== (b.usage ?? "")) {
    out.add({
      kind: "changed",
      where,
      what: "Usage changed",
      ...differenceExcerpts(a.usage ?? "", b.usage ?? ""),
    });
  }
  const look = (c: DsComponent) => JSON.stringify([c.css, c.examples]);
  if (look(a) !== look(b)) {
    out.add({ kind: "changed", where, what: "Examples or styles changed" });
  }
}

/** Adds the changes from `before` to `after`, two design systems, to `out`. False when one does not parse. */
export function describeDesignSystem(out: ChangeCollector, before: string, after: string): boolean {
  const pa = parseDesignSystem(before);
  const pb = parseDesignSystem(after);
  if (!pa.ok || !pb.ok) return false;
  const a = pa.value;
  const b = pb.value;
  if (a.name !== b.name) {
    out.add({ kind: "changed", where: "", what: "Name changed", before: a.name, after: b.name });
  }
  if ((a.description ?? "") !== (b.description ?? "")) {
    out.add({
      kind: "changed",
      where: "",
      what: "Description changed",
      ...differenceExcerpts(a.description ?? "", b.description ?? ""),
    });
  }
  if (a.prefix !== b.prefix) {
    out.add({
      kind: "changed",
      where: "",
      what: "Variable prefix changed",
      before: a.prefix,
      after: b.prefix,
    });
  }
  const families = (ds: DesignSystem) => ds.fonts.map((f) => f.family);
  for (const f of families(a)) {
    if (!families(b).includes(f))
      out.add({ kind: "removed", where: "Fonts", what: `Font ${quoted(f)} removed` });
  }
  for (const f of families(b)) {
    if (!families(a).includes(f))
      out.add({ kind: "added", where: "Fonts", what: `Font ${quoted(f)} added` });
  }
  const fontsOf = (ds: DesignSystem) => JSON.stringify(ds.fonts);
  if (fontsOf(a) !== fontsOf(b) && JSON.stringify(families(a)) === JSON.stringify(families(b))) {
    out.add({ kind: "changed", where: "Fonts", what: "Font files or weights changed" });
  }
  describeTokens(out, a, b);
  if ((a.guidelines ?? "") !== (b.guidelines ?? "")) {
    describeMarkdown(out, a.guidelines ?? "", b.guidelines ?? "", { prefix: "Guidelines" });
  }
  if ((a.css ?? "") !== (b.css ?? "")) {
    out.add({ kind: "changed", where: "", what: "Shared styles changed" });
  }
  const old = new Map(a.components.map((c) => [c.id, c]));
  const next = new Map(b.components.map((c) => [c.id, c]));
  for (const c of a.components) {
    if (!next.has(c.id)) {
      out.add({
        kind: "removed",
        where: "Components",
        what: `Component ${quoted(c.name)} removed`,
      });
    }
  }
  for (const c of b.components) {
    const was = old.get(c.id);
    if (!was) {
      out.add({
        kind: "added",
        where: "Components",
        what: `Component ${quoted(c.name)} added`,
        after: c.description ? changeExcerpt(c.description) : undefined,
      });
      continue;
    }
    describeComponent(out, was, c);
    if (out.full) break;
  }
  return true;
}
