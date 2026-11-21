// Sheets for agents: read_sheet (cells with computed values) and edit_sheet (cell, row and column
// ops applied to base_version, published as one new version). Every read and write goes through
// policy.ts as the caller: read_sheet is the view action (requireArtifact, as get_artifact), and
// edit_sheet is edit, then updateArtifact checks edit rights and the base again, rate-limits,
// stages and commits like any update. The type is checked after the access decision, so nobody
// learns whether an artifact they cannot view exists or what type it is. Formulas are evaluated
// only for the cells asked for and what they depend on, within SHEET_EVAL_BUDGET steps.
import {
  a1,
  applySheetOps,
  type Cell,
  colLetter,
  type EditSheetInput,
  evaluateSheet,
  isError,
  isFormula,
  LIMITS,
  parseRange,
  parseSheet,
  type ReadSheetInput,
  round15,
  type Sheet,
  type SheetEditResult,
  type SheetOp,
  SheetOpError,
  type SheetRead,
  type SheetReadCell,
  type SheetReadStyle,
  type SheetReadValue,
  serializeSheet,
  TYPE_REGISTRY,
  type Value,
} from "@plinth/shared";
import type { ArtifactRow } from "../db/schema.ts";
import { ApiError } from "../lib/errors.ts";
import { requireArtifact, requireVersion, updateArtifact } from "./artifacts.ts";
import { rememberCheckedSheet } from "./artifactTypes/sheet.ts";
import type { Ctx } from "./context.ts";
import { conflictError } from "./stage.ts";
import { readText } from "./storage.ts";

const DEF = TYPE_REGISTRY.sheet;

function requireSheet(artifact: ArtifactRow, tool: "read_sheet" | "edit_sheet"): void {
  if (artifact.type === DEF.id) return;
  throw new ApiError(
    "invalid_input",
    tool === "read_sheet"
      ? 'read_sheet reads type "sheet" artifacts; use get_artifact'
      : 'edit_sheet changes type "sheet" artifacts; use update_artifact',
    { type: artifact.type, field: "id" },
  );
}

async function storedSheet(ctx: Ctx, artifact: ArtifactRow, n: number): Promise<Sheet> {
  const v = await requireVersion(ctx, artifact, n);
  const text = await readText(ctx.env.FILES, `${v.r2Prefix}${DEF.sourcePath}`);
  if (text === null) throw new ApiError("internal", `Stored ${DEF.sourceLabel} is missing`);
  const r = parseSheet(text);
  if (!r.ok) throw new ApiError("internal", "The stored sheet does not parse");
  return r.sheet;
}

function wireValue(v: Value): SheetReadValue {
  if (isError(v)) return { error: v.error };
  return typeof v === "number" ? round15(v) : v;
}

