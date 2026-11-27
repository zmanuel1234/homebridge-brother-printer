/*
 * Paper trays: which one is empty or low. Over SNMP from the Printer MIB's input
 * table (prtInputTable, RFC 3805); over IPP from printer-input-tray (PWG 5100.13).
 * Both give a tray's name, its capacity and how much paper is in it: a number of
 * sheets, -3 "some paper", 0 empty, or -2 / -1 unknown.
 */
import { text } from './text';

export type TrayState = 'empty' | 'low' | 'ok' | 'unknown';

export interface Tray {
  /** As shown in Home and the log: "Tray 1", "MP Tray", "Bypass Tray" */
  name: string;
  /** Stable key for the tray's sensor, from its name: "tray-1", "mp-tray" */
  key: string;
  /** How full, when the printer counts sheets */
  percent: number | null;
  state: TrayState;
  /** Sheets the tray holds, when the printer says */
  capacity: number | null;
  /**
   * A bypass, manual or multi-purpose tray, which is often empty on purpose: it
   * gets no sensor and no warning
   */
  secondary: boolean;
  /** The paper type the tray is set for ("Regular", "Thin"), when the printer says */
  media?: string;
}

/**
 * At or below this much paper, a tray that counts sheets is low. Shown only: some
 * printers (Ricoh, Samsung) count in 10% steps, so it's no reason for a warning.
 */
export const LOW_TRAY_PERCENT = 10;

// (Not "rear": on many Epson and Canon inkjets the rear feeder is the main tray)
const SECONDARY = /bypass|manual|\bmp\b|^mp ?tray|multi|single ?sheet|envelope|\bmsi\b|\bmpt\b/i;
/** Not a tray: the printer's "pick the tray for me" entry */
const VIRTUAL = /^auto(\s*select)?$/i;

/** "TRAY1" → "Tray 1", "MPTRAY" → "MP Tray", "MANUAL TRAY" → "Manual Tray", "tray-1" → "Tray 1"; mixed case stays */
export function trayName(raw: string, index: number): string {
  let name = raw.replace(/\s+/g, ' ').trim();
  if (!name) { return `Tray ${index}`; }
  // Keywords as names (IPP): "tray-1", "InputTray 1", "main"
  name = name.replace(/[-_]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2');
  name = name.replace(/^mp ?tray/i, 'MP Tray').replace(/([a-z])(\d)/gi, '$1 $2');
  if (name === name.toUpperCase() || name === name.toLowerCase()) {
    name = name.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()).replace(/\bMp\b/g, 'MP');
  }
  return name;
}

const keyOf = (name: string): string => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'tray';

/** What else the printer says about a tray: its type and status, when it gives them */
export interface TrayInfo {
  /** prtInputType: 5 sheetFeedManual; over IPP type=sheetFeedManual */
  manual?: boolean;
  /**
   * prtInputStatus / IPP status= (a SubUnitStatus): the low three bits say whether the
   * tray is available; 5 is unknown
   */
  status?: number | null;
  /** prtInputMediaName / IPP medianame: the paper type set for the tray */
  media?: string | null;
}

