/**
 * Brother printers pack maintenance data into OctetString "blobs" of records:
 *   [code(1)] [0x01] [length(1)] [value(length bytes, big-endian)]
 * terminated by 0xFF. Older models use length 2 with [current][max], read as
 * current / max %.
 *
 * Record codes follow the bieniu/brother library (Apache-2.0), which Home
 * Assistant's Brother integration uses, and were checked against a real
 * MFC-L2750DW.
 */

export const COLORS = ['black', 'cyan', 'magenta', 'yellow'] as const;
export type Color = typeof COLORS[number];

export type PartKey = 'belt' | 'fuser' | 'laser' | 'paperFeedMP' | 'paperFeed1' | 'inkWasteBox';
export type PrinterType = 'laser' | 'ink';

/** Raw SNMP value as net-snmp or a capture gives it */
export type RawValue = Buffer | string | string[] | number | null | undefined;

export interface SupplyReading {
  level: number | null;
  fine: number | null;
  status: number | null;
}

export interface Supply {
  color: Color;
  level: number;
  fine: number | null;
}

export interface Drum {
  percent?: number;
  pagesUsed?: number;
  pagesRemaining?: number;
}

export interface Part {
  percent?: number;
  pagesRemaining?: number;
}

export interface Maintenance {
  supplies: Record<Color, SupplyReading>;
  drums: Partial<Record<Color, Drum>>;
  parts: Partial<Record<PartKey, Part>>;
  misc: { legacy?: boolean; drumStatus?: number };
  unknown: Record<string, number>;
}

export interface Counters {
  totalPages?: number;
  monoPages?: number;
  colorPages?: number;
  duplexPages?: number;
}

export interface ParsedRecord {
  code: number;
  value: number;
  legacy: boolean;
  len: number;
}

type MaintenanceDef =
  | { group: 'level' | 'fine' | 'supplyStatus' | 'drum' | 'drumPagesUsed'; color: Color; percent?: boolean }
  | { group: 'parts'; key: PartKey; percent?: boolean }
  | { group: 'misc'; key: 'drumStatus'; percent?: boolean };

// Maintenance blob (brInfoMaintenance)
const MAINTENANCE: Record<number, MaintenanceDef> = {
  0x81: { group: 'level', color: 'black' },
  0x82: { group: 'level', color: 'cyan' },
  0x83: { group: 'level', color: 'magenta' },
  0x84: { group: 'level', color: 'yellow' },
  0x6f: { group: 'fine', color: 'black', percent: true },
  0x70: { group: 'fine', color: 'cyan', percent: true },
  0x71: { group: 'fine', color: 'magenta', percent: true },
  0x72: { group: 'fine', color: 'yellow', percent: true },
  0xa1: { group: 'fine', color: 'black', percent: true },
  0xa2: { group: 'fine', color: 'cyan', percent: true },
  0xa3: { group: 'fine', color: 'magenta', percent: true },
  0xa4: { group: 'fine', color: 'yellow', percent: true },
  0x31: { group: 'supplyStatus', color: 'black' },
  0x32: { group: 'supplyStatus', color: 'cyan' },
  0x33: { group: 'supplyStatus', color: 'magenta' },
  0x34: { group: 'supplyStatus', color: 'yellow' },
  0x41: { group: 'drum', color: 'black', percent: true },
  0x80: { group: 'drum', color: 'black', percent: true },
  0x79: { group: 'drum', color: 'cyan', percent: true },
  0x7a: { group: 'drum', color: 'magenta', percent: true },
  0x7b: { group: 'drum', color: 'yellow', percent: true },
  0x11: { group: 'drumPagesUsed', color: 'black' },
  0x7e: { group: 'drumPagesUsed', color: 'black' },
  0x73: { group: 'drumPagesUsed', color: 'cyan' },
  0x74: { group: 'drumPagesUsed', color: 'magenta' },
  0x75: { group: 'drumPagesUsed', color: 'yellow' },
  0x63: { group: 'misc', key: 'drumStatus' },
  0x69: { group: 'parts', key: 'belt', percent: true },
  0x6a: { group: 'parts', key: 'fuser', percent: true },
  0x6b: { group: 'parts', key: 'laser', percent: true },
  0x6c: { group: 'parts', key: 'paperFeedMP', percent: true },
  0x6d: { group: 'parts', key: 'paperFeed1', percent: true },
  0x85: { group: 'parts', key: 'inkWasteBox' },
};

// Counter blob (brInfoCounter)
const COUNTERS: Record<number, keyof Counters> = {
  0x00: 'totalPages',
  0x01: 'monoPages',
  0x02: 'colorPages',
  0x06: 'duplexPages',
};

type NextCareDef =
  | { group: 'drumPagesRemaining'; color: Color }
  | { group: 'partPagesRemaining'; key: PartKey };