/** Read a sheet's cells as the caller, formulas with their values. */
export async function readSheet(ctx: Ctx, input: ReadSheetInput): Promise<SheetRead> {
  const { artifact } = await requireArtifact(ctx, input.id, "view");
  requireSheet(artifact, "read_sheet");
  let range = input.range ? parseRange(input.range) : null;
  if (input.range && !range) {
    throw new ApiError(
      "invalid_input",
      `${input.range} is not an A1 range such as A1:F200, B:D or 2:50`,
      {
        field: "range",
      },
    );
  }
  const version = input.version ?? artifact.currentVersion;
  const sheet = await storedSheet(ctx, artifact, version);
  const cols = sheet.header.columns;
  const lastRow = sheet.rows.length + 1;
  const lastCol = cols.length - 1;
  range ??= { r1: 2, c1: 0, r2: lastRow, c2: lastCol };
  const r1 = range.r1;
  const c1 = range.c1;
  const r2 = Math.min(range.r2, lastRow);
  const c2 = Math.min(range.c2, lastCol);
  const width = c2 - c1 + 1;
  const empty = r1 > r2 || c1 > c2;
  const limit = input.limit_cells ?? LIMITS.defaultSheetReadCells;
  const take = empty ? 0 : Math.min(r2 - r1 + 1, Math.max(1, Math.floor(limit / width)));
  const end = r1 + take - 1;

  const cellAt = (row: number, col: number): Cell =>
    row === 1 ? (cols[col]?.name ?? null) : ((sheet.rows[row - 2] ?? [])[col] ?? null);
  const formulas: [number, number][] = [];
  if (input.values !== false) {
    for (let r = Math.max(2, r1); r <= end; r++) {
      for (let c = c1; c <= c2; c++) if (isFormula(cellAt(r, c))) formulas.push([r, c]);
    }
  }
  const ev =
    formulas.length > 0
      ? evaluateSheet(sheet, { budget: ctx.config.sheetEvalBudget, cells: formulas })
      : null;
  const rows: SheetRead["rows"] = [];
  for (let r = r1; r <= end; r++) {
    const cells: SheetReadCell[] = [];
    let style: Record<string, SheetReadStyle> | undefined;
    const rowStyle = r > 1 ? sheet.styles?.[r - 2] : undefined;
    for (let c = c1; c <= c2; c++) {
      const cell = cellAt(r, c);
      if (r > 1 && isFormula(cell)) {
        cells.push(ev ? { f: cell, v: wireValue(ev.value(r, c)) } : { f: cell });
      } else cells.push(cell);
      const s = rowStyle?.[c];
      if (s) {
        style ??= {};
        style[colLetter(c)] = { ...s, ...(s.border ? { border: [...s.border] } : {}) };
      }
    }
    rows.push(style ? { row: r, cells, style } : { row: r, cells });
  }
  const truncated = !empty && end < r2;
  return {
    id: artifact.id,
    slug: artifact.slug,
    type: "sheet",
    title: artifact.title,
    version,
    current_version: artifact.currentVersion,
    columns: cols.map((c, i) => ({
      letter: colLetter(i),
      name: c.name,
      type: c.type,
      ...(c.format ? { format: { ...c.format } } : {}),
      ...(c.options ? { options: [...c.options] } : {}),
      ...(c.colors ? { colors: { ...c.colors } } : {}),
      ...(c.highlight ? { highlight: c.highlight.map((h) => ({ ...h })) } : {}),
    })),
    row_count: sheet.rows.length,
    range: empty ? null : `${a1(r1, c1)}:${a1(end, c2)}`,
    rows,
    truncated,
    next_range: truncated ? `${a1(end + 1, c1)}:${a1(r2, c2)}` : null,
    warnings: ev?.exhausted
      ? [
          {
            code: "eval_budget",
            message:
              "Some formulas were not evaluated within this instance's budget; their v is #LIMIT!. Read a smaller range.",
          },
        ]
      : [],
    untrusted: true,
  };
}

/** Apply ops to base_version and publish the result as one new version, or nothing. */
export async function editSheet(ctx: Ctx, input: EditSheetInput): Promise<SheetEditResult> {
  const { artifact } = await requireArtifact(ctx, input.id, "edit");
  requireSheet(artifact, "edit_sheet");
  // A stale base is a conflict before any R2 read; updateArtifact checks it again atomically.
  if (input.base_version !== artifact.currentVersion) {
    throw conflictError(input.base_version, artifact.currentVersion);
  }
  const base = await storedSheet(ctx, artifact, input.base_version);
  let applied: ReturnType<typeof applySheetOps>;
  try {
    applied = applySheetOps(base, input.ops as SheetOp[]);
  } catch (e) {
    if (!(e instanceof SheetOpError)) throw e;
    throw new ApiError("invalid_input", `ops[${e.index}]: ${e.message}`, {
      type: "sheet",
      field: "ops",
      op: e.index,
      ...(e.reason ? { reason: e.reason } : {}),
      next: "Nothing was published. Fix this op and send every op again.",
    });
  }
  const content = serializeSheet(applied.sheet);
  const checked = parseSheet(content);
  if (!checked.ok) {
    throw new ApiError(
      "invalid_input",
      `After the ops the sheet has ${checked.count} problem${checked.count === 1 ? "" : "s"}; the first ones are listed in details.issues`,
      {
        type: "sheet",
        field: "ops",
        issues: checked.errors,
        count: checked.count,
        next: "Nothing was published. Change the ops so every cell fits its column, then send them again.",
      },
    );
  }
  // The publish takes this checked sheet as it is, without parsing or serializing it again.
  rememberCheckedSheet(content, checked.sheet);
  const result = await updateArtifact(ctx, {
    id: artifact.id,
    content,
    base_version: input.base_version,
    note: input.note ?? "Edited cells",
  });
  return { ...result, changed: applied.changed };
}
