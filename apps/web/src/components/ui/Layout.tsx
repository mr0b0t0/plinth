import type { CSSProperties, HTMLAttributes, ReactNode } from "react";
import "./layout.css";

/** Steps of the spacing scale (--space-N). */
export type Space = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 8 | 10 | 12 | 16 | 24;

const space = (n: Space) => `var(--space-${n})`;

type Align = "start" | "center" | "end" | "stretch" | "baseline";
type Justify = "start" | "center" | "end" | "between";

const alignMap: Record<Align, string> = {
  start: "flex-start",
  center: "center",
  end: "flex-end",
  stretch: "stretch",
  baseline: "baseline",
};
const justifyMap: Record<Justify, string> = {
  start: "flex-start",
  center: "center",
  end: "flex-end",
  between: "space-between",
};

type Tag = "div" | "section" | "ul" | "ol" | "nav" | "header" | "footer" | "form";

interface FlexProps extends HTMLAttributes<HTMLElement> {
  as?: Tag;
  gap?: Space;
  align?: Align;
  justify?: Justify;
}

/** Vertical stack with a gap from the spacing scale. */
export function Stack({
  as: T = "div",
  gap = 4,
  align,
  justify,
  className,
  style,
  ...rest
}: FlexProps) {
  const s: CSSProperties = { gap: space(gap), ...style };
  if (align) s.alignItems = alignMap[align];
  if (justify) s.justifyContent = justifyMap[justify];
  return <T className={`pl-stack${className ? ` ${className}` : ""}`} style={s} {...rest} />;
}

export interface RowProps extends FlexProps {
  /** Wrap onto new lines when space runs out (default true). */
  wrap?: boolean;
}

/** Horizontal row with a gap; wraps by default so it holds at 360px. */
export function Row({
  as: T = "div",
  gap = 3,
  align = "center",
  justify,
  wrap = true,
  className,
  style,
  ...rest
}: RowProps) {
  const s: CSSProperties = { gap: space(gap), alignItems: alignMap[align], ...style };
  if (justify) s.justifyContent = justifyMap[justify];
  if (!wrap) s.flexWrap = "nowrap";
  return <T className={`pl-row${className ? ` ${className}` : ""}`} style={s} {...rest} />;
}

export interface ContainerProps extends HTMLAttributes<HTMLDivElement> {
  /** content: 72rem (default). reading: 40rem. narrow: 28rem (sign-in, consent). full: no limit. */
  width?: "content" | "reading" | "narrow" | "full";
}

/** Centers content with the page gutter. AppShell already wraps pages in one. */
export function Container({ width = "content", className, ...rest }: ContainerProps) {
  return (
    <div
      className={`pl-container pl-container--${width}${className ? ` ${className}` : ""}`}
      {...rest}
    />
  );
}

export interface PageHeaderProps {
  /** The page's h1 (15px semibold; the top bar carries the breadcrumb). */
  title: ReactNode;
  /** One line under the title. */
  description?: ReactNode;
  /** Buttons on the right (they move under the title on narrow screens). */
  actions?: ReactNode;
  /** Small content above the title, e.g. a back link. */
  before?: ReactNode;
  /** Badges or meta after the description. */
  meta?: ReactNode;
  /** Heading level of the title (1 by default; lower only when the header is nested). */
  headingLevel?: 1 | 2 | 3;
  className?: string;
}

export function PageHeader({
  title,
  description,
  actions,
  before,
  meta,
  headingLevel = 1,
  className,
}: PageHeaderProps) {
  const H = (["h1", "h2", "h3"] as const)[headingLevel - 1] ?? "h1";
  return (
    <header className={`pl-page-header${className ? ` ${className}` : ""}`}>
      <div className="pl-page-header__text">
        {before && <div className="pl-page-header__before">{before}</div>}
        <H className="pl-page-header__title">{title}</H>
        {description && <p className="pl-page-header__description">{description}</p>}
        {meta && <div className="pl-page-header__meta">{meta}</div>}
      </div>
      {actions && <div className="pl-page-header__actions">{actions}</div>}
    </header>
  );
}
