// One artifact on the dashboard, as a 36px list row (ArtifactRow) or a card with a thumbnail
// (ArtifactCard). Both share the access label, the owner cell and the actions menu.
import {
  ArrowSquareOutIcon,
  ChartLineUpIcon,
  ClockCounterClockwiseIcon,
  DotsThreeIcon,
  FolderSimpleIcon,
  GearIcon,
  LinkSimpleIcon,
  PencilSimpleIcon,
} from "@phosphor-icons/react";
import { APP_ROUTES, type ArtifactSummary, route, typeDef, type Visibility } from "@plinth/shared";
import { useState } from "react";
import { Link } from "../../lib/router.tsx";
import {
  Badge,
  Menu,
  type MenuEntry,
  ROLE_META,
  Skeleton,
  useToast,
  VISIBILITY_META,
} from "../ui/index.ts";
import { copyText } from "./clipboard.ts";
import { formatDateTime, formatRelativeShort, versionsText } from "./format.ts";

/** The Category section's heading id on the Settings page ("Move to category…" links to it). */
export const CATEGORY_SECTION_ID = "settings-category";

/**
 * The category a row shows: the owner's own on their artifacts, the person's own (issue #42) on an
 * artifact shared with them. The owner's category never reaches anyone else.
 */
export function shownCategory(a: ArtifactSummary): string | null {
  return a.role === "owner" ? a.category : (a.my_category ?? null);
}

export function artifactMenu(
  a: ArtifactSummary,
  onCopy: (url: string) => void,
  /** Files an artifact shared with you under your own category (the dashboard opens a dialog). */
  onFile?: (a: ArtifactSummary) => void,
): MenuEntry[] {
  const slug = { slug: a.slug };
  const items: MenuEntry[] = [
    { label: "Open", icon: ArrowSquareOutIcon, href: route(APP_ROUTES.artifact, slug) },
  ];
  if (a.role === "owner" || a.role === "editor") {
    items.push({ label: "Edit", icon: PencilSimpleIcon, href: route(APP_ROUTES.editor, slug) });
  }
  items.push({
    label: "History",
    icon: ClockCounterClockwiseIcon,
    href: route(APP_ROUTES.history, slug),
  });
  if (a.role === "owner") {
    items.push({ label: "Settings", icon: GearIcon, href: route(APP_ROUTES.settings, slug) });
    items.push({
      label: "Stats",
      icon: ChartLineUpIcon,
      href: route(APP_ROUTES.artifactStats, slug),
    });
    items.push({
      label: "Move to category…",
      icon: FolderSimpleIcon,
      href: `${route(APP_ROUTES.settings, slug)}#${CATEGORY_SECTION_ID}`,
    });
  } else if (onFile) {
    items.push({ label: "Move to category…", icon: FolderSimpleIcon, onSelect: () => onFile(a) });
  }
  items.push({ type: "separator" });
  items.push({ label: "Copy link", icon: LinkSimpleIcon, onSelect: () => onCopy(a.url) });
  return items;
}

/** Short access labels for the list ("Link" for unlisted); the description is the tooltip. */
export const ACCESS_LABEL: Record<Visibility, string> = {
  public: "Public",
  unlisted: "Link",
  password: "Password",
  allowlist: "Private",
};

function Access({ visibility }: { visibility: Visibility }) {
  const meta = VISIBILITY_META[visibility];
  const AccessIcon = meta.icon;
  return (
    <span className="pl-dash__access" title={meta.description}>
      <AccessIcon size={14} aria-hidden="true" />
      <span className="visually-hidden">Access: </span>
      {ACCESS_LABEL[visibility]}
    </span>
  );
}

function ownerName(a: ArtifactSummary): string {
  return a.owner.name || a.owner.email || "someone";
}

/** Two capitals from a name or email ("ana.martins@x" -> "AM"). */
export function initialsOf(text: string): string {
  const words = text
    .replace(/@.*$/, "")
    .split(/[\s._-]+/)
    .filter(Boolean);
  const letters =
    words.length > 1
      ? `${words[0]?.[0] ?? ""}${words[1]?.[0] ?? ""}`
      : (words[0] ?? "").slice(0, 2);
  return letters.toUpperCase() || "?";
}

function Owner({ artifact: a, you }: { artifact: ArtifactSummary; you?: string }) {
  if (a.role === "owner") {
    return (
      <span className="pl-dash__owner">
        <span className="pl-dash__avatar pl-dash__avatar--you" aria-hidden="true">
          {you || "Y"}
        </span>
        <span className="visually-hidden">Owner: </span>
        <span className="pl-dash__owner-name">You</span>
      </span>
    );
  }
  const name = ownerName(a);
  const full = a.owner.name && a.owner.email ? `${a.owner.name} (${a.owner.email})` : name;
  return (
    <span className="pl-dash__owner" title={full}>
      <span className="pl-dash__avatar" aria-hidden="true">
        {initialsOf(name)}
      </span>
      <span className="pl-dash__owner-name">
        <span className="visually-hidden">Shared by </span>
        {full}
      </span>
    </span>
  );
}

