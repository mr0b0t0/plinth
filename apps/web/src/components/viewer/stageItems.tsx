// The viewer's chrome as item lists: the ⋯ menu (MENU_ITEMS), the controls on the right of the bar
// (BAR_CONTROLS) and the strip of notices under the bar (STRIP_ITEMS). ViewerStage owns the state
// and builds one StageContext; each item reads it and returns its entries or element, or nothing.
//
// A feature adds its own item function (in its own file) and one line in the list where it
// belongs. Items for one artifact type go in TYPE_MENU_ITEMS, items for one declared capability in
// CAPABILITY_MENU_ITEMS. Order in a list is the order on screen. Layout and behaviour of the stage
// itself (the frame, the hold rule) stay in ViewerStage.

import {
  ArrowsOutIcon,
  ChartLineUpIcon,
  ChatCircleIcon,
  ClockCounterClockwiseIcon,
  CodeIcon,
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
import { Button, buttonClassName, Menu, type MenuEntry, Tooltip } from "../ui/index.ts";
import { DataNotice } from "./DataNotice.tsx";
import { EditBar } from "./EditBar.tsx";
import { LiveDraftNotice } from "./LiveDraftNotice.tsx";
import {
  postBoardExport,
  postExport,
  postPrint,
  rendererTargetOrigin,
} from "./rendererProtocol.ts";
import type { LiveEdit } from "./useLiveEdit.ts";
import type { Presentation } from "./usePresentation.ts";
import type { ViewUpdate } from "./useViewUpdate.ts";

type OkGate = Extract<ViewGate, { status: "ok" }>;

/** Who may open the editor. The editor page and the API check again. */
export const canEdit = (role: OkGate["role"]) => role === "owner" || role === "editor";

/** Everything an item may read or do. Built by ViewerStage on each render. */
export interface StageContext {
  gate: OkGate;
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

// ---------- the ⋯ menu ----------

const compactShareHistory: MenuItem = (c) =>
  c.compact
    ? [
        { label: "Share", icon: ShareNetworkIcon, onSelect: c.actions.openShare },
        { label: "History", icon: ClockCounterClockwiseIcon, href: c.hrefs.history },
      ]
    : [];

const compactEditToggle: MenuItem = (c) =>
  c.compact && c.live.available && !c.live.signIn
    ? [
        {
          label: c.editing ? "Done editing" : "Edit on the page",
          icon: PencilSimpleIcon,
          onSelect: c.actions.toggleEditing,
        },
      ]
    : [];

const compactSignInToEdit: MenuItem = (c) =>
  c.compact && c.live.available && c.live.signIn
    ? [{ label: "Sign in to edit", icon: PencilSimpleIcon, href: c.hrefs.signIn }]
    : [];

/** A type with no source editor (a sheet or a design) has no Edit: agents change it. */
const editSource: MenuItem = (c) =>
  canEdit(c.gate.role) && typeDef(c.gate.artifact.type)?.editor
    ? [
        {
          label: c.live.available ? "Edit source" : "Edit",
          icon: c.live.available ? CodeIcon : PencilSimpleIcon,
          href: c.hrefs.edit,
        },
      ]
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
  slides: [printTyped, downloadPptx],
  design: [printTyped],
  sheet: [printTyped, downloadSheet],
  whiteboard: [downloadBoard],
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
  settings,
  stats,
  typeItems,
  capabilityItems,
  report,
  separator,
  switchTheme,
];

/** The ⋯ menu's entries for this context. */
export function menuEntries(c: StageContext): MenuEntry[] {
  return MENU_ITEMS.flatMap((item) => item(c));
}

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
    <Tooltip content={c.editing ? "Done editing" : "Edit on the page"} placement="bottom">
      <Button
        ref={c.refs.edit}
        variant="ghost"
        icon={PencilSimpleIcon}
        aria-label="Edit"
        aria-pressed={c.editing}
        className="pl-viewer__edit"
        onClick={c.actions.toggleEditing}
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

/** Present a deck: the one bar control for full screen and presenter view (presentEntries). */
const presentButton: StageNode = (c) =>
  c.present.available && (
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

/** A newer version waits while the viewer uses the page (the hold rule, docs/spec.md "Live views"). */
const heldUpdate: StageNode = ({ update }) =>
  update.held !== null && (
    <p className="pl-viewer__notice pl-viewer__notice--update" aria-live="polite">
      <span className="type-num">v{update.held}</span> is available
      <span aria-hidden="true"> · </span>
      <button
        type="button"
        className="pl-viewer__notice-action"
        onClick={update.update}
        disabled={update.updating}
      >
        Update
      </button>
    </p>
  );

const dataNotice: StageNode = (c) => <DataNotice gate={c.gate} />;

const editBar: StageNode = ({ editing, live, gate, refs, actions }) =>
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
      saving={live.saving}
      savedVersion={live.savedVersion}
      rebasedVersion={live.rebasedVersion}
      newerVersion={live.newerVersion}
      editors={live.status?.editors ?? []}
      onSave={(note) => void live.save(note)}
      onDiscard={() => void live.discard()}
      onDone={actions.finishEditing}
      onReview={() => void live.review()}
    />
  );

const liveDraftNotice: StageNode = ({ editing, live, gate, actions }) =>
  live.available &&
  !editing && (
    <LiveDraftNotice
      draft={gate.live?.draft ?? null}
      status={live.status}
      restore={live.restore}
      signIn={live.signIn}
      unavailable={
        live.roomReady
          ? null
          : live.mode === "room" && live.status === null
            ? "Connecting to the live draft…"
            : "Live editing is unavailable right now."
      }
      onSave={() => {
        void live.save().then(actions.refocusAfterNotice);
      }}
      onContinue={actions.startEditing}
      onDiscard={() => {
        void live.discard().then(actions.refocusAfterNotice);
      }}
      onReview={() => void live.review()}
      onSaveRestore={() => void live.saveRestore()}
      onDropRestore={live.dropRestore}
    />
  );

/** The strip of notices under the bar, top to bottom. One item per line. */
export const STRIP_ITEMS: readonly StageItem[] = [
  { id: "older-version", render: olderVersion },
  { id: "held-update", render: heldUpdate },
  { id: "data-notice", render: dataNotice },
  { id: "edit-bar", render: editBar },
  { id: "live-draft", render: liveDraftNotice },
];