/** "REGULAR" → "Regular", "plain paper" → "Plain paper"; nothing for unknown or none */
export function mediaName(raw: string | null | undefined): string | undefined {
  // eslint-disable-next-line no-control-regex
  const v = (raw ?? '').replace(/[\u0000-\u001f]+/g, ' ').replace(/[_-]+/g, ' ').trim();
  if (!v || /^(unknown|none|other|auto|-?\d+)$/i.test(v)) { return undefined; }
  const lower = v === v.toUpperCase() ? v.toLowerCase() : v;
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

/** One tray from its name, current level and capacity; null for the "auto select" entry */
export function toTray(rawName: string, level: number | null, max: number | null, index: number, info: TrayInfo = {}): Tray | null {
  if (VIRTUAL.test(rawName.trim())) { return null; }
  const name = trayName(rawName, index);
  const availability = typeof info.status === 'number' && info.status >= 0 ? info.status & 7 : null;
  let percent: number | null = null;
  let state: TrayState = 'unknown';
  if (level === -3) {
    state = 'ok';
  } else if (level === 0 && availability === 5) {
    // An empty reading the printer itself calls unknown
    state = 'unknown';
  } else if (level === 0) {
    state = 'empty';
    percent = max !== null && max > 0 ? 0 : null;
  } else if (level !== null && level > 0) {
    percent = max !== null && max > 0 ? Math.max(0, Math.min(100, Math.round(level * 100 / max))) : null;
    state = percent !== null && percent <= LOW_TRAY_PERCENT ? 'low' : 'ok';
  }
  const capacity = max !== null && max > 0 ? max : null;
  // Only what doesn't change with the paper in it: name, size, a manual-feed type. (Not the
  // status: HP marks its bypass tray "on request", and a printer may mark an empty cassette so too.)
  const secondary = SECONDARY.test(name) || capacity === 1 || info.manual === true;
  const media = mediaName(info.media);
  return { name, key: keyOf(name), percent, state, capacity, secondary, ...(media ? { media } : {}) };
}

/**
 * Bypass trays that don't say so by name: HP calls its multipurpose tray "Tray 1",
 * and Fujifilm and Konica Minolta number theirs after the cassettes. A tray that
 * holds at most 200 sheets while another holds at least twice as many is one.
 */
function markSecondary(trays: Tray[]): Tray[] {
  const biggest = Math.max(0, ...trays.map((t) => t.capacity ?? 0));
  return trays.map((t) => (!t.secondary && t.capacity !== null && t.capacity <= 200 && biggest >= 2 * t.capacity
    ? { ...t, secondary: true } : t));
}

/** Trays from walked prtInputTable values: (column, index) → value */
export function traysFromTable(rows: { oid: string; value: unknown }[], table: string): Tray[] {
  const byIndex = new Map<string, { name?: string; level?: number; max?: number; type?: number; status?: number; media?: string }>();
  for (const { oid, value } of rows) {
    if (!oid.startsWith(`${table}.`)) { continue; }
    const [col, ...index] = oid.slice(table.length + 1).split('.');
    const key = index.join('.');
    const row = byIndex.get(key) ?? {};
    if (col === '2' && typeof value === 'number') { row.type = value; }
    if (col === '11' && typeof value === 'number') { row.status = value; }
    if (col === '9' && typeof value === 'number') { row.max = value; }
    if (col === '10' && typeof value === 'number') { row.level = value; }
    if (col === '12') { row.media = text(value); }
    if (col === '13') { row.name = text(value); }
    byIndex.set(key, row);
  }
  const order = (k: string): number[] => k.split('.').map(Number);
  return uniqueKeys([...byIndex.entries()]
    .sort(([a], [b]) => { const x = order(a); const y = order(b); return x[0] - y[0] || (x[1] ?? 0) - (y[1] ?? 0); })
    // Names may end in NULs or other control characters
    // eslint-disable-next-line no-control-regex
    .map(([, row], i) => toTray((row.name ?? '').replace(/[\u0000-\u001f]+/g, ' '), row.level ?? null, row.max ?? null, i + 1,
      { manual: row.type === 5, status: row.status ?? null, media: row.media }))
    .filter((t): t is Tray => t !== null));
}

/**
 * Trays from IPP's printer-input-tray values, one per tray:
 * "type=sheetFeedAutoRemovableTray;mediafeed=0;mediaxfeed=0;maxcapacity=250;level=-3;status=0;name=Tray 1;"
 */
export function traysFromIpp(values: unknown[]): Tray[] {
  return uniqueKeys(values.map((v, i) => {
    if (typeof v !== 'string') { return null; }
    const fields = Object.fromEntries(v.split(';').map((p) => {
      const at = p.indexOf('=');
      return at < 0 ? [p.trim().toLowerCase(), ''] : [p.slice(0, at).trim().toLowerCase(), p.slice(at + 1).trim()];
    }));
    const num = (k: string): number | null => (fields[k] !== undefined && fields[k] !== '' && Number.isFinite(Number(fields[k])) ? Number(fields[k]) : null);
    return toTray(fields.name ?? '', num('level'), num('maxcapacity'), i + 1,
      { manual: /^sheetfeedmanual$/i.test(fields.type ?? ''), status: num('status'), media: fields.medianame });
  }).filter((t): t is Tray => t !== null));
}

/** Two trays with the same name (rare) get numbered keys, so each keeps its own sensor */
function uniqueKeys(trays: Tray[]): Tray[] {
  const seen = new Map<string, number>();
  return markSecondary(trays).map((t) => {
    const n = (seen.get(t.key) ?? 0) + 1;
    seen.set(t.key, n);
    return n > 1 ? { ...t, key: `${t.key}-${n}` } : t;
  });
}
