// A small daily bar chart for the admin Stats page: inline SVG, no chart library. The picture is
// decorative (aria-hidden); the figcaption sums it up and "Show numbers" holds every value as a
// table. Two series stack, the second drawn hatched so they differ by more than color.
import { useId } from "react";
import { formatCount } from "./StatGrid.tsx";
import "./admin.css";

export interface TrendSeries {
  label: string;
  /** One value per day, in the same order as `days`. */
  values: number[];
}

export interface TrendChartProps {
  /** "Opens per day". */
  title: string;
  /** What one unit is called in the summary, singular and plural: ["open", "opens"]. */
  unit: [string, string];
  /** UTC days, oldest first ("2026-11-12"). */
  days: string[];
  /** One series, or two that stack (the first at the baseline, solid). */
  series: [TrendSeries] | [TrendSeries, TrendSeries];
}

const W = 600;
const H = 120;
const GAP = 2; // surface gap between bars and between stacked segments
const R = 2; // rounded data end

/** A bar from the baseline up, rounded at the top only. */
function barPath(x: number, w: number, y: number, h: number, rounded: boolean): string {
  if (h <= 0) return "";
  const r = rounded ? Math.min(R, w / 2, h) : 0;
  const bottom = y + h;
  return [
    `M${x} ${bottom}`,
    `V${y + r}`,
    r ? `Q${x} ${y} ${x + r} ${y}` : "",
    `H${x + w - r}`,
    r ? `Q${x + w} ${y} ${x + w} ${y + r}` : "",
    `V${bottom}`,
    "Z",
  ]
    .filter(Boolean)
    .join(" ");
}

const count = (n: number, [one, many]: [string, string]) =>
  `${formatCount(n)} ${n === 1 ? one : many}`;

/** "Last 30 days: 412 opens in all, most on 2026-11-12 (51)." The title comes before it. */
export function summarize(unit: [string, string], days: string[], totals: number[]): string {
  const span = `Last ${days.length} ${days.length === 1 ? "day" : "days"}`;
  const sum = totals.reduce((a, b) => a + b, 0);
  if (sum === 0) return `${span}: none.`;
  let peak = 0;
  for (let i = 1; i < totals.length; i++) if ((totals[i] ?? 0) > (totals[peak] ?? 0)) peak = i;
  return `${span}: ${count(sum, unit)} in all, most on ${days[peak]} (${formatCount(totals[peak] ?? 0)}).`;
}

export function TrendChart({ title, unit, days, series }: TrendChartProps) {
  const patternId = useId().replace(/:/g, "");
  const stacked = series.length > 1;
  const totals = days.map((_, i) => series.reduce((sum, s) => sum + (s.values[i] ?? 0), 0));
  const max = Math.max(1, ...totals);
  const slot = W / Math.max(1, days.length);
  // Thin marks: at most 70% of the slot, and never closer than the surface gap.
  const barW = Math.max(1, Math.min(slot * 0.7, slot - GAP));
  const scale = (n: number) => (n / max) * (H - 1);

  return (
    <figure className="pl-trend">
      <figcaption className="pl-trend__caption">
        <span className="pl-trend__title">{title}</span>
        <span className="visually-hidden">. </span>
        <span className="pl-trend__summary type-num">{summarize(unit, days, totals)}</span>
      </figcaption>
      {stacked && (
        <ul className="pl-trend__legend" aria-hidden="true">
          {series.map((s, i) => (
            <li key={s.label}>
              <span className={`pl-trend__swatch${i === 1 ? " pl-trend__swatch--hatch" : ""}`} />
              {s.label}
            </li>
          ))}
        </ul>
      )}
      <svg
        className="pl-trend__plot"
        viewBox={`0 0 ${W} ${H + 1}`}
        width="100%"
        aria-hidden="true"
        focusable="false"
      >
        <defs>
          <pattern
            id={patternId}
            width="4"
            height="4"
            patternUnits="userSpaceOnUse"
            patternTransform="rotate(45)"
          >
            <rect className="pl-trend__hatch-line" x="0" y="0" width="2" height="4" />
          </pattern>
        </defs>
        {days.map((day, i) => {
          const x = i * slot + (slot - barW) / 2;
          const first = series[0].values[i] ?? 0;
          const second = series[1]?.values[i] ?? 0;
          const h1 = scale(first);
          const h2 = scale(second);
          // The gap between segments comes out of the upper one, so totals keep their height.
          const top2 = H - h1 - h2;
          const h2Drawn = h1 > 0 ? Math.max(0, h2 - GAP) : h2;
          const tip = stacked
            ? `${day}: ${series.map((s) => `${s.label} ${formatCount(s.values[i] ?? 0)}`).join(", ")}`
            : `${day}: ${count(first, unit)}`;
          return (
            <g key={day}>
              <title>{tip}</title>
              <rect className="pl-trend__hit" x={i * slot} y="0" width={slot} height={H} />
              <path
                className="pl-trend__bar"
                d={barPath(x, barW, H - h1, h1, !stacked || second === 0)}
              />
              {stacked && h2Drawn > 0 && (
                <path
                  className="pl-trend__bar--hatch"
                  style={{ fill: `url(#${patternId})` }}
                  d={barPath(x, barW, top2, h2Drawn, true)}
                />
              )}
            </g>
          );
        })}
        <line className="pl-trend__baseline" x1="0" x2={W} y1={H + 0.5} y2={H + 0.5} />
      </svg>
      <div className="pl-trend__axis type-num" aria-hidden="true">
        <span>{days[0]}</span>
        <span>{days[days.length - 1]}</span>
      </div>
      <details className="pl-trend__numbers">
        <summary>Show numbers</summary>
        <table className="pl-trend__table type-num">
          <caption className="visually-hidden">{title}</caption>
          <thead>
            <tr>
              <th scope="col">Day</th>
              {stacked ? (
                <>
                  {series.map((s) => (
                    <th key={s.label} scope="col">
                      {s.label}
                    </th>
                  ))}
                  <th scope="col">Total</th>
                </>
              ) : (
                <th scope="col">Count</th>
              )}
            </tr>
          </thead>
          <tbody>
            {days.map((day, i) => (
              <tr key={day}>
                <th scope="row">{day}</th>
                {stacked &&
                  series.map((s) => <td key={s.label}>{formatCount(s.values[i] ?? 0)}</td>)}
                <td>{formatCount(totals[i] ?? 0)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </figure>
  );
}
