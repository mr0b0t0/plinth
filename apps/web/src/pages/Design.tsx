// Page: /design. Every token and component, in both modes. Reference for the people and agents
// building the other screens; also the place to check contrast after changing a color.
import {
  ArrowSquareOutIcon,
  ChatCircleIcon,
  ClockCounterClockwiseIcon,
  CopyIcon,
  DotsThreeIcon,
  DownloadSimpleIcon,
  EyeIcon,
  FloppyDiskIcon,
  GearIcon,
  LinkSimpleIcon,
  MagnifyingGlassIcon,
  PencilSimpleIcon,
  PlugIcon,
  PlusIcon,
  ShareNetworkIcon,
  TrashIcon,
} from "@phosphor-icons/react";
import { API, APP_ROUTES, VISIBILITIES } from "@plinth/shared";
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import { LogoMark } from "../components/Logo.tsx";
import { AppShell } from "../components/layout/AppShell.tsx";
import {
  Badge,
  Button,
  ButtonLink,
  Card,
  Checkbox,
  ConfirmDialog,
  Dialog,
  EmptyState,
  Exhibit,
  ICON_SIZE,
  type Icon,
  IconButton,
  Input,
  Menu,
  PageHeader,
  RoleBadge,
  Row,
  Select,
  Skeleton,
  SkeletonText,
  Spinner,
  Stack,
  Switch,
  Tabs,
  Textarea,
  ThemeSwitch,
  Tooltip,
  useToast,
  VisibilityBadge,
} from "../components/ui/index.ts";
import { api } from "../lib/api.ts";
import {
  CONTRAST_PAIRS,
  contrastRatio,
  formatRatio,
  MIN_RATIO,
  parseColor,
} from "../styles/contrast.ts";
import "../styles/design-page.css";
import { THEME_NAMES, type Theme, useTheme } from "../lib/theme.ts";

const MODES: Theme[] = ["light", "dark"];

/** Ends the session, then reloads on the sign-in page so every cached state is dropped. */
function signOut() {
  api(API.logout, { method: "POST" })
    .catch(() => undefined)
    .finally(() => window.location.assign(APP_ROUTES.login));
}

interface TokenRow {
  name: string;
  use: string;
}

const COLOR_GROUPS: { title: string; note: string; tokens: TokenRow[] }[] = [
  {
    title: "Walls and surfaces",
    note: "The room. Pages sit on the wall; cards, menus and dialogs are raised; wells are sunk.",
    tokens: [
      { name: "--color-wall", use: "Page background" },
      { name: "--color-surface", use: "Panels, read-only fields" },
      { name: "--color-surface-raised", use: "Cards, inputs, menus, dialogs" },
      { name: "--color-surface-sunk", use: "Wells, code, ghost hover, neutral badges" },
      { name: "--color-plinth", use: "The base an exhibit stands on" },
    ],
  },
  {
    title: "Ink",
    note: "Text. Muted for secondary text, faint for placeholders and meta only.",
    tokens: [
      { name: "--color-ink", use: "Body text, headings" },
      { name: "--color-ink-muted", use: "Secondary text, inactive nav" },
      { name: "--color-ink-faint", use: "Placeholders, tertiary meta" },
      { name: "--color-ink-inverse", use: "Text on ink (tooltips)" },
    ],
  },
  {
    title: "Verdigris, the one accent",
    note: "Primary actions, focus rings, the active state. Nothing decorative.",
    tokens: [
      { name: "--color-accent", use: "Primary buttons, active marks, checked controls" },
      { name: "--color-accent-hover", use: "Primary hover" },
      { name: "--color-accent-active", use: "Primary pressed" },
      { name: "--color-accent-soft", use: "Selected rows, text selection" },
      { name: "--color-accent-ink", use: "Links and accent text" },
      { name: "--color-on-accent", use: "Text on the accent" },
    ],
  },
  {
    title: "Status",
    note: "Only for outcomes and risk. Always paired with an icon or words.",
    tokens: [
      { name: "--color-success", use: "Success text and icons" },
      { name: "--color-success-soft", use: "Success background" },
      { name: "--color-warning", use: "Warning text and icons" },
      { name: "--color-warning-soft", use: "Warning background" },
      { name: "--color-danger", use: "Errors, destructive actions" },
      { name: "--color-danger-hover", use: "Danger button hover" },
      { name: "--color-danger-soft", use: "Error background" },
      { name: "--color-on-danger", use: "Text on danger" },
    ],
  },
  {
    title: "Lines and focus",
    note: "Borders that only separate can be quiet; borders that identify a control meet 3:1.",
    tokens: [
      { name: "--color-border", use: "Separators, card outlines" },
      { name: "--color-border-strong", use: "Button outlines, plinth edge" },
      { name: "--color-border-control", use: "Input, checkbox and switch outlines" },
      { name: "--color-focus", use: "Focus ring" },
      { name: "--color-overlay", use: "Dialog backdrop" },
    ],
  },
];

