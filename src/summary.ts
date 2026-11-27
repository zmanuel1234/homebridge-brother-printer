/*
 * A printer's reading in words, as the settings screen's connection test and
 * the dashboards show it.
 */
import { COLOR_NAMES } from './decode';
import { readVia } from './snmp';
import type { QueryResult } from './snmp';
import { describeLeft, pagesInLast } from './usage';
import type { UsageSample } from './usage';

export interface TestResult {
  model: string | null;
  serial: string | null;
  /** "SNMP v2c" or "IPP" */
  via: string;
  status: string;
  levels: string;
  drum: string | null;
  pages: number | null;
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
    paper: d.trays?.length
      ? d.trays.map((t) => `${t.name}${t.secondary ? ' (bypass)' : ''} ${t.percent !== null && t.state !== 'empty' ? `${t.percent}%` : TRAY_STATE[t.state]}`).join(', ')
      : null,
    ...usageSummary(d, cached, protocol),
    bars: [
      ...d.supplies.map((s) => ({ label: d.supplies.length === 1 ? (d.type === 'ink' ? 'Ink' : 'Toner') : COLOR_NAMES[s.color], percent: s.level, color: s.color })),
      ...(d.drumPercent !== null ? [{ label: 'Drum', percent: d.drumPercent, color: 'drum' }] : []),
    ],
    problem: d.fault === true,
    printing: d.printing === true,
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
  /** The plugin has read this printer over SNMP: its page counts are SNMP's */
  snmpAnswered: boolean;
}

