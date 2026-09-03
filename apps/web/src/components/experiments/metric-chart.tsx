import type { RunMetric } from '@/db/schema';
import s from './experiments.module.css';

/** A small inline SVG line chart for one metric over steps. */
export function MetricChart({
  name,
  points,
  width = 320,
  height = 90,
}: {
  name: string;
  points: RunMetric[];
  width?: number;
  height?: number;
}) {
  const pad = { l: 6, r: 6, t: 8, b: 6 };
  const xs = points.map((p, i) =>
    points.length > 1 && points.some((q) => q.step !== points[0]?.step) ? p.step : i,
  );
  const ys = points.map((p) => p.value);
  const x0 = Math.min(...xs);
  const x1 = Math.max(...xs);
  const y0 = Math.min(...ys);
  const y1 = Math.max(...ys);
  const sx = (x: number) =>
    pad.l + (x1 === x0 ? (width - pad.l - pad.r) / 2 : ((x - x0) / (x1 - x0)) * (width - pad.l - pad.r));
  const sy = (y: number) =>
    height -
    pad.b -
    (y1 === y0 ? (height - pad.t - pad.b) / 2 : ((y - y0) / (y1 - y0)) * (height - pad.t - pad.b));
  const d = points
    .map((p, i) => `${i === 0 ? 'M' : 'L'}${sx(xs[i] ?? 0).toFixed(1)} ${sy(p.value).toFixed(1)}`)
    .join(' ');
  const last = points[points.length - 1];
  return (
    <div className={s.chart}>
      <div className={s.chartTitle}>
        <span>{name}</span>
        <span>
          {fmt(last?.value)}{' '}
          <span style={{ color: 'var(--eg-muted)' }}>
            min {fmt(y0)} · max {fmt(y1)}
          </span>
        </span>
      </div>
      <svg
        width="100%"
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={`${name} over steps`}
        style={{ display: 'block', background: 'var(--eg-surface-2)', borderRadius: 4 }}
      >
        <path
          d={d}
          fill="none"
          stroke="var(--eg-accent)"
          strokeWidth={1.5}
          strokeLinejoin="round"
          strokeLinecap="round"
        />
        {points.length === 1 && (
          <circle cx={sx(xs[0] ?? 0)} cy={sy(points[0]?.value ?? 0)} r={3} fill="var(--eg-accent)" />
        )}
      </svg>
    </div>
  );
}

export function fmt(v: number | undefined): string {
  if (v === undefined || Number.isNaN(v)) return '';
  if (Math.abs(v) >= 1000) return v.toFixed(0);
  if (Math.abs(v) >= 1) return v.toFixed(3).replace(/\.?0+$/, '');
  return v.toPrecision(3);
}