/**
 * The row's category: the owner's own, or the person's own on a shared artifact. A long name wraps
 * inside the badge (dashboard.css), never cut.
 */
function CategoryBadge({ name, own = false }: { name: string; own?: boolean }) {
  return (
    <Badge
      icon={FolderSimpleIcon}
      srPrefix={own ? "Your category:" : "Category:"}
      title={name}
      className="pl-dash__category"
    >
      <span className="pl-dash__category-name">{name}</span>
    </Badge>
  );
}

/**
 * The row's category as plain text (the owner's own, or the person's own on a shared artifact): on
 * a card's sub line, and on a phone row's second line, where a badge beside the title would crowd
 * it. A long name ends in an ellipsis; the full name is its tooltip and is read out whole.
 */
function CategoryText({
  name,
  className,
  own = false,
}: {
  name: string;
  className: string;
  own?: boolean;
}) {
  return (
    <span className={className} title={name}>
      <FolderSimpleIcon size={13} aria-hidden="true" />
      <span className="visually-hidden">{own ? "Your category: " : "Category: "}</span>
      <span className="pl-dash__category-text">{name}</span>
    </span>
  );
}

function Tags({
  artifact: a,
  withCategory = true,
}: {
  artifact: ArtifactSummary;
  /** The card shows the category on its sub line instead. */
  withCategory?: boolean;
}) {
  // The category (the owner's own, or the person's own on a shared artifact) and the type badge
  // ("Doc"); plain HTML pages have no type badge.
  const def = typeDef(a.type);
  const badge = def?.badge ?? null;
  const category = withCategory ? shownCategory(a) : null;
  if (!category && !badge && !a.taken_down && a.role === "owner") return null;
  return (
    <span className="pl-dash__tags">
      {category && <CategoryBadge name={category} own={a.role !== "owner"} />}
      {badge && <Badge title={def?.label}>{badge}</Badge>}
      {a.taken_down && <Badge tone="danger">Taken down</Badge>}
      {a.role !== "owner" && (
        <span className="pl-dash__role" title={ROLE_META[a.role].description}>
          <span className="visually-hidden">Your role: </span>
          {ROLE_META[a.role].label}
        </span>
      )}
    </span>
  );
}

function RowMenu({
  artifact: a,
  onFile,
}: {
  artifact: ArtifactSummary;
  onFile?: (a: ArtifactSummary) => void;
}) {
  const toast = useToast();
  const onCopy = async (url: string) => {
    if (await copyText(url)) toast.success("Link copied");
    else toast.error("Could not copy the link", url);
  };
  return (
    <Menu
      label={`Actions for ${a.title}`}
      icon={DotsThreeIcon}
      iconOnly
      size="sm"
      variant="ghost"
      align="end"
      className="pl-dash__menu"
      items={artifactMenu(a, onCopy, onFile)}
    />
  );
}

/**
 * The current version's screenshot, once it has loaded. It answers 404 until its capture lands, so
 * the caller keeps its placeholder until `show`, and for good if the image fails.
 */
function useThumbnail(url: string | null) {
  const [failed, setFailed] = useState<string | null>(null);
  const [loaded, setLoaded] = useState<string | null>(null);
  const src = url && failed !== url ? url : null;
  return {
    src,
    show: src !== null && loaded === src,
    onLoad: () => setLoaded(src),
    onError: () => setFailed(src),
  };
}

/** The small preview at the start of a row: the screenshot, or a page glyph until it loads. */
function RowThumb({ url }: { url: string | null }) {
  const t = useThumbnail(url);
  return (
    <span className="pl-dash__glyph" aria-hidden="true">
      {!t.show && (
        <>
          <i />
          <i />
          <i />
        </>
      )}
      {t.src && (
        <img
          src={t.src}
          alt=""
          loading="lazy"
          decoding="async"
          className="pl-dash__glyph-img"
          data-loaded={t.show ? "" : undefined}
          onLoad={t.onLoad}
          onError={t.onError}
        />
      )}
    </span>
  );
}

/** The page glyph alone, for skeleton rows. */
function PageGlyph() {
  return (
    <span className="pl-dash__glyph" aria-hidden="true">
      <i />
      <i />
      <i />
    </span>
  );
}

function Updated({ iso, now }: { iso: string; now: number }) {
  return (
    <span className="pl-dash__updated" title={formatDateTime(iso)}>
      <span className="visually-hidden">Updated </span>
      <time dateTime={iso}>{formatRelativeShort(iso, now)}</time>
    </span>
  );
}

/** Column names over the list. Decorative: each cell carries its own screen-reader label. */
export function ArtifactListHeader() {
  return (
    <div className="pl-dash__head" aria-hidden="true">
      <span />
      <span>Title</span>
      <span>Access</span>
      <span>Version</span>
      <span>Owner</span>
      <span className="pl-dash__head-end">Updated</span>
      <span />
    </div>
  );
}

