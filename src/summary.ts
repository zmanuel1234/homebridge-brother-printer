/*
 * A printer's reading in words, as the settings screen's connection test and
 * the dashboards show it.
 */
import { COLOR_NAMES } from './decode';
import { readVia } from './snmp';
import type { PrinterData, QueryResult } from './snmp';
import { describeLeft, pagesInLast } from './usage';
import type { UsageSample } from './usage';

/**
 * Black-and-white pages, on a printer that counts color ones: as it gives them, or the
 * total less the color pages. Null otherwise (on a black-and-white printer it's the total).
 */
export function monoPages(d: PrinterData): number | null {
  if (typeof d.monoPages === 'number') { return d.monoPages; }
  if (typeof d.colorPages === 'number' && typeof d.totalPages === 'number' && d.totalPages >= d.colorPages) {
    return d.totalPages - d.colorPages;
  }
  return null;
}

/** "3,744 black-and-white, 1,200 color, 1,634 two-sided"; null when the printer gives none of these */
export function pageDetail(d: PrinterData): string | null {
  const n = (v: number): string => v.toLocaleString('en-US');
  const mono = monoPages(d);
  const parts = [
    mono !== null ? `${n(mono)} black-and-white` : '',
    typeof d.colorPages === 'number' ? `${n(d.colorPages)} color` : '',
    typeof d.duplexPages === 'number' ? `${n(d.duplexPages)} two-sided` : '',
  ].filter(Boolean);
  return parts.length ? parts.join(', ') : null;
}

/** "40 minutes", "18 hours", "5 days": how long the printer has been on */
export function describeUptime(seconds: number | null | undefined): string | null {
  if (typeof seconds !== 'number' || seconds < 0) { return null; }
  const plural = (n: number, w: string): string => `${n} ${w}${n === 1 ? '' : 's'}`;
  if (seconds < 3600) { return plural(Math.max(1, Math.round(seconds / 60)), 'minute'); }
  if (seconds < 48 * 3600) { return plural(Math.round(seconds / 3600), 'hour'); }
  return plural(Math.round(seconds / 86400), 'day');
}

export interface TestResult {
  model: string | null;
  serial: string | null;
  /** "SNMP v2c" or "IPP" */
  via: string;
  status: string;
  levels: string;
  drum: string | null;
  pages: number | null;
  /** The pages by kind: "3,744 black-and-white, 1,200 color, 1,634 two-sided"; null when not given */
  pageDetail: string | null;
  /** "Tray 1 40%, Tray 2 empty, MP Tray (bypass) empty"; null when the printer lists none */
  paper: string | null;
  /** "12 in the last 7 days, 85 in the last 30 days", from the plugin's history; null without it */
  usage: string | null;
  /** "Toner: about 6 weeks left", from the plugin's history; null without enough of it */
  left: string | null;
  /** Levels as bars for the dashboard: each toner or ink, then the drum */
  bars: { label: string; percent: number; color: string }[];
  /** A problem the printer reports, for the dashboard */
  problem: boolean;
  /** Printing now */
  printing: boolean;
  /** The printer's firmware as it gives it, when it does */
  firmware: string | null;
  /** How long the printer has been on ("5 days"), when it says */
  uptime: string | null;
  /** Read at this address, where the plugin found the printer, instead of the one in the settings */
  movedTo?: string;
}

const TRAY_STATE = { empty: 'empty', low: 'low', ok: 'has paper', unknown: 'unknown' } as const;

export function testSummary(d: QueryResult, cached?: CachedUsage, protocol?: string): TestResult {
  const kind = d.type === 'ink' ? 'ink' : 'toner';
  const levels = d.supplies.length
    ? d.supplies.map((s) => (d.supplies.length === 1 ? `${kind} ${s.level}%` : `${s.color} ${s.level}%`)).join(', ')
    : `no ${kind} levels reported`;
  return {
    model: d.model,
    serial: d.serial,
    via: readVia(d),
    status: d.statusText || (d.printing ? 'printing' : d.fault ? 'problem' : 'unknown'),
    levels,
    drum: d.drumPercent !== null ? `${d.drumPercent}%` : null,
    pages: d.totalPages,
    pageDetail: pageDetail(d),
    paper: d.trays?.length
      ? d.trays.map((t) => `${t.name}${t.secondary ? ' (bypass)' : ''} ${t.percent !== null && t.state !== 'empty' ? `${t.percent}%` : TRAY_STATE[t.state]}`
        + (t.media ? ` (${t.media})` : '')).join(', ')
      : null,
    ...usageSummary(d, cached, protocol),
    bars: [
      ...d.supplies.map((s) => ({ label: d.supplies.length === 1 ? (d.type === 'ink' ? 'Ink' : 'Toner') : COLOR_NAMES[s.color], percent: s.level, color: s.color })),
      ...(d.drumPercent !== null ? [{ label: 'Drum', percent: d.drumPercent, color: 'drum' }] : []),
    ],
    problem: d.fault === true,
    printing: d.printing === true,
    firmware: d.firmware?.trim() || null,
    uptime: describeUptime(d.uptime),
  };
}

function usageSummary(d: QueryResult, cached?: CachedUsage, protocol?: string): { usage: string | null; left: string | null } {
  const now = Math.round(Date.now() / 1000);
  // With auto, the plugin keeps SNMP's readings once SNMP has answered; IPP's page count
  // and levels, read now as a fallback, may not match them
  if (protocol === 'auto' && d.via === 'ipp' && cached?.snmpAnswered) { return { usage: null, left: null }; }
  const samples = cached?.samples;
  const pages = d.totalPages;
  const week = pagesInLast(samples, now, pages, 7);
  const month = pagesInLast(samples, now, pages, 30);
  const usage = [week !== null ? `${week} pages in the last 7 days` : '', month !== null ? `${month} in the last 30 days` : '']
    .filter(Boolean).join(', ') || null;
  const levels = Object.fromEntries(d.supplies.map((s) => [s.color, s.fine ?? s.level]));
  return { usage, left: describeLeft(samples, now, levels, d.type === 'ink' ? 'Ink' : 'Toner') };
}

export interface CachedUsage {
  samples: UsageSample[];
  /** The plugin found the printer at this address instead of the one in the settings */
  movedTo?: string;
  movedIppUrl?: string;
  /** The printer doesn't answer bulk SNMP requests (read row by row) */
  noBulk?: boolean;
  /** The plugin has read this printer over SNMP: its page counts are SNMP's */
  snmpAnswered: boolean;
}

