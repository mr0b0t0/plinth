// One artifact on the dashboard: title, badges, meta line and an actions menu.
import {
  ArrowSquareOutIcon,
  ClockCounterClockwiseIcon,
  DotsThreeIcon,
  GearIcon,
  LinkSimpleIcon,
  PencilSimpleIcon,
} from "@phosphor-icons/react";
import { APP_ROUTES, type ArtifactSummary, route } from "@plinth/shared";
import { Link } from "../../lib/router.tsx";
import {
  Badge,
  Menu,
  type MenuEntry,
  RoleBadge,
  Skeleton,
  useToast,
  VisibilityBadge,
} from "../ui/index.ts";
import { copyText } from "./clipboard.ts";
import { formatDateTime, formatRelative, versionsText } from "./format.ts";

export function artifactMenu(a: ArtifactSummary, onCopy: (url: string) => void): MenuEntry[] {
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
  }
  items.push({ type: "separator" });
  items.push({ label: "Copy link", icon: LinkSimpleIcon, onSelect: () => onCopy(a.url) });
  return items;
}

export function ArtifactRow({ artifact: a, now }: { artifact: ArtifactSummary; now: number }) {
  const toast = useToast();
  const href = route(APP_ROUTES.artifact, { slug: a.slug });
  const onCopy = async (url: string) => {
    if (await copyText(url)) toast.success("Link copied");
    else toast.error("Could not copy the link", url);
  };
  return (
    <li className="pl-acct-row">
      <div className="pl-acct-row__main">
        <h3 className="pl-acct-row__title">
          <Link to={href} className="pl-acct-row__link">
            {a.title}
          </Link>
        </h3>
        <p className="pl-acct-row__meta">
          <span className="type-mono" title={`Current version: ${a.current_version}`}>
            v{a.current_version}
          </span>
          <span aria-hidden="true">·</span>
          <span>{versionsText(a.version_count)}</span>
          <span aria-hidden="true">·</span>
          <span title={formatDateTime(a.updated_at)}>
            Updated <time dateTime={a.updated_at}>{formatRelative(a.updated_at, now)}</time>
          </span>
          {a.role !== "owner" && (
            <>
              <span aria-hidden="true">·</span>
              <span className="pl-acct-row__owner">
                Shared by {a.owner.name ? `${a.owner.name} (${a.owner.email})` : a.owner.email}
              </span>
            </>
          )}
        </p>
      </div>
      <div className="pl-acct-row__side">
        <div className="pl-acct-row__badges">
          {a.taken_down && <Badge tone="danger">Taken down</Badge>}
          <VisibilityBadge visibility={a.visibility} />
          {a.role !== "owner" && <RoleBadge value={a.role} />}
        </div>
        <Menu
          label={`Actions for ${a.title}`}
          icon={DotsThreeIcon}
          iconOnly
          variant="ghost"
          align="end"
          items={artifactMenu(a, onCopy)}
        />
      </div>
    </li>
  );
}

export function ArtifactRowSkeleton() {
  return (
    <li className="pl-acct-row" aria-hidden="true">
      <div className="pl-acct-row__main">
        <Skeleton width="min(22rem, 70%)" height="1.5rem" />
        <Skeleton width="min(16rem, 50%)" height="0.875rem" />
      </div>
      <div className="pl-acct-row__side">
        <Skeleton width="5rem" height="1.5rem" />
      </div>
    </li>
  );
}
