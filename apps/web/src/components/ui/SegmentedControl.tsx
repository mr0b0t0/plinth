import { useId } from "react";
import { ICON_SIZE, type Icon } from "./icons.tsx";
import "./segmented.css";

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
  icon?: Icon;
}

export interface SegmentedControlProps<T extends string> {
  /** Names the group. */
  label: string;
  /** Show the group label visually (default: screen readers only). */
  showLabel?: boolean;
  options: SegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
  size?: "sm" | "md";
  className?: string;
}

/**
 * One choice from a few, shown side by side. Native radio buttons, so arrow keys move the choice
 * and Tab enters and leaves the group as one stop.
 */
export function SegmentedControl<T extends string>({
  label,
  showLabel = false,
  options,
  value,
  onChange,
  size = "md",
  className,
}: SegmentedControlProps<T>) {
  const name = useId();
  return (
    <fieldset className={`pl-segmented pl-segmented--${size}${className ? ` ${className}` : ""}`}>
      <legend className={showLabel ? "pl-segmented__legend" : "visually-hidden"}>{label}</legend>
      <div className="pl-segmented__track">
        {options.map((o) => {
          const OptIcon = o.icon;
          return (
            <label key={o.value} className="pl-segmented__option">
              <input
                type="radio"
                name={name}
                value={o.value}
                checked={o.value === value}
                onChange={() => onChange(o.value)}
                className="pl-segmented__input"
              />
              <span className="pl-segmented__face">
                {OptIcon && <OptIcon size={ICON_SIZE.sm} aria-hidden="true" />}
                {o.label}
              </span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}
