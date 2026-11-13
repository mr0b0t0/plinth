import type { ComponentProps, ReactNode } from "react";
import { Link, type LinkProps } from "../../lib/router.tsx";
import "./button.css";
import { ICON_SIZE, type Icon } from "./icons.tsx";
import { Spinner } from "./Spinner.tsx";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md" | "lg";

/** Class names for something that should look like a button (e.g. an external <a>). */
export function buttonClassName(
  opts: { variant?: ButtonVariant; size?: ButtonSize; iconOnly?: boolean; block?: boolean } = {},
): string {
  const { variant = "secondary", size = "md", iconOnly = false, block = false } = opts;
  return [
    "pl-button",
    `pl-button--${variant}`,
    `pl-button--${size}`,
    iconOnly && "pl-button--icon-only",
    block && "pl-button--block",
  ]
    .filter(Boolean)
    .join(" ");
}

const join = (...c: (string | false | undefined)[]) => c.filter(Boolean).join(" ");
const iconPx = (size: ButtonSize) => (size === "lg" ? ICON_SIZE.md : ICON_SIZE.sm);

function Content({
  start: Start,
  end: End,
  px,
  loading,
  children,
}: {
  start?: Icon;
  end?: Icon;
  px: number;
  loading: boolean;
  children?: ReactNode;
}) {
  return (
    <>
      {loading && (
        <span className="pl-button__spinner">
          <Spinner size={px} />
        </span>
      )}
      <span className="pl-button__content">
        {Start && <Start size={px} aria-hidden="true" />}
        {children}
        {End && <End size={px} aria-hidden="true" />}
      </span>
    </>
  );
}

export interface ButtonProps extends ComponentProps<"button"> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Leading icon. */
  icon?: Icon;
  /** Trailing icon (e.g. a caret on a menu trigger). */
  iconEnd?: Icon;
  /** Shows a spinner, keeps the width and ignores clicks. Focus and the label stay. */
  loading?: boolean;
  /** Full width. */
  block?: boolean;
}

export function Button({
  variant = "secondary",
  size = "md",
  icon,
  iconEnd,
  loading = false,
  block = false,
  type = "button",
  className,
  children,
  onClick,
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      className={join(buttonClassName({ variant, size, block }), className)}
      aria-disabled={loading || undefined}
      aria-busy={loading || undefined}
      data-loading={loading || undefined}
      onClick={loading ? (e) => e.preventDefault() : onClick}
      {...rest}
    >
      <Content start={icon} end={iconEnd} px={iconPx(size)} loading={loading}>
        {children}
      </Content>
    </button>
  );
}

export interface IconButtonProps extends Omit<ComponentProps<"button">, "children"> {
  /** Accessible name. Required: an icon-only button has no visible text. */
  label: string;
  icon: Icon;
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
}

/** Icon-only button. Wrap it in <Tooltip content={label}> so sighted users see the name too. */
export function IconButton({
  label,
  icon,
  variant = "ghost",
  size = "md",
  loading = false,
  type = "button",
  className,
  onClick,
  ...rest
}: IconButtonProps) {
  return (
    <button
      type={type}
      aria-label={label}
      className={join(buttonClassName({ variant, size, iconOnly: true }), className)}
      aria-disabled={loading || undefined}
      aria-busy={loading || undefined}
      data-loading={loading || undefined}
      onClick={loading ? (e) => e.preventDefault() : onClick}
      {...rest}
    >
      <Content start={icon} px={size === "sm" ? ICON_SIZE.sm : ICON_SIZE.md} loading={loading} />
    </button>
  );
}

export interface ButtonLinkProps extends LinkProps {
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: Icon;
  iconEnd?: Icon;
  block?: boolean;
  children: ReactNode;
}

/** An in-app link that looks like a button. Use it when the action navigates. */
export function ButtonLink({
  variant = "secondary",
  size = "md",
  icon,
  iconEnd,
  block = false,
  className,
  children,
  ...rest
}: ButtonLinkProps) {
  return (
    <Link className={join(buttonClassName({ variant, size, block }), className)} {...rest}>
      <Content start={icon} end={iconEnd} px={iconPx(size)} loading={false}>
        {children}
      </Content>
    </Link>
  );
}
