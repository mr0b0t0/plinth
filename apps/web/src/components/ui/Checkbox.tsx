import { type ComponentProps, type ReactNode, useEffect, useId, useRef } from "react";
import "./field.css";

interface ToggleOwnProps {
  label: ReactNode;
  /** Help text under the label, read with the control. */
  hint?: ReactNode;
  className?: string;
}

export interface CheckboxProps
  extends Omit<ComponentProps<"input">, "type" | "className">,
    ToggleOwnProps {
  /** Mixed state (e.g. "select all" with some rows selected). */
  indeterminate?: boolean;
}

/** Native checkbox, styled. Label is clickable; Space toggles. */
export function Checkbox({
  label,
  hint,
  className,
  indeterminate,
  id,
  disabled,
  ...rest
}: CheckboxProps) {
  const auto = useId();
  const inputId = id ?? `c${auto}`;
  const hintId = hint ? `${inputId}-hint` : undefined;
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = Boolean(indeterminate);
  }, [indeterminate]);
  return (
    <label
      className={`pl-check${className ? ` ${className}` : ""}`}
      htmlFor={inputId}
      data-disabled={disabled || undefined}
    >
      <span className="pl-check__box">
        <input
          ref={ref}
          id={inputId}
          type="checkbox"
          className="pl-check__input"
          aria-describedby={hintId}
          disabled={disabled}
          {...rest}
        />
        {/* Drawn rather than a Phosphor glyph: at 12px the mark needs a heavier stroke. */}
        <svg
          className="pl-check__mark"
          width="12"
          height="12"
          viewBox="0 0 12 12"
          aria-hidden="true"
        >
          <path
            d={indeterminate ? "M2.5 6h7" : "M2.25 6.25l2.5 2.5 5-5.5"}
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </span>
      <span className="pl-check__label">{label}</span>
      {hint && (
        <span id={hintId} className="pl-check__hint">
          {hint}
        </span>
      )}
    </label>
  );
}

export interface SwitchProps
  extends Omit<ComponentProps<"input">, "type" | "className" | "role">,
    ToggleOwnProps {}

/** An on/off setting that applies immediately. Native checkbox with role="switch". */
export function Switch({ label, hint, className, id, disabled, ...rest }: SwitchProps) {
  const auto = useId();
  const inputId = id ?? `s${auto}`;
  const hintId = hint ? `${inputId}-hint` : undefined;
  return (
    <label
      className={`pl-check${className ? ` ${className}` : ""}`}
      htmlFor={inputId}
      data-disabled={disabled || undefined}
    >
      <span className="pl-switch__track">
        <input
          id={inputId}
          type="checkbox"
          // biome-ignore lint/a11y/useAriaPropsForRole: a native checkbox exposes its checked state; aria-checked would duplicate it
          role="switch"
          className="pl-switch__input"
          aria-describedby={hintId}
          disabled={disabled}
          {...rest}
        />
        <span className="pl-switch__thumb" aria-hidden="true" />
      </span>
      <span className="pl-check__label">{label}</span>
      {hint && (
        <span id={hintId} className="pl-check__hint">
          {hint}
        </span>
      )}
    </label>
  );
}
