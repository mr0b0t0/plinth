import { CaretDownIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { type ComponentProps, type ReactNode, useId } from "react";
import "./field.css";
import { ICON_SIZE } from "./icons.tsx";

export interface FieldControlProps {
  id: string;
  "aria-describedby"?: string;
  "aria-invalid"?: true;
}

export interface FieldProps {
  label: ReactNode;
  /** Help text under the control. */
  hint?: ReactNode;
  /** Error text. Marks the control invalid and is read with it. */
  error?: ReactNode;
  /** Keep the label for screen readers only (e.g. a search box with a visible icon). */
  hideLabel?: boolean;
  id?: string;
  className?: string;
  /** Renders the control with the ids it must carry. */
  children: (control: FieldControlProps) => ReactNode;
}

/** Label + control + hint + error, wired together. Input, Textarea and Select use it. */
export function Field({ label, hint, error, hideLabel, id, className, children }: FieldProps) {
  const auto = useId();
  const controlId = id ?? `f${auto}`;
  const hintId = hint ? `${controlId}-hint` : undefined;
  const errorId = error ? `${controlId}-error` : undefined;
  const describedBy = [errorId, hintId].filter(Boolean).join(" ") || undefined;
  return (
    <div className={`pl-field${className ? ` ${className}` : ""}`}>
      <label htmlFor={controlId} className={hideLabel ? "visually-hidden" : "pl-field__label"}>
        {label}
      </label>
      {children({
        id: controlId,
        "aria-describedby": describedBy,
        "aria-invalid": error ? true : undefined,
      })}
      {error && (
        <p id={errorId} className="pl-field__error">
          <WarningCircleIcon size={ICON_SIZE.sm} aria-hidden="true" />
          <span>{error}</span>
        </p>
      )}
      {hint && (
        <p id={hintId} className="pl-field__hint">
          {hint}
        </p>
      )}
    </div>
  );
}

interface FieldOwnProps {
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  hideLabel?: boolean;
  /** Class for the wrapper. */
  className?: string;
}

export interface InputProps extends Omit<ComponentProps<"input">, "className">, FieldOwnProps {
  /** Monospace text (tokens, ids, URLs). */
  mono?: boolean;
}

export function Input({ label, hint, error, hideLabel, className, id, mono, ...rest }: InputProps) {
  return (
    <Field
      label={label}
      hint={hint}
      error={error}
      hideLabel={hideLabel}
      id={id}
      className={className}
    >
      {(p) => <input className={`pl-control${mono ? " pl-control--mono" : ""}`} {...p} {...rest} />}
    </Field>
  );
}

export interface TextareaProps
  extends Omit<ComponentProps<"textarea">, "className">,
    FieldOwnProps {
  mono?: boolean;
}

export function Textarea({
  label,
  hint,
  error,
  hideLabel,
  className,
  id,
  mono,
  rows = 4,
  ...rest
}: TextareaProps) {
  return (
    <Field
      label={label}
      hint={hint}
      error={error}
      hideLabel={hideLabel}
      id={id}
      className={className}
    >
      {(p) => (
        <textarea
          className={`pl-control pl-control--area${mono ? " pl-control--mono" : ""}`}
          rows={rows}
          {...p}
          {...rest}
        />
      )}
    </Field>
  );
}

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface SelectProps extends Omit<ComponentProps<"select">, "className">, FieldOwnProps {
  /** Options; or pass <option> children instead. */
  options?: SelectOption[];
}

/** Native select, styled. Native keeps keyboard and screen reader behavior right on every platform. */
export function Select({
  label,
  hint,
  error,
  hideLabel,
  className,
  id,
  options,
  children,
  ...rest
}: SelectProps) {
  return (
    <Field
      label={label}
      hint={hint}
      error={error}
      hideLabel={hideLabel}
      id={id}
      className={className}
    >
      {(p) => (
        <span className="pl-select">
          <select className="pl-control pl-control--select" {...p} {...rest}>
            {options
              ? options.map((o) => (
                  <option key={o.value} value={o.value} disabled={o.disabled}>
                    {o.label}
                  </option>
                ))
              : children}
          </select>
          <CaretDownIcon className="pl-select__caret" size={ICON_SIZE.sm} aria-hidden="true" />
        </span>
      )}
    </Field>
  );
}