const ALL_COLOR_TOKENS = [
  ...new Set([
    ...COLOR_GROUPS.flatMap((g) => g.tokens.map((t) => t.name)),
    ...CONTRAST_PAIRS.flatMap((p) => [p.fg, p.bg]),
  ]),
];

const TYPE_SCALE = [
  ["--text-5xl", 64, "display"],
  ["--text-4xl", 48, "display"],
  ["--text-3xl", 36, "display"],
  ["--text-2xl", 28, "display"],
  ["--text-xl", 21, "display"],
  ["--text-lg", 17, "ui"],
  ["--text-md", 15, "ui"],
  ["--text-sm", 13, "ui"],
  ["--text-xs", 12, "ui"],
  ["--text-2xs", 11, "ui"],
] as const;

const TYPE_ROLES = [
  ["type-display", "Display", "Hero and full-page empty states"],
  ["type-title", "Title", "The page's h1 (PageHeader)"],
  ["type-heading", "Heading", "Section headings"],
  ["type-subhead", "Subhead", "Headings inside cards and panels"],
  ["type-lead", "Lead", "The paragraph under a title"],
  ["type-body", "Body", "Default text"],
  ["type-small", "Small", "Secondary text"],
  ["type-caption", "Caption", "Meta lines under items"],
  ["type-mono", "Mono", "v12, a1b2c3d4, plt_live_8f2e"],
] as const;

const SPACES = [1, 2, 3, 4, 5, 6, 8, 10, 12, 16, 24] as const;
const RADII = ["xs", "sm", "md", "lg", "full"] as const;
const SHADOWS = ["sm", "md", "lg"] as const;

const ICONS: [Icon, string][] = [
  [PlusIcon, "Plus"],
  [MagnifyingGlassIcon, "MagnifyingGlass"],
  [ShareNetworkIcon, "ShareNetwork"],
  [LinkSimpleIcon, "LinkSimple"],
  [CopyIcon, "Copy"],
  [PencilSimpleIcon, "PencilSimple"],
  [ChatCircleIcon, "ChatCircle"],
  [ClockCounterClockwiseIcon, "ClockCounterClockwise"],
  [EyeIcon, "Eye"],
  [PlugIcon, "Plug"],
  [GearIcon, "Gear"],
  [DownloadSimpleIcon, "DownloadSimple"],
  [ArrowSquareOutIcon, "ArrowSquareOut"],
  [TrashIcon, "Trash"],
];

const SECTIONS = [
  ["color", "Color"],
  ["contrast", "Contrast"],
  ["modes", "Both modes"],
  ["type", "Type"],
  ["space", "Spacing"],
  ["shape", "Radii and elevation"],
  ["icons", "Icons and logo"],
  ["motion", "Motion"],
  ["components", "Components"],
] as const;

/** Read custom properties as computed on an element (re-read when the theme changes). */
function useComputedTokens(names: string[], theme: Theme) {
  const ref = useRef<HTMLDivElement>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-read when the theme flips
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const cs = getComputedStyle(el);
    const out: Record<string, string> = {};
    for (const n of names) out[n] = cs.getPropertyValue(n).trim();
    setValues(out);
  }, [theme]);
  return [ref, values] as const;
}

function ratioFor(values: Record<string, string>, fg: string, bg: string): number | null {
  const a = parseColor(values[fg] ?? "");
  const b = parseColor(values[bg] ?? "");
  return a && b ? contrastRatio(a, b) : null;
}

function Section({
  id,
  title,
  intro,
  children,
}: {
  id: string;
  title: string;
  intro?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className="ds-section">
      <h2 id={`${id}-title`} className="ds-section__title">
        {title}
      </h2>
      {intro && <p className="ds-section__intro">{intro}</p>}
      {children}
    </section>
  );
}

function Specimen({
  title,
  note,
  children,
}: {
  title: string;
  note?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="ds-specimen">
      <div className="ds-specimen__head">
        <h3 className="ds-specimen__title">{title}</h3>
        {note && <p className="ds-specimen__note">{note}</p>}
      </div>
      <div className="ds-specimen__stage">{children}</div>
    </div>
  );
}

function Thumb({ kind }: { kind: "doc" | "chart" | "slides" }) {
  return (
    <div className={`ds-thumb ds-thumb--${kind}`} aria-hidden="true">
      <span />
      <span />
      <span />
      <span />
    </div>
  );
}