export interface ArtifactRowProps {
  artifact: ArtifactSummary;
  now: number;
  /** The signed-in person's initials, for the owner cell of their own artifacts. */
  you?: string;
  /** Opens "Move to category…" for an artifact shared with the person. */
  onFile?: (a: ArtifactSummary) => void;
}

export function ArtifactRow({ artifact: a, now, you, onFile }: ArtifactRowProps) {
  const href = route(APP_ROUTES.artifact, { slug: a.slug });
  return (
    <li className="pl-dash__row" data-role={a.role}>
      <RowThumb url={a.thumbnail_url} />
      <span className="pl-dash__title">
        <Link to={href} className="pl-dash__link">
          {a.title}
        </Link>
        <Tags artifact={a} />
      </span>
      <Access visibility={a.visibility} />
      <span className="pl-dash__version" title={versionsText(a.version_count)}>
        <span className="visually-hidden">Version </span>v{a.current_version}
      </span>
      <Owner artifact={a} you={you} />
      {shownCategory(a) && (
        <CategoryText
          name={shownCategory(a) as string}
          className="pl-dash__row-category"
          own={a.role !== "owner"}
        />
      )}
      <Updated iso={a.updated_at} now={now} />
      <RowMenu artifact={a} onFile={onFile} />
    </li>
  );
}

/** Two letters for the placeholder thumbnail. */
function thumbLetters(title: string): string {
  const words = title.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w));
  const first = words[0]?.match(/[\p{L}\p{N}]/u)?.[0] ?? "";
  const second = words[1]?.match(/[\p{L}\p{N}]/u)?.[0] ?? "";
  return (first + second).toUpperCase();
}

export type ArtifactCardProps = ArtifactRowProps;

/**
 * A card's preview: the screenshot, or a quiet sheet with the title's initials until it loads. The
 * dashboard grid and the portal page (/p/:id) share it.
 */
export function CardThumb({ title, url }: { title: string; url: string | null }) {
  const t = useThumbnail(url);
  return (
    <div className="pl-dash__thumb">
      {t.src && (
        <img
          src={t.src}
          alt=""
          loading="lazy"
          decoding="async"
          className="pl-dash__thumb-img"
          data-loaded={t.show ? "" : undefined}
          onLoad={t.onLoad}
          onError={t.onError}
        />
      )}
      {!t.show && (
        <span className="pl-dash__paper" aria-hidden="true">
          <span className="pl-dash__paper-letters">{thumbLetters(title)}</span>
          <i />
          <i />
          <i />
        </span>
      )}
    </div>
  );
}

export function ArtifactCard({ artifact: a, now, you, onFile }: ArtifactCardProps) {
  const href = route(APP_ROUTES.artifact, { slug: a.slug });
  const AccessIcon = VISIBILITY_META[a.visibility].icon;
  return (
    <li className="pl-dash__card" data-role={a.role}>
      <CardThumb title={a.title} url={a.thumbnail_url} />
      <div className="pl-dash__card-meta">
        <span className="pl-dash__title">
          <Link to={href} className="pl-dash__link">
            {a.title}
          </Link>
          <Tags artifact={a} withCategory={false} />
        </span>
        <span className="pl-dash__card-sub">
          <span title={VISIBILITY_META[a.visibility].description} className="pl-dash__card-access">
            <AccessIcon size={13} aria-hidden="true" />
            <span className="visually-hidden">Access: {ACCESS_LABEL[a.visibility]}</span>
          </span>
          <span className="pl-dash__version" title={versionsText(a.version_count)}>
            <span className="visually-hidden">Version </span>v{a.current_version}
          </span>
          <span className="pl-dash__dot" aria-hidden="true">
            ·
          </span>
          <Owner artifact={a} you={you} />
          {shownCategory(a) && (
            <>
              <span className="pl-dash__dot" aria-hidden="true">
                ·
              </span>
              <CategoryText
                name={shownCategory(a) as string}
                className="pl-dash__card-category"
                own={a.role !== "owner"}
              />
            </>
          )}
          <Updated iso={a.updated_at} now={now} />
        </span>
      </div>
      <RowMenu artifact={a} onFile={onFile} />
    </li>
  );
}

export function ArtifactRowSkeleton() {
  return (
    <li className="pl-dash__row pl-dash__row--skeleton" aria-hidden="true">
      <PageGlyph />
      <Skeleton width="min(16rem, 70%)" height="0.75rem" />
      <Skeleton width="3.5rem" height="0.75rem" />
      <Skeleton width="1.5rem" height="0.75rem" />
      <Skeleton width="4rem" height="0.75rem" />
      <Skeleton width="2.5rem" height="0.75rem" />
      <span />
    </li>
  );
}

export function ArtifactCardSkeleton() {
  return (
    <li className="pl-dash__card pl-dash__card--skeleton" aria-hidden="true">
      <div className="pl-dash__thumb" />
      <div className="pl-dash__card-meta">
        <Skeleton width="70%" height="0.75rem" />
        <Skeleton width="45%" height="0.625rem" />
      </div>
    </li>
  );
}