// Next-care blob (brInfoNextCare), laser only: pages left
const NEXT_CARE: Record<number, NextCareDef> = {
  0x82: { group: 'drumPagesRemaining', color: 'black' },
  0xa4: { group: 'drumPagesRemaining', color: 'black' },
  0xa5: { group: 'drumPagesRemaining', color: 'cyan' },
  0xa6: { group: 'drumPagesRemaining', color: 'magenta' },
  0xa7: { group: 'drumPagesRemaining', color: 'yellow' },
  0x73: { group: 'partPagesRemaining', key: 'laser' },
  0x77: { group: 'partPagesRemaining', key: 'paperFeed1' },
  0x86: { group: 'partPagesRemaining', key: 'paperFeedMP' },
  0x88: { group: 'partPagesRemaining', key: 'belt' },
  0x89: { group: 'partPagesRemaining', key: 'fuser' },
};

export function toBuffer(value: RawValue): Buffer | null {
  if (value === null || value === undefined) { return null; }
  if (Buffer.isBuffer(value)) { return value; }
  if (Array.isArray(value)) { return toBuffer(value.join('')); }
  if (typeof value === 'string') {
    const hex = value.replace(/[^0-9a-f]/gi, '');
    if (hex.length && hex.length % 2 === 0) { return Buffer.from(hex, 'hex'); }
  }
  return null;
}

/** Parse a Brother record blob into [{ code, value, legacy }] */
export function parseRecords(input: RawValue): ParsedRecord[] {
  const buf = toBuffer(input);
  const records: ParsedRecord[] = [];
  if (!buf) { return records; }

  let i = 0;
  while (i < buf.length) {
    const code = buf[i];
    if (code === 0xff) { break; }
    if (i + 3 > buf.length) { break; }
    const len = buf[i + 2];
    const start = i + 3;
    const end = start + len;
    if (end > buf.length || len === 0 || len > 6) { break; }

    if (len === 2) {
      // Legacy format: [current][max]
      const [cur, max] = [buf[start], buf[start + 1]];
      if (max > 0) { records.push({ code, value: Math.round((cur / max) * 100), legacy: true, len }); }
    } else {
      let value = 0;
      for (let j = start; j < end; j++) { value = value * 256 + buf[j]; }
      records.push({ code, value, legacy: false, len });
    }
    i = end;
  }
  return records;
}

// Percent records are hundredths of a % in 4-byte form; short records with a
// percent code (seen on old models) aren't levels, so they're skipped.
const pct = (rec: ParsedRecord, def: MaintenanceDef): number | null => {
  if (!def.percent || rec.legacy) { return rec.value; }
  return rec.len >= 4 ? Math.round(rec.value / 100) : null;
};
const finite = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function emptySupplies(): Record<Color, SupplyReading> {
  return Object.fromEntries(COLORS.map((c) => [c, { level: null, fine: null, status: null }])) as Record<Color, SupplyReading>;
}

/** Decode the maintenance and next-care blobs */
export function decodeMaintenance(maintenance: RawValue, nextCare?: RawValue): Maintenance {
  const supplies = emptySupplies();
  const drums: Maintenance['drums'] = {};
  const parts: Maintenance['parts'] = {};
  const misc: Maintenance['misc'] = {};
  const unknown: Record<string, number> = {};

  for (const rec of parseRecords(maintenance)) {
    if (rec.legacy) { misc.legacy = true; }
    const def = MAINTENANCE[rec.code];
    if (!def) {
      unknown[`0x${rec.code.toString(16).padStart(2, '0')}`] = rec.value;
      continue;
    }
    const v = pct(rec, def);
    if (v === null) { continue; }
    switch (def.group) {
      case 'level':
        supplies[def.color].level = v;
        break;
      case 'fine':
        supplies[def.color].fine = v;
        break;
      case 'supplyStatus':
        supplies[def.color].status = v;
        break;
      case 'drum':
        (drums[def.color] = drums[def.color] || {}).percent = v;
        break;
      case 'drumPagesUsed':
        (drums[def.color] = drums[def.color] || {}).pagesUsed = v;
        break;
      case 'parts':
        (parts[def.key] = parts[def.key] || {}).percent = v;
        break;
      default:
        misc[def.key] = v;
    }
  }

  for (const rec of parseRecords(nextCare)) {
    const def = NEXT_CARE[rec.code];
    if (!def) { continue; }
    if (def.group === 'drumPagesRemaining') {
      (drums[def.color] = drums[def.color] || {}).pagesRemaining = rec.value;
    } else {
      (parts[def.key] = parts[def.key] || {}).pagesRemaining = rec.value;
    }
  }

  // Drum entries that only carry a page count aren't useful on their own
  for (const [color, d] of Object.entries(drums) as [Color, Drum][]) {
    if (d.percent === undefined && d.pagesRemaining === undefined) { delete drums[color]; }
  }

  return { supplies, drums, parts, misc, unknown };
}

export function decodeCounters(input: RawValue): Counters {
  const out: Counters = {};
  for (const { code, value } of parseRecords(input)) {
    const key = COUNTERS[code];
    if (key) { out[key] = value; }
  }
  return out;
}

