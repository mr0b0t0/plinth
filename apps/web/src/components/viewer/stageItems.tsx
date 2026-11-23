// The viewer's chrome as item lists: the ⋯ menu (MENU_ITEMS), the controls on the right of the bar
// (BAR_CONTROLS) and the strip of notices under the bar (STRIP_ITEMS). ViewerStage owns the state
// and builds one StageContext; each item reads it and returns its entries or element, or nothing.
//
// A feature adds its own item function (in its own file) and one line in the list where it
// belongs. Items for one artifact type go in TYPE_MENU_ITEMS, items for one declared capability in
// CAPABILITY_MENU_ITEMS. Order in a list is the order on screen. A menu item that opens a dialog
// adds the dialog to STAGE_DIALOGS and opens it by id (actions.openDialog). Layout and behaviour
// of the stage itself (the frame, the hold rule) stay in ViewerStage.

import {
  ArrowsOutIcon,
  ChartLineUpIcon,
  ChatCircleIcon,
  ClockCounterClockwiseIcon,
  DotsThreeIcon,
  DownloadSimpleIcon,
  FlagIcon,
  GearSixIcon,
  MoonIcon,
  PencilSimpleIcon,
  PlayIcon,
  PresentationChartIcon,
  PrinterIcon,
  ProjectorScreenIcon,
  ShareNetworkIcon,
  SunIcon,
  TrashIcon,
} from "@phosphor-icons/react";
import {
  type AppConfig,
  type ArtifactType,
  type DataCapability,
  typeDef,
  type ViewGate,
} from "@plinth/shared";
import type { ReactNode, RefObject } from "react";
import { Link } from "../../lib/router.tsx";
import { THEME_NAMES, type Theme } from "../../lib/theme.ts";
import {
  Button,
  buttonClassName,
  ConfirmDialog,
  Menu,
  type MenuEntry,
  Tooltip,
} from "../ui/index.ts";
import { boardSettings, boardSettingsDialog } from "./boardSettingsItems.tsx";
import { DataNotice } from "./DataNotice.tsx";
import { deckSettings, notWhileEditing, unpublishableReason } from "./deckItems.ts";
import { designExportDialog, downloadDesign, unlessExports } from "./designItems.tsx";
import { EditBar } from "./EditBar.tsx";
import { LiveDraftNotice } from "./LiveDraftNotice.tsx";
import {
  postBoardExport,
  postExport,
  postPrint,
  rendererTargetOrigin,
} from "./rendererProtocol.ts";
import { replaceSheet, replaceSheetDialog } from "./sheetReplaceItems.tsx";
import type { LiveEdit } from "./useLiveEdit.ts";
import type { Presentation } from "./usePresentation.ts";
import type { ViewUpdate } from "./useViewUpdate.ts";

type OkGate = Extract<ViewGate, { status: "ok" }>;

/** Who may open the editor. The editor page and the API check again. */
export const canEdit = (role: OkGate["role"]) => role === "owner" || role === "editor";

/** Everything an item may read or do. Built by ViewerStage on each render. */
export interface StageContext {
  gate: OkGate;
  /** Opened through a permanent version link (/a/:slug/v/:n), which keeps showing that version. */
  pinned: boolean;
  config: AppConfig | null;
  /** Phone width: History and Share fold into the ⋯ menu. */
  compact: boolean;
  frame: HTMLIFrameElement | null;
  contentOrigin: string;
  /** On-page editing (#36). */
  live: LiveEdit;
  editing: boolean;
  /** Presenting a deck (usePresentation); inert for every other type. */
  present: Presentation;
  /** Live views: a newer version held while the viewer uses the page (useViewUpdate). */
  update: ViewUpdate;
  hrefs: {
    current: string;
    edit: string;
    history: string;
    report: string;
    settings: string;
    stats: string;
    signIn: string;
  };
  comments: {
    open: boolean;
    /** Open threads, or null while unknown. */
    count: number | null;
    toggleRef: RefObject<HTMLButtonElement | null>;
    close: () => void;
    toggle: () => void;
  };
  refs: {
    edit: RefObject<HTMLButtonElement | null>;
    bar: RefObject<HTMLElement | null>;
  };
  theme: { next: Theme; set: (t: Theme) => void };
  actions: {
    openShare: () => void;
    toggleEditing: () => void;
    startEditing: () => void;
    finishEditing: () => void;
    /** After a notice button that may have unmounted with focus in it: move focus on. */
    refocusAfterNotice: () => void;
    /** Fetch a fresh gate (the newest version). */
    reload: () => void;
    /** Open the dialog with this id from STAGE_DIALOGS (one at a time). */
    openDialog: (id: string) => void;
  };
}

