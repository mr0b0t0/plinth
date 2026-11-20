// One choice from a short list, each option with an optional sentence of explanation (visibility).
// Native radio buttons in a fieldset: arrow keys move the choice, Tab enters and leaves as one stop.
import { type ReactNode, useId } from "react";
import { ICON_SIZE, type Icon } from "../ui/index.ts";

export interface Choice<T extends string> {
  value: T;
  label: string;
  /** A sentence under the label; leave it out when the label says enough. */
  description?: ReactNode;
  icon?: Icon;
  disabled?: boolean;
  /** Why it is disabled, shown under the description. */
  disabledReason?: ReactNode;
}

export interface ChoiceListProps<T extends string> {
  legend: ReactNode;
  choices: Choice<T>[];
  value: T;
  onChange: (value: T) => void;
  name?: string;
}

export function ChoiceList<T extends string>({
  legend,
  choices,
  value,
  onChange,
  name,
}: ChoiceListProps<T>) {
  const auto = useId();
  const group = name ?? `choice${auto}`;
  return (
    <fieldset className="pl-acct-choices">
      <legend className="pl-acct-choices__legend">{legend}</legend>
      <div className="pl-acct-choices__list">
        {choices.map((c) => {
          const id = `${group}-${c.value}`;
          const descId = c.description !== undefined ? `${id}-desc` : undefined;
          const Glyph = c.icon;
          return (
            <label
              key={c.value}
              htmlFor={id}
              className="pl-acct-choice"
              data-checked={c.value === value || undefined}
              data-disabled={c.disabled || undefined}
            >
              <input
                id={id}
                type="radio"
                name={group}
                value={c.value}
                checked={c.value === value}
                disabled={c.disabled}
                aria-describedby={descId}
                onChange={() => onChange(c.value)}
                className="pl-acct-choice__input"
              />
              <span className="pl-acct-choice__text">
                <span className="pl-acct-choice__label">
                  {Glyph && <Glyph size={ICON_SIZE.sm} aria-hidden="true" />}
                  {c.label}
                </span>
                {descId && (
                  <span id={descId} className="pl-acct-choice__description">
                    {c.description}
                    {c.disabled && c.disabledReason && (
                      <span className="pl-acct-choice__reason"> {c.disabledReason}</span>
                    )}
                  </span>
                )}
              </span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}
