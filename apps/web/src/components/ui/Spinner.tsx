import "./spinner.css";

export interface SpinnerProps {
  /** Pixel size; defaults to the small icon size. */
  size?: number;
  /** When set, the spinner is announced (role="status"). Leave unset inside a busy button. */
  label?: string;
}

export function Spinner({ size = 16, label }: SpinnerProps) {
  const svg = (
    <svg
      className="pl-spinner"
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
    >
      <circle cx="8" cy="8" r="6.25" stroke="currentColor" strokeOpacity="0.25" strokeWidth="1.5" />
      <path
        d="M14.25 8A6.25 6.25 0 0 0 8 1.75"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
  if (!label) return svg;
  return (
    <span role="status" className="pl-spinner-wrap">
      {svg}
      <span className="visually-hidden">{label}</span>
    </span>
  );
}