/** Menu entries from one item: none, one or several. */
export type MenuItem = (c: StageContext) => MenuEntry[];
/** One element of the bar or the strip, or nothing. */
export type StageNode = (c: StageContext) => ReactNode;
/** A bar control or strip item: a unique id (its React key) and what it renders. */
export interface StageItem {
  id: string;
  render: StageNode;
}
/** A dialog the stage holds: rendered only while open, `close` closes it. */
export interface StageDialog {
  id: string;
  render: (c: StageContext, close: () => void) => ReactNode;
}

// ---------- the ⋯ menu ----------

const compactShareHistory: MenuItem = (c) =>
  c.compact
    ? [
        { label: "Share", icon: ShareNetworkIcon, onSelect: c.actions.openShare },
        { label: "History", icon: ClockCounterClockwiseIcon, href: c.hrefs.history },
      ]
    : [];

/** At phone width the Edit toggle folds in here; while editing, the strip's Done is the way out. */
const compactEditToggle: MenuItem = (c) =>
  c.compact && c.live.available && !c.live.signIn && !c.editing && !c.live.blocked
    ? [{ label: "Edit on the page", icon: PencilSimpleIcon, onSelect: c.actions.toggleEditing }]
    : [];

/** The dialog's id in STAGE_DIALOGS: the confirmation of discardEdits. */
export const DISCARD_EDITS_DIALOG = "discard-edits";

/**
 * Discarding the changes made on the page: here, in the menu that already holds the artifact's
 * actions, not in a second menu on the edit strip. Only while editing with something to discard
 * and nothing to review (the review has its own Discard) or publishing.
 */
const discardEdits: MenuItem = (c) =>
  c.editing &&
  c.live.status?.dirty &&
  c.live.phase !== "conflict" &&
  !c.live.saving &&
  !c.live.reviewing
    ? [
        {
          label: "Discard unpublished changes",
          icon: TrashIcon,
          danger: true,
          onSelect: () => c.actions.openDialog(DISCARD_EDITS_DIALOG),
        },
      ]
    : [];

const compactSignInToEdit: MenuItem = (c) =>
  c.compact && c.live.available && c.live.signIn
    ? [{ label: "Sign in to edit", icon: PencilSimpleIcon, href: c.hrefs.signIn }]
    : [];

/** Asks before discardEdits drops the changes, with the words the review's Discard uses. */
const discardEditsDialog: StageDialog = {
  id: DISCARD_EDITS_DIALOG,
  render: (c, close) => (
    <ConfirmDialog
      open
      onClose={close}
      onConfirm={() => {
        close();
        void c.live.discard();
      }}
      title="Discard unpublished changes?"
      description={
        c.live.mode === "room"
          ? "The page goes back to the published version for everyone editing it."
          : "The page goes back to the published version."
      }
      confirmLabel="Discard changes"
      danger
    />
  ),
};

/**
 * The source editor, for a type that has one (not a sheet or a design: agents change those) and
 * only where the page cannot be edited in place. Where it can (a doc), the Edit toggle is the one
 * way in, and no source is offered beside it. An HTML deck has none either (`no_editor`).
 */
const editSource: MenuItem = (c) =>
  canEdit(c.gate.role) &&
  typeDef(c.gate.artifact.type)?.editor &&
  !c.live.available &&
  !c.gate.no_editor
    ? [{ label: "Edit", icon: PencilSimpleIcon, href: c.hrefs.edit }]
    : [];

const settings: MenuItem = (c) =>
  c.gate.role === "owner" ? [{ label: "Settings", icon: GearSixIcon, href: c.hrefs.settings }] : [];

const stats: MenuItem = (c) =>
  c.gate.role === "owner" ? [{ label: "Stats", icon: ChartLineUpIcon, href: c.hrefs.stats }] : [];