export default function Design() {
  const [theme] = useTheme();
  const [lightRef, light] = useComputedTokens(ALL_COLOR_TOKENS, theme);
  const [darkRef, dark] = useComputedTokens(ALL_COLOR_TOKENS, theme);
  const byMode: Record<Theme, Record<string, string>> = { light, dark };

  useEffect(() => {
    document.title = "Design system · Plinth";
  }, []);

  return (
    <AppShell onSignOut={signOut}>
      {/* Probes: each reads the tokens for one mode, whatever the page mode is. */}
      <div ref={lightRef} data-theme="light" hidden />
      <div ref={darkRef} data-theme="dark" hidden />

      <PageHeader
        title="Design system"
        description="The tokens and components Plinth is built from. Every color, size and duration comes from tokens.css; every screen uses these components."
        actions={<ThemeSwitch />}
      />

      <div className="ds-layout">
        <nav aria-label="On this page" className="ds-toc">
          <ul>
            {SECTIONS.map(([id, label]) => (
              <li key={id}>
                <a href={`#${id}`}>{label}</a>
              </li>
            ))}
          </ul>
        </nav>

        <div className="ds-content">
          <Section
            id="color"
            title="Color"
            intro="Two modes share one set of names. Gallery is the light room: cool off-white walls, stone greys, near-black ink. After hours is the same room with the lights down."
          >
            {COLOR_GROUPS.map((group) => (
              <div key={group.title} className="ds-color-group">
                <h3 className="ds-color-group__title">{group.title}</h3>
                <p className="ds-color-group__note">{group.note}</p>
                <table className="ds-table ds-swatches">
                  <thead>
                    <tr>
                      <th scope="col">Token</th>
                      {MODES.map((m) => (
                        <th scope="col" key={m}>
                          {THEME_NAMES[m]}
                        </th>
                      ))}
                      <th scope="col" className="ds-hide-sm">
                        Use
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {group.tokens.map((t) => (
                      <tr key={t.name}>
                        <th scope="row">
                          <code className="ds-token">{t.name}</code>
                          <span className="ds-show-sm ds-use">{t.use}</span>
                        </th>
                        {MODES.map((m) => (
                          <td key={m}>
                            <span className="ds-swatch">
                              <span
                                className="ds-swatch__chip"
                                data-theme={m}
                                style={{ background: `var(${t.name})` }}
                              />
                              <code className="ds-swatch__value">{byMode[m][t.name] ?? ""}</code>
                            </span>
                          </td>
                        ))}
                        <td className="ds-hide-sm ds-use">{t.use}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))}
          </Section>

          <Section
            id="contrast"
            title="Contrast"
            intro="Every text pair the components use meets WCAG AA (4.5:1) in both modes; focus rings, control outlines and active marks meet 3:1. Ratios are computed live from the tokens; contrast.test.ts asserts the same list."
          >
            {/* biome-ignore lint/a11y/noNoninteractiveTabindex: a scrolling region must be reachable by keyboard */}
            <section className="ds-table-wrap" aria-label="Contrast ratios" tabIndex={0}>
              <table className="ds-table ds-contrast">
                <thead>
                  <tr>
                    <th scope="col">Foreground on background</th>
                    {MODES.map((m) => (
                      <th scope="col" key={m}>
                        {THEME_NAMES[m]}
                      </th>
                    ))}
                    <th scope="col">Needs</th>
                  </tr>
                </thead>
                <tbody>
                  {CONTRAST_PAIRS.map((p) => (
                    <tr key={`${p.fg}|${p.bg}|${p.kind}`}>
                      <th scope="row">
                        <code className="ds-token">{p.fg.replace("--color-", "")}</code>
                        <span className="ds-on"> on </span>
                        <code className="ds-token">{p.bg.replace("--color-", "")}</code>
                      </th>
                      {MODES.map((m) => {
                        const r = ratioFor(byMode[m], p.fg, p.bg);
                        const ok = r !== null && r >= MIN_RATIO[p.kind];
                        return (
                          <td key={m}>
                            <span className="ds-ratio">
                              <span
                                className="ds-ratio__sample"
                                data-theme={m}
                                style={
                                  p.kind === "text"
                                    ? { background: `var(${p.bg})`, color: `var(${p.fg})` }
                                    : {
                                        background: `var(${p.bg})`,
                                        boxShadow: `inset 0 0 0 2px var(${p.fg})`,
                                      }
                                }
                                aria-hidden="true"
                              >
                                {p.kind === "text" ? "Aa" : ""}
                              </span>
                              <span
                                className={
                                  ok ? "ds-ratio__value" : "ds-ratio__value ds-ratio__value--fail"
                                }
                              >
                                {r === null ? "–" : `${formatRatio(r)}:1`}
                                {!ok && r !== null && (
                                  <span className="visually-hidden"> (below minimum)</span>
                                )}
                              </span>
                            </span>
                          </td>
                        );
                      })}
                      <td className="ds-needs">
                        {MIN_RATIO[p.kind]}:1{" "}
                        <span className="ds-use">{p.kind === "text" ? "text" : "UI"}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          </Section>

          <Section
            id="modes"
            title="Both modes"
            intro="The same components, side by side. Any element with data-theme renders its subtree in that mode."
          >
            <div className="ds-modes">
              {MODES.map((m) => (
                <div key={m} data-theme={m} className="ds-mode">
                  <p className="ds-mode__name">{THEME_NAMES[m]}</p>
                  <div className="ds-mode__chips" aria-hidden="true">
                    {[
                      "--color-wall",
                      "--color-surface-raised",
                      "--color-plinth",
                      "--color-ink",
                      "--color-ink-muted",
                      "--color-accent",
                      "--color-success",
                      "--color-warning",
                      "--color-danger",
                    ].map((t) => (
                      <span key={t} className="ds-mode__chip" style={{ background: `var(${t})` }} />
                    ))}
                  </div>
                  <Exhibit
                    aspect="16 / 9"
                    label={
                      <>
                        <span className="ds-exhibit-title">Field notes, spring survey</span>
                        <Row gap={2}>
                          <span className="type-caption">
                            <span className="type-mono">v7</span>, edited today
                          </span>
                          <VisibilityBadge visibility="password" />
                        </Row>
                      </>
                    }
                  >
                    <Thumb kind="doc" />
                  </Exhibit>
                  <Row gap={2}>
                    <Button variant="primary" size="sm" icon={ShareNetworkIcon}>
                      Share
                    </Button>
                    <Button size="sm">Edit</Button>
                    <Button variant="ghost" size="sm">
                      History
                    </Button>
                    <Button variant="danger" size="sm">
                      Delete
                    </Button>
                  </Row>
                  <Row gap={2}>
                    <Badge tone="accent">Current</Badge>
                    <Badge tone="success">Published</Badge>
                    <Badge tone="warning">Pending</Badge>
                    <Badge tone="danger">Failed</Badge>
                  </Row>
                  <Input
                    label="Connection name"
                    defaultValue="Work laptop"
                    hint="Shown in version history."
                    id={`mode-${m}-input`}
                  />
                  <Switch label="Allow comments" defaultChecked id={`mode-${m}-switch`} />
                </div>
              ))}
            </div>
          </Section>

          <Section
            id="type"
            title="Type"
            intro="Three open-licensed families, self-hosted. The serif is the gallery's voice; the sans does the work; the mono marks things a machine wrote."
          >
            <div className="ds-families">
              <div className="ds-family">
                <p className="ds-family__sample ds-family__sample--display">
                  Field notes, spring survey
                </p>
                <p className="ds-family__meta">
                  <strong>Instrument Serif</strong> 400. Display headings and artifact titles.{" "}
                  <code>--font-display</code>
                </p>
              </div>
              <div className="ds-family">
                <p className="ds-family__sample ds-family__sample--ui">
                  Share with specific people
                </p>
                <p className="ds-family__meta">
                  <strong>Geist</strong> variable, 400 to 600. Interface text.{" "}
                  <code>--font-ui</code>
                </p>
              </div>
              <div className="ds-family">
                <p className="ds-family__sample ds-family__sample--mono">v12 a1b2c3d4 plt_8f2e</p>
                <p className="ds-family__meta">
                  <strong>JetBrains Mono</strong> variable. Code, versions, tokens, ids.{" "}
                  <code>--font-mono</code>
                </p>
              </div>
            </div>

            <h3 className="ds-sub">Scale</h3>
            <ul className="ds-scale">
              {TYPE_SCALE.map(([token, px, face]) => (
                <li key={token} className="ds-scale__row">
                  <code className="ds-token">{token}</code>
                  <span className="ds-scale__px">{px}px</span>
                  <span
                    className={`ds-scale__sample ds-scale__sample--${face}`}
                    style={{ fontSize: `var(${token})` }}
                  >
                    {face === "display" ? "A quiet room for work" : "Publish, share, revise"}
                  </span>
                </li>
              ))}
            </ul>

            <h3 className="ds-sub">Roles</h3>
            <ul className="ds-roles">
              {TYPE_ROLES.map(([cls, name, use]) => (
                <li key={cls} className="ds-roles__row">
                  <div className="ds-roles__meta">
                    <code className="ds-token">.{cls}</code>
                    <span className="ds-use">{use}</span>
                  </div>
                  <p className={cls}>
                    {name === "Mono"
                      ? use
                      : name === "Display" || name === "Title"
                        ? "Field notes"
                        : `${name}: the artifact is the exhibit; the chrome recedes.`}
                  </p>
                </li>
              ))}
            </ul>
          </Section>

          <Section
            id="space"
            title="Spacing"
            intro="A 4px grid. Prefer the larger steps between groups; whitespace does the grouping before borders do."
          >
            <ul className="ds-spaces">
              {SPACES.map((n) => (
                <li key={n} className="ds-spaces__row">
                  <code className="ds-token">--space-{n}</code>
                  <span className="ds-spaces__px">{n * 4}px</span>
                  <span className="ds-spaces__bar" style={{ width: `var(--space-${n})` }} />
                </li>
              ))}
            </ul>
          </Section>

          <Section
            id="shape"
            title="Radii and elevation"
            intro="Controls are slightly rounded; exhibits keep crisp corners. Shadows are soft and rare: menus, dialogs and toasts float, cards barely lift."
          >
            <div className="ds-shapes">
              {RADII.map((r) => (
                <div key={r} className="ds-shape">
                  <span className="ds-shape__box" style={{ borderRadius: `var(--radius-${r})` }} />
                  <code className="ds-token">--radius-{r}</code>
                </div>
              ))}
            </div>
            <div className="ds-shapes">
              {SHADOWS.map((s) => (
                <div key={s} className="ds-shape">
                  <span
                    className="ds-shape__box ds-shape__box--raised"
                    style={{ boxShadow: `var(--shadow-${s})` }}
                  />
                  <code className="ds-token">--shadow-{s}</code>
                </div>
              ))}
            </div>
          </Section>

          <Section
            id="icons"
            title="Icons and logo"
            intro="Phosphor, regular weight only, on a 4px grid: 16 in small controls and badges, 20 in buttons and menus, 24 for emphasis, 32 for empty states."
          >
            <div className="ds-icon-sizes">
              {(Object.keys(ICON_SIZE) as (keyof typeof ICON_SIZE)[]).map((k) => (
                <div key={k} className="ds-icon-size">
                  <PlugIcon size={ICON_SIZE[k]} aria-hidden="true" />
                  <code className="ds-token">--icon-{k}</code>
                  <span className="ds-use">{ICON_SIZE[k]}px</span>
                </div>
              ))}
            </div>
            <ul className="ds-icons">
              {ICONS.map(([I, name]) => (
                <li key={name}>
                  <I size={ICON_SIZE.md} aria-hidden="true" />
                  <span>{name}</span>
                </li>
              ))}
            </ul>
            <div className="ds-logos">
              {MODES.map((m) => (
                <div key={m} data-theme={m} className="ds-logo-tile">
                  <LogoMark size={64} />
                  <span className="ds-logo-tile__word">Plinth</span>
                </div>
              ))}
              <p className="ds-use ds-logos__note">
                The mark: a small block on a wider base. The block is the work, in verdigris; the
                base is the plinth, in ink. Keep clear space of one block width around it.
              </p>
            </div>
          </Section>

          <MotionSection />

          <Section
            id="components"
            title="Components"
            intro="Token-driven and keyboard accessible. Import them from components/ui; usage notes live in its README."
          >
            <ComponentSpecimens />
          </Section>
        </div>
      </div>
    </AppShell>
  );
}

function MotionSection() {
  const [on, setOn] = useState(false);
  return (
    <Section
      id="motion"
      title="Motion"
      intro="Short and subtle, and only in answer to something the person did. With reduced motion set, durations drop to zero."
    >
      <table className="ds-table ds-motion-table">
        <thead>
          <tr>
            <th scope="col">Token</th>
            <th scope="col">Value</th>
            <th scope="col">Use</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <th scope="row">
              <code className="ds-token">--duration-fast</code>
            </th>
            <td>120ms</td>
            <td className="ds-use">Hover, press, menus, tooltips</td>
          </tr>
          <tr>
            <th scope="row">
              <code className="ds-token">--duration-normal</code>
            </th>
            <td>180ms</td>
            <td className="ds-use">Switches, theme changes</td>
          </tr>
          <tr>
            <th scope="row">
              <code className="ds-token">--duration-slow</code>
            </th>
            <td>260ms</td>
            <td className="ds-use">Dialogs and toasts entering</td>
          </tr>
          <tr>
            <th scope="row">
              <code className="ds-token">--ease-out</code>
            </th>
            <td>
              <code>cubic-bezier(0.2, 0.7, 0.2, 1)</code>
            </td>
            <td className="ds-use">Things arriving</td>
          </tr>
          <tr>
            <th scope="row">
              <code className="ds-token">--ease-in-out</code>
            </th>
            <td>
              <code>cubic-bezier(0.45, 0, 0.25, 1)</code>
            </td>
            <td className="ds-use">Things moving in place</td>
          </tr>
        </tbody>
      </table>
      <div className="ds-motion-demo">
        <Button size="sm" onClick={() => setOn((v) => !v)} aria-pressed={on}>
          {on ? "Lower the block" : "Raise the block"}
        </Button>
        <div className="ds-motion-stage" aria-hidden="true">
          <span className="ds-motion-block" data-on={on || undefined} />
          <span className="ds-motion-base" />
        </div>
      </div>
    </Section>
  );
}

function ComponentSpecimens() {
  const toast = useToast();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [checked, setChecked] = useState(true);
  const [loadingDemo, setLoadingDemo] = useState(false);

  return (
    <Stack gap={10}>
      <Specimen
        title="Button"
        note="Primary once per view. Secondary for the rest; ghost in toolbars; danger only for what cannot be undone. Icon-only buttons need a label and a tooltip."
      >
        <Stack gap={4}>
          <Row gap={2}>
            <Button variant="primary">Publish</Button>
            <Button>Edit</Button>
            <Button variant="ghost">Cancel</Button>
            <Button variant="danger">Delete artifact</Button>
          </Row>
          <Row gap={2}>
            <Button variant="primary" size="sm" icon={PlusIcon}>
              New token
            </Button>
            <Button size="md" icon={ShareNetworkIcon}>
              Share
            </Button>
            <Button size="lg" variant="primary">
              Sign in
            </Button>
            <Button disabled>Disabled</Button>
          </Row>
          <Row gap={2}>
            <Button
              variant="primary"
              loading={loadingDemo}
              icon={FloppyDiskIcon}
              onClick={() => {
                setLoadingDemo(true);
                window.setTimeout(() => setLoadingDemo(false), 1600);
              }}
            >
              Save version
            </Button>
            <Tooltip content="Copy link">
              <IconButton icon={CopyIcon} label="Copy link" />
            </Tooltip>
            <Tooltip content="Comments">
              <IconButton icon={ChatCircleIcon} label="Comments" variant="secondary" />
            </Tooltip>
            <Tooltip content="More actions">
              <IconButton icon={DotsThreeIcon} label="More actions" size="sm" />
            </Tooltip>
            <ButtonLink to={APP_ROUTES.dashboard} variant="secondary" icon={ArrowSquareOutIcon}>
              Link as button
            </ButtonLink>
          </Row>
        </Stack>
      </Specimen>

      <Specimen
        title="Input, textarea, select"
        note="Every field has a visible label. Hints say what the field is for; errors say what to change."
      >
        <div className="ds-grid-2">
          <Input
            label="Email"
            type="email"
            placeholder="you@example.com"
            hint="We send a sign-in link here."
            autoComplete="email"
          />
          <Input
            label="Password"
            type="password"
            defaultValue="hunter2"
            error="Use at least 8 characters."
          />
          <Input
            label="Personal access token"
            mono
            readOnly
            defaultValue="plt_8f2e4c19a0b7d3e5"
            hint="Shown once. Copy it now."
          />
          <Select
            label="Visibility"
            defaultValue="unlisted"
            options={VISIBILITIES.map((v) => ({
              value: v,
              label: v === "allowlist" ? "Specific people" : v[0]?.toUpperCase() + v.slice(1),
            }))}
          />
          <Textarea
            label="Version note"
            placeholder="What changed in this version?"
            hint="Optional. Shown in history."
          />
          <Input label="Search artifacts" hideLabel placeholder="Search artifacts" type="search" />
        </div>
      </Specimen>

      <Specimen
        title="Checkbox and switch"
        note="A checkbox is part of a form that is saved later; a switch applies at once."
      >
        <Stack gap={3}>
          <Checkbox
            label="Include assets"
            checked={checked}
            onChange={(e) => setChecked(e.target.checked)}
          />
          <Checkbox label="Select all" indeterminate hint="3 of 7 selected" />
          <Checkbox label="Disabled option" disabled />
          <Switch label="Notify me about mentions" defaultChecked />
          <Switch label="Allow comments" hint="Commenters and editors can leave comments." />
        </Stack>
      </Specimen>

      <Specimen
        title="Dialog"
        note="Focus moves in and stays in; Escape closes; focus returns to the button that opened it. Destructive confirmations start on Cancel."
      >
        <Row gap={2}>
          <Button onClick={() => setDialogOpen(true)}>Rename artifact</Button>
          <Button variant="danger" onClick={() => setConfirmOpen(true)}>
            Revoke connection
          </Button>
        </Row>
        <Dialog
          open={dialogOpen}
          onClose={() => setDialogOpen(false)}
          title="Rename artifact"
          description="The link stays the same."
          footer={
            <>
              <Button variant="ghost" onClick={() => setDialogOpen(false)}>
                Cancel
              </Button>
              <Button
                variant="primary"
                loading={saving}
                onClick={() => {
                  setSaving(true);
                  window.setTimeout(() => {
                    setSaving(false);
                    setDialogOpen(false);
                    toast.success("Artifact renamed");
                  }, 700);
                }}
              >
                Rename
              </Button>
            </>
          }
        >
          <Input label="Title" defaultValue="Field notes, spring survey" />
        </Dialog>
        <ConfirmDialog
          open={confirmOpen}
          onClose={() => setConfirmOpen(false)}
          onConfirm={() => {
            setConfirmOpen(false);
            toast.toast({
              title: "Connection revoked",
              description: "Work laptop can no longer publish.",
            });
          }}
          danger
          title="Revoke this connection?"
          description="The agent using it stops working at once. Versions it published stay."
          confirmLabel="Revoke connection"
        />
      </Specimen>

      <Specimen
        title="Menu"
        note="Arrow keys move, Home and End jump, a letter jumps to the next item starting with it, Escape closes."
      >
        <Row gap={2}>
          <Menu
            label="Actions"
            iconEnd={DotsThreeIcon}
            items={[
              { label: "Copy link", icon: CopyIcon, onSelect: () => toast.success("Link copied") },
              { label: "Open in new tab", icon: ArrowSquareOutIcon, onSelect: () => undefined },
              { label: "Download HTML", icon: DownloadSimpleIcon, onSelect: () => undefined },
              { label: "History", icon: ClockCounterClockwiseIcon, onSelect: () => undefined },
              { label: "Disabled item", disabled: true },
              { type: "separator" },
              {
                label: "Delete",
                icon: TrashIcon,
                danger: true,
                onSelect: () => toast.error("Delete is a demo here"),
              },
            ]}
          />
          <Menu
            label="More actions"
            iconOnly
            icon={DotsThreeIcon}
            variant="ghost"
            align="start"
            items={[
              { label: "Rename", icon: PencilSimpleIcon, onSelect: () => undefined },
              { label: "Settings", icon: GearIcon, onSelect: () => undefined },
            ]}
          />
        </Row>
      </Specimen>

      <Specimen
        title="Tabs"
        note="One tab stop for the list; Left and Right move and select; Home and End jump."
      >
        <Tabs
          label="Artifact views"
          tabs={[
            {
              id: "preview",
              label: "Preview",
              icon: EyeIcon,
              content: <p className="text-muted">The rendered artifact, in its sandboxed frame.</p>,
            },
            {
              id: "source",
              label: "Source",
              content: <pre>{"<h1>Field notes</h1>\n<p>Spring survey, plot 4.</p>"}</pre>,
            },
            {
              id: "history",
              label: "History",
              meta: 7,
              content: <p className="text-muted">Seven versions, newest first.</p>,
            },
            { id: "settings", label: "Settings", disabled: true, content: null },
          ]}
        />
      </Specimen>

      <Specimen
        title="Toast"
        note="Says what happened, in a live region. Hides after 5 seconds (8 for errors, 10 with an action); hovering or focusing pauses it."
      >
        <Row gap={2}>
          <Button onClick={() => toast.success("Link copied")}>Success</Button>
          <Button
            onClick={() =>
              toast.error(
                "Could not save",
                "Version 8 was published while you edited. Review the changes, then save again.",
              )
            }
          >
            Error
          </Button>
          <Button
            onClick={() =>
              toast.toast({
                title: "Version 4 restored",
                description: "Published as version 9.",
                action: { label: "Undo", onClick: () => toast.toast({ title: "Restore undone" }) },
              })
            }
          >
            With action
          </Button>
          <Button
            onClick={() =>
              toast.toast({
                title: "Quota almost used",
                description: "96 of 100 artifacts.",
                tone: "warning",
              })
            }
          >
            Warning
          </Button>
        </Row>
      </Specimen>

      <Specimen
        title="Badge"
        note="Short labels. Visibility and role badges use the same words everywhere (VISIBILITY_META, ROLE_META)."
      >
        <Stack gap={3}>
          <Row gap={2}>
            {VISIBILITIES.map((v) => (
              <VisibilityBadge key={v} visibility={v} />
            ))}
          </Row>
          <Row gap={2}>
            <RoleBadge value="owner" />
            <RoleBadge value="editor" />
            <RoleBadge value="commenter" />
            <RoleBadge value="viewer" />
          </Row>
          <Row gap={2}>
            <Badge>Neutral</Badge>
            <Badge tone="strong">Strong</Badge>
            <Badge tone="accent">Current</Badge>
            <Badge tone="success">Done</Badge>
            <Badge tone="warning">Claimed</Badge>
            <Badge tone="danger">Failed</Badge>
            <Badge mono>v12</Badge>
          </Row>
        </Stack>
      </Specimen>

      <Specimen
        title="Tooltip"
        note="On hover and keyboard focus; Escape hides it. For names of icon buttons and short explanations, never for anything you must read to proceed."
      >
        <Row gap={3}>
          <Tooltip content="Copy the share link">
            <IconButton icon={LinkSimpleIcon} label="Copy link" variant="secondary" />
          </Tooltip>
          <Tooltip content="Anyone with the link can open it." placement="bottom">
            <Button variant="ghost" size="sm" icon={LinkSimpleIcon}>
              Unlisted
            </Button>
          </Tooltip>
        </Row>
      </Specimen>

      <Specimen title="Empty state" note="Say what is empty and what to do next.">
        <Card variant="flat" padding="none">
          <EmptyState
            headingLevel={3}
            title="No artifacts yet"
            description="Connect an agent, then ask it to publish an HTML artifact. It will appear here."
            action={
              <ButtonLink to={APP_ROUTES.connections} variant="primary" icon={PlugIcon}>
                Connect an agent
              </ButtonLink>
            }
          />
        </Card>
      </Specimen>

      <Specimen
        title="Skeleton and spinner"
        note="Skeletons hold the shape of content that is loading; mark the region aria-busy. Spinners are for actions."
      >
        <div className="ds-grid-3" aria-busy="true">
          {[0, 1, 2].map((i) => (
            <Exhibit key={i} aspect="4 / 3" label={<SkeletonText lines={2} />}>
              <Skeleton height="100%" radius="xs" />
            </Exhibit>
          ))}
        </div>
        <Row gap={3}>
          <Spinner label="Loading versions" />
          <span className="type-small text-muted">Loading versions</span>
        </Row>
      </Specimen>

      <Specimen
        title="Card and exhibit"
        note="Exhibit is the signature surface: the work stands on a wider base, with a wall label below. Card groups settings and lists."
      >
        <div className="ds-grid-3">
          {(
            [
              ["Field notes, spring survey", "doc", "unlisted", 7, "today"],
              ["Pricing model, Q3", "chart", "allowlist", 3, "2 days ago"],
              ["Onboarding walkthrough", "slides", "public", 12, "last week"],
            ] as const
          ).map(([title, kind, vis, v, when]) => (
            <Exhibit
              key={title}
              aspect="4 / 3"
              label={
                <>
                  <span className="ds-exhibit-title">{title}</span>
                  <Row gap={2}>
                    <span className="type-caption">
                      <span className="type-mono">v{v}</span>, edited {when}
                    </span>
                    <VisibilityBadge visibility={vis} />
                  </Row>
                </>
              }
            >
              <Thumb kind={kind} />
            </Exhibit>
          ))}
        </div>
        <div className="ds-grid-3">
          <Card>
            <Stack gap={2}>
              <h4>Raised</h4>
              <p className="type-small text-muted">
                Default. Settings groups, lists of connections.
              </p>
            </Stack>
          </Card>
          <Card variant="flat">
            <Stack gap={2}>
              <h4>Flat</h4>
              <p className="type-small text-muted">Secondary panels, side columns.</p>
            </Stack>
          </Card>
          <Card variant="sunk">
            <Stack gap={2}>
              <h4>Sunk</h4>
              <p className="type-small text-muted">Wells: code, token reveal, diffs.</p>
            </Stack>
          </Card>
        </div>
      </Specimen>

      <Specimen
        title="Layout helpers"
        note="Stack and Row take gaps from the spacing scale; Row wraps so it holds at 360px. PageHeader sets the page's h1."
      >
        <Card padding="none" className="ds-pageheader-demo">
          <div className="ds-pageheader-demo__inner">
            <PageHeader
              headingLevel={3}
              title="Connections"
              description="Agents that can publish to your account."
              actions={
                <Button variant="primary" icon={PlusIcon}>
                  New connection
                </Button>
              }
            />
          </div>
        </Card>
      </Specimen>
    </Stack>
  );
}