/** prtLocalizationCharacterSet (IANA MIBenum) to a TextDecoder label */
const CHARSETS: Record<number, string> = {
  3: 'ascii', 4: 'latin1', 5: 'iso-8859-2', 8: 'iso-8859-5', 12: 'iso-8859-9', 106: 'utf-8',
};

/** Decode an SNMP OctetString that holds text */
export function decodeText(input: RawValue, charset?: number | null): string {
  const buf = toBuffer(input);
  if (!buf) { return typeof input === 'string' ? input.trim() : ''; }
  let text: string;
  try {
    text = new TextDecoder((charset && CHARSETS[charset]) || 'latin1', { fatal: true }).decode(buf);
  } catch {
    text = buf.toString('latin1');
  }
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\x00-\x1f]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Model from the PJL device ID, e.g. "MFG:Brother;CMD:PJL;MDL:DCP-L3550CDW;CLS:PRINTER;" */
export function modelFromDeviceId(text: string | null | undefined): string | null {
  const m = /MDL:([^;]+)/.exec(text || '');
  return m ? m[1].trim() : null;
}

/** "laser" or "ink", from what the printer reports */
export function printerType(model: string | null | undefined, decoded: Maintenance | null | undefined,
  deviceId?: string | null): PrinterType {
  if (decoded && decoded.parts.inkWasteBox) { return 'ink'; }
  if (/CID:[^;]*Laser/i.test(deviceId || '')) { return 'laser'; }
  if (/\b(?:DCP|MFC|HL)-[JT]/i.test(model || '')) { return 'ink'; }
  // The current/max record format is only used by older inkjets
  if (decoded && decoded.misc.legacy) { return 'ink'; }
  return 'laser';
}

/** One entry per supply the printer reports a level for */
export function supplyList(supplies: Record<Color, SupplyReading>): Supply[] {
  const list: Supply[] = [];
  for (const color of COLORS) {
    const s = supplies[color];
    const level = finite(s.level) ?? finite(s.fine);
    if (level === null) { continue; }
    list.push({ color, level: Math.max(0, Math.min(100, level)), fine: finite(s.fine) });
  }
  return list;
}

/** hrPrinterDetectedErrorState bit names (RFC 3805 / RFC 2790) */
const ERROR_BITS = [
  'lowPaper', 'noPaper', 'lowToner', 'noToner',
  'doorOpen', 'jammed', 'offline', 'serviceRequested',
  'inputTrayMissing', 'outputTrayMissing', 'markerSupplyMissing', 'outputNearFull',
  'outputFull', 'inputTrayEmpty', 'overduePreventMaint',
] as const;
export type PrinterError = typeof ERROR_BITS[number];

export function decodeErrorState(input: RawValue): PrinterError[] {
  const buf = toBuffer(input);
  const errors: PrinterError[] = [];
  if (!buf) { return errors; }
  for (let bit = 0; bit < ERROR_BITS.length; bit++) {
    const byte = buf[bit >> 3];
    if (byte === undefined) { break; }
    if (byte & (0x80 >> (bit & 7))) { errors.push(ERROR_BITS[bit]); }
  }
  return errors;
}

/** Errors that stop the printer and deserve the Problem sensor */
const FAULT_ERRORS = new Set<PrinterError>([
  'noPaper', 'noToner', 'doorOpen', 'jammed', 'serviceRequested',
  'inputTrayMissing', 'outputTrayMissing', 'markerSupplyMissing', 'outputFull',
]);

// Display text is in the printer's language; English patterns are only a
// fallback for printers that don't set the error bits.
const FAULT_TEXT = /jam|cover is open|open|no paper|paper empty|replace|no toner|toner end|drum end|drum stop|error|call service|unable|cannot|no tray|size mismatch|out of memory/i;
const WARNING_TEXT = /\blow\b|end soon|soon/i;
const PRINTING_TEXT = /printing|receiving|copying/i;

export interface StatusSummary {
  printing: boolean;
  fault: boolean;
  faults: PrinterError[];
  sleeping: boolean;
}

/** hrPrinterStatus: 1 other, 2 unknown, 3 idle, 4 printing, 5 warmup */
export function summarizeStatus({ statusText = '', printerStatus = null, errors = [] }: {
  statusText?: string;
  printerStatus?: number | null;
  errors?: PrinterError[];
}): StatusSummary {
  const text = statusText || '';
  const faults = errors.filter((e) => FAULT_ERRORS.has(e));
  // "Toner Low" / "Drum End Soon" are warnings handled by the battery services
  const textFault = FAULT_TEXT.test(text) && !WARNING_TEXT.test(text);
  const printing = printerStatus === 4 || (PRINTING_TEXT.test(text) && !textFault);
  return {
    printing,
    fault: faults.length > 0 || textFault,
    faults,
    sleeping: /sleep/i.test(text),
  };
}