/**
 * A doc prints itself: the renderer in the frame calls its own print(), so the browser prints the
 * document (or saves it as PDF), not this page around it.
 */
const printTyped: MenuItem = (c) => [
  {
    label: "Print or save as PDF",
    icon: PrinterIcon,
    onSelect: () => postPrint(c.frame, rendererTargetOrigin(c.config, c.contentOrigin)),
  },
];

/**
 * A deck as .pptx: the frame builds the file from the slides it shows and downloads it. Only for
 * a type whose renderer offers it (fileExports), and not twice at once.
 */
const downloadPptx: MenuItem = (c) =>
  c.present.available && typeDef(c.gate.artifact.type)?.fileExports?.includes("pptx")
    ? [
        {
          label: c.present.exporting ? "Making the .pptx…" : "Download .pptx",
          icon: DownloadSimpleIcon,
          disabled: c.present.exporting,
          onSelect: c.present.exportPptx,
        },
      ]
    : [];

/**
 * A sheet downloads itself: the frame builds the file, the app only names the format. Two items
 * labelled like a deck's Download .pptx, not a submenu: the menu has none.
 */
const downloadSheet: MenuItem = (c) => [
  {
    label: "Download .xlsx",
    icon: DownloadSimpleIcon,
    onSelect: () => postExport(c.frame, rendererTargetOrigin(c.config, c.contentOrigin), "xlsx"),
  },
  {
    label: "Download .csv",
    icon: DownloadSimpleIcon,
    onSelect: () => postExport(c.frame, rendererTargetOrigin(c.config, c.contentOrigin), "csv"),
  },
];

/** A whiteboard downloads itself the same way, as a PNG or an SVG of the whole board. */
const downloadBoard: MenuItem = (c) => [
  {
    label: "Download as PNG",
    icon: DownloadSimpleIcon,
    onSelect: () =>
      postBoardExport(c.frame, rendererTargetOrigin(c.config, c.contentOrigin), "png"),
  },
  {
    label: "Download as SVG",
    icon: DownloadSimpleIcon,
    onSelect: () =>
      postBoardExport(c.frame, rendererTargetOrigin(c.config, c.contentOrigin), "svg"),
  },
];

/** Menu items for one artifact type, in order, after Settings and Stats. One type per line. */
export const TYPE_MENU_ITEMS: Partial<Record<ArtifactType, readonly MenuItem[]>> = {
  doc: [printTyped],
  slides: [notWhileEditing(printTyped), notWhileEditing(downloadPptx), deckSettings],
  design: [unlessExports(printTyped), downloadDesign],
  sheet: [printTyped, downloadSheet],
  whiteboard: [boardSettings, downloadBoard],
};

/**
 * The Present control's two ways to present a deck: full screen (the app puts its own frame full
 * screen) and presenter view (notes, the next slide and a timer, in the frame). While presenter
 * view is on, its slot opens an audience window that follows it; the frame's own Exit and Escape
 * leave presenter view. An audience window offers full screen only.
 */
export function presentEntries(p: Presentation): MenuEntry[] {
  const entries: MenuEntry[] = [{ label: "Full screen", icon: ArrowsOutIcon, onSelect: p.present }];
  if (p.mode === "presenter") {
    entries.push({ label: "Audience window", icon: ProjectorScreenIcon, onSelect: p.openAudience });
  } else if (p.mode === "off") {
    entries.push({
      label: "Presenter view",
      icon: PresentationChartIcon,
      onSelect: p.presenterView,
    });
  }
  return entries;
}

/** Menu items for a page that declares one capability, in order, after the type's items. */
export const CAPABILITY_MENU_ITEMS: Partial<Record<DataCapability, readonly MenuItem[]>> = {};

const typeItems: MenuItem = (c) =>
  (TYPE_MENU_ITEMS[c.gate.artifact.type] ?? []).flatMap((item) => item(c));

const capabilityItems: MenuItem = (c) =>
  (c.gate.data?.capabilities ?? []).flatMap((cap) =>
    (CAPABILITY_MENU_ITEMS[cap] ?? []).flatMap((item) => item(c)),
  );

