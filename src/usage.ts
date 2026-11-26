/*
 * Usage over time, from one reading a day kept in the accessory's cache: pages
 * printed in the last 7 and 30 days, and when each toner or ink is likely to run
 * out at the rate it has been going down since it was last replaced.
 */
import { COLOR_NAMES } from './decode';
import type { Color } from './decode';

export interface UsageSample {
  /** Unix time, seconds */
  t: number;
  /** Total pages printed, when the printer reports them */
  p?: number;
  /** Supply levels in % by color */
  l: Partial<Record<Color, number>>;
}

const DAY = 86400;
/** A new sample once this long after the last one */
export const SAMPLE_EVERY = 20 * 3600;
/** Kept for about this long */
export const KEEP_DAYS = 120;
/** A rise of this much means a new cartridge: the estimate starts again from there */
const REFILL_RISE = 10;
/** An estimate needs this many days of readings since the last replacement, and this much of a drop */
const MIN_SPAN_DAYS = 7;
const MIN_DROP = 3;

/** The samples with this reading added, when one is due; old ones dropped. Doesn't change the list it's given. */
export function addSample(samples: UsageSample[] | undefined, now: number, pages: number | null,
  levels: Partial<Record<Color, number>>): UsageSample[] | null {
  const list = Array.isArray(samples) ? samples.filter(valid) : [];
  const last = list[list.length - 1];
  if (last && now - last.t < SAMPLE_EVERY) { return null; }
  const sample: UsageSample = { t: now, l: { ...levels } };
  if (pages !== null) { sample.p = pages; }
  return [...list.filter((s) => now - s.t <= KEEP_DAYS * DAY), sample];
}

const valid = (s: unknown): s is UsageSample => !!s && typeof (s as UsageSample).t === 'number'
  && typeof (s as UsageSample).l === 'object' && (s as UsageSample).l !== null;

/**
 * Pages printed over about the last `days` days: now against the oldest sample in
 * that window, once the samples cover most of it. Null without enough history, or
 * when the counter went backwards (a different printer, or a reset).
 */
export function pagesInLast(samples: UsageSample[] | undefined, now: number, pages: number | null, days: number): number | null {
  if (pages === null || !Array.isArray(samples)) { return null; }
  const from = samples.filter(valid).find((s) => typeof s.p === 'number' && now - s.t <= days * DAY + 6 * 3600);
  if (!from || now - from.t < days * DAY * 0.85) { return null; }
  const printed = pages - from.p!;
  return printed >= 0 ? printed : null;
}

/**
 * Days until a color reaches 0%, at the rate it has gone down since it was last
 * replaced (a least-squares line through the readings). Null without at least a
 * week of readings and a few % of drop since then, or when it isn't going down.
 */
export function daysLeft(samples: UsageSample[] | undefined, color: Color, now: number, level: number): number | null {
  const points = (Array.isArray(samples) ? samples.filter(valid) : [])
    .filter((s) => typeof s.l[color] === 'number' && s.t < now)
    .map((s) => ({ t: s.t, v: s.l[color]! }));
  points.push({ t: now, v: level });
  // Since the last replacement
  let start = 0;
  for (let i = 1; i < points.length; i++) { if (points[i].v >= points[i - 1].v + REFILL_RISE) { start = i; } }
  const run = points.slice(start);
  if (run.length < 2 || (now - run[0].t) / DAY < MIN_SPAN_DAYS || run[0].v - level < MIN_DROP) { return null; }
  const n = run.length;
  const mt = run.reduce((a, p) => a + p.t, 0) / n;
  const mv = run.reduce((a, p) => a + p.v, 0) / n;
  const cov = run.reduce((a, p) => a + (p.t - mt) * (p.v - mv), 0);
  const varT = run.reduce((a, p) => a + (p.t - mt) ** 2, 0);
  const perDay = varT > 0 ? (cov / varT) * DAY : 0;
  if (!(perDay < 0)) { return null; }
  return Math.max(0, level / -perDay);
}

/** "5 days", "about 3 weeks", "about 4 months", "over a year" */
export function describeDays(days: number): string {
  if (days < 1) { return 'less than a day'; }
  if (days < 14) { const d = Math.round(days); return `about ${d} day${d === 1 ? '' : 's'}`; }
  if (days < 75) { return `about ${Math.round(days / 7)} weeks`; }
  if (days < 365) { return `about ${Math.round(days / 30)} months`; }
  return 'over a year';
}

/** "Toner: about 6 weeks left" or "Cyan: about 3 weeks, Black: about 4 months left"; null without estimates */
export function describeLeft(samples: UsageSample[] | undefined, now: number, levels: Partial<Record<Color, number>>,
  kind: 'Toner' | 'Ink'): string | null {
  const colors = Object.keys(levels) as Color[];
  const estimates = colors
    .map((c) => ({ c, days: daysLeft(samples, c, now, levels[c]!) }))
    .filter((e): e is { c: Color; days: number } => e.days !== null)
    .sort((a, b) => a.days - b.days);
  if (!estimates.length) { return null; }
  if (colors.length === 1) { return `${kind}: ${describeDays(estimates[0].days)} left`; }
  return `${estimates.map((e) => `${COLOR_NAMES[e.c]}: ${describeDays(e.days)}`).join(', ')} left`;
}