/** Owners and editors do not report their own work; the footer link stays for all. */
const report: MenuItem = (c) =>
  canEdit(c.gate.role) ? [] : [{ label: "Report", icon: FlagIcon, href: c.hrefs.report }];

const separator: MenuItem = () => [{ type: "separator" }];

const switchTheme: MenuItem = (c) => [
  {
    label: `Switch to ${THEME_NAMES[c.theme.next]}`,
    icon: c.theme.next === "dark" ? MoonIcon : SunIcon,
    onSelect: () => c.theme.set(c.theme.next),
  },
];

/** The ⋯ menu, top to bottom. One item per line. */
export const MENU_ITEMS: readonly MenuItem[] = [
  compactShareHistory,
  compactEditToggle,
  compactSignInToEdit,
  editSource,
  replaceSheet,
  settings,
  stats,
  typeItems,
  capabilityItems,
  report,
  discardEdits,
  separator,
  switchTheme,
];

/** The ⋯ menu's entries for this context. */
export function menuEntries(c: StageContext): MenuEntry[] {
  return MENU_ITEMS.flatMap((item) => item(c));
}

/** The dialogs a menu item may open, by id. One dialog per line. */
export const STAGE_DIALOGS: readonly StageDialog[] = [
  boardSettingsDialog,
  designExportDialog,
  discardEditsDialog,
  replaceSheetDialog,
];

// ---------- the bar's controls ----------

const historyLink: StageNode = (c) =>
  !c.compact && (
    <Tooltip content="History" placement="bottom">
      <Link
        to={c.hrefs.history}
        aria-label="History"
        className={buttonClassName({ variant: "ghost", iconOnly: true })}
      >
        <span className="pl-button__content">
          <ClockCounterClockwiseIcon size={16} aria-hidden="true" />
        </span>
      </Link>
    </Tooltip>
  );

const editToggle: StageNode = (c) =>
  c.live.available &&
  !c.compact &&
  !c.live.signIn && (
    <Tooltip
      content={c.editing ? "Done editing" : (c.live.blocked ?? "Edit on the page")}
      placement="bottom"
    >
      {/* Off while the page has problems only an agent can fix: still focusable, so its reason
          (the tooltip) can be read; Ask an agent is the way in. */}
      <Button
        ref={c.refs.edit}
        variant="ghost"
        icon={PencilSimpleIcon}
        aria-label="Edit"
        aria-pressed={c.editing}
        aria-disabled={c.live.blocked && !c.editing ? true : undefined}
        className="pl-viewer__edit"
        onClick={c.live.blocked && !c.editing ? undefined : c.actions.toggleEditing}
      />
    </Tooltip>
  );

const signInToEdit: StageNode = (c) =>
  c.live.available &&
  !c.compact &&
  c.live.signIn && (
    <Tooltip content="Sign in to edit" placement="bottom">
      <Link
        to={c.hrefs.signIn}
        aria-label="Sign in to edit"
        className={buttonClassName({ variant: "ghost", iconOnly: true })}
      >
        <span className="pl-button__content">
          <PencilSimpleIcon size={16} aria-hidden="true" />
        </span>
      </Link>
    </Tooltip>
  );

/**
 * The count sits beside the button, not in it, so the button's name stays exactly its visible
 * label (WCAG 2.5.3); the panel announces the numbers.
 */
const commentsToggle: StageNode = (c) => {
  const counted = c.comments.count !== null && c.comments.count > 0;
  return (
    <span className="pl-viewer__comments-wrap">
      <Button
        ref={c.comments.toggleRef}
        variant="ghost"
        icon={ChatCircleIcon}
        aria-label="Comments"
        aria-pressed={c.comments.open}
        className={`pl-viewer__comments${counted ? " pl-viewer__comments--counted" : ""}`}
        onClick={c.comments.open ? c.comments.close : c.comments.toggle}
      />
      {counted && (
        <span className="pl-viewer__count" aria-hidden="true">
          {c.comments.count}
        </span>
      )}
    </span>
  );
};

/**
 * Present a deck: the one bar control for full screen and presenter view (presentEntries). Not
 * while the deck is edited on the page: Done publishes and ends editing first.
 */
const presentButton: StageNode = (c) =>
  c.present.available &&
  !c.editing && (
    <Menu
      label="Present"
      icon={PlayIcon}
      iconOnly
      variant="ghost"
      align="end"
      triggerClassName="pl-viewer__present-button"
      items={presentEntries(c.present)}
    />
  );

const shareButton: StageNode = (c) =>
  !c.compact && (
    <Button variant="primary" onClick={c.actions.openShare}>
      Share
    </Button>
  );

const actionsMenu: StageNode = (c) => (
  <Menu
    label="Artifact actions"
    icon={DotsThreeIcon}
    iconOnly
    variant="ghost"
    align="end"
    items={menuEntries(c)}
  />
);

/** The controls on the right of the bar, left to right. One control per line. */
export const BAR_CONTROLS: readonly StageItem[] = [
  { id: "history", render: historyLink },
  { id: "edit", render: editToggle },
  { id: "sign-in-to-edit", render: signInToEdit },
  { id: "present", render: presentButton },
  { id: "comments", render: commentsToggle },
  { id: "share", render: shareButton },
  { id: "menu", render: actionsMenu },
];

// ---------- the strip under the bar ----------

// While a version is held its toast says so (useViewUpdate.ts), so this line stays away: one
// notice, and the frame does not move under the viewer.
const olderVersion: StageNode = ({ gate: { artifact }, hrefs, update }) =>
  update.held === null &&
  artifact.version < artifact.current_version && (
    <p className="pl-viewer__notice">
      You are viewing <span className="type-num">v{artifact.version}</span>
      <span aria-hidden="true"> · </span>
      <Link to={hrefs.current}>Go to current</Link>
      <span className="visually-hidden"> (v{artifact.current_version})</span>
    </p>
  );

const dataNotice: StageNode = (c) => <DataNotice gate={c.gate} />;

const editBar: StageNode = ({ editing, live, gate, refs, actions, compact }) =>
  editing &&
  live.mode && (
    <EditBar
      focusRef={refs.bar}
      phase={live.phase}
      mode={live.mode}
      version={live.status?.base_version || gate.artifact.version}
      connected={live.status?.connected ?? false}
      connecting={live.status === null}
      dirty={live.status?.dirty ?? false}
      flushed={live.status ? !live.status.unflushed : undefined}
      saving={live.saving}
      savedVersion={live.savedVersion}
      rebasedVersion={live.rebasedVersion}
      newerVersion={live.newerVersion}
      conflictVersion={live.status?.conflict_version ?? live.review?.current ?? null}
      publishable={live.status?.publishable ?? true}
      unpublishableReason={unpublishableReason(gate.artifact.type)}
      editors={live.status?.editors ?? []}
      onPublish={() => void live.publish()}
      onDone={actions.finishEditing}
      onReview={() => void live.openReview()}
      reviewing={live.reviewing}
      compact={compact}
    />
  );

const liveDraftNotice: StageNode = ({ editing, live, gate, actions }) =>
  live.available &&
  !editing && (
    <LiveDraftNotice
      draft={gate.live?.draft ?? null}
      status={live.status}
      restore={live.restore}
      onSaveRestore={() => {
        void live.saveRestore().then(actions.refocusAfterNotice);
      }}
      onDropRestore={() => {
        live.dropRestore();
        actions.refocusAfterNotice();
      }}
    />
  );

/**
 * The whole-draft review's Discard, confirmed with the ⋯ menu's Discard words and dialog, which
 * dims the page, the frame and its review included.
 */
const reviewDiscard: StageNode = ({ live }) => (
  <ConfirmDialog
    open={live.discardAsk !== null}
    onClose={() => live.answerDiscard(false)}
    onConfirm={() => live.answerDiscard(true)}
    title="Discard unpublished changes?"
    description={
      live.mode === "room"
        ? `The page goes back to v${live.discardAsk} for everyone editing it.`
        : `The page goes back to v${live.discardAsk}.`
    }
    confirmLabel="Discard changes"
    danger
  />
);

/** The strip of notices under the bar, top to bottom. One item per line. */
export const STRIP_ITEMS: readonly StageItem[] = [
  { id: "older-version", render: olderVersion },
  { id: "data-notice", render: dataNotice },
  { id: "edit-bar", render: editBar },
  { id: "live-draft", render: liveDraftNotice },
  { id: "review-discard", render: reviewDiscard },
];
