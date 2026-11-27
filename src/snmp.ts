import type { EventEmitter } from 'node:events';
import * as snmp from 'net-snmp';
import * as decode from './decode';
import { manufacturerOf, mapMarkers } from './markers';
import type { Marker } from './markers';
import { traysFromTable } from './trays';
import type { Tray } from './trays';
import type { Color, Drum, Part, PartKey, PrinterError, PrinterType, RawValue, StatusSummary, Supply } from './decode';

export const OID = {
  maintenance: '1.3.6.1.4.1.2435.2.3.9.4.2.1.5.5.8.0', // brInfoMaintenance
  counters: '1.3.6.1.4.1.2435.2.3.9.4.2.1.5.5.10.0', // brInfoCounter
  nextCare: '1.3.6.1.4.1.2435.2.3.9.4.2.1.5.5.11.0', // brInfoNextCare
  statusText: '1.3.6.1.4.1.2435.2.3.9.4.2.1.5.4.5.2.0', // LCD status line
  deviceId: '1.3.6.1.4.1.2435.2.3.9.1.1.7.0', // PJL device ID (MDL:...)
  brSerial: '1.3.6.1.4.1.2435.2.3.9.4.2.1.5.5.1.0', // brInfoSerialNumber
  model: '1.3.6.1.2.1.25.3.2.1.3.1', // hrDeviceDescr
  serial: '1.3.6.1.2.1.43.5.1.1.17.1', // prtGeneralSerialNumber
  charset: '1.3.6.1.2.1.43.7.1.1.4.1.1', // prtLocalizationCharacterSet
  pageCount: '1.3.6.1.2.1.43.10.2.1.4.1.1', // prtMarkerLifeCount
  printerStatus: '1.3.6.1.2.1.25.3.5.1.1.1', // hrPrinterStatus
  errorState: '1.3.6.1.2.1.25.3.5.1.2.1', // hrPrinterDetectedErrorState
  sysDescr: '1.3.6.1.2.1.1.1.0', // the device's own description, a fallback for the model
} as const;

/** Printer MIB (RFC 3805): every printer's supplies, read when there are no Brother records */
export const SUPPLIES_TABLE = '1.3.6.1.2.1.43.11.1.1'; // prtMarkerSuppliesEntry
export const COLORANT_VALUES = '1.3.6.1.2.1.43.12.1.1.4'; // prtMarkerColorantValue
const COLUMN = { colorant: 3, type: 5, name: 6, max: 8, level: 9 } as const;
/** Printer MIB input table (prtInputEntry): paper trays; type 2, max capacity 9, current level 10, status 11, name 13 */
export const INPUT_TABLE = '1.3.6.1.2.1.43.8.2.1';
// Name and level first: without them there's nothing to show
const TRAY_COLUMNS = [13, 10, 9, 2, 11];
const REQUIRED_TRAY_COLUMNS = [10, 13];
/** prtMarkerSuppliesTypeTC as keywords (the same words IPP uses) */
const SUPPLY_TYPES: Record<number, string> = {
  1: 'other', 2: 'unknown', 3: 'toner', 4: 'waste-toner', 5: 'ink', 6: 'ink-cartridge', 7: 'ink-ribbon', 8: 'waste-ink',
  9: 'opc', 10: 'developer', 11: 'fuser-oil', 12: 'solid-wax', 13: 'ribbon-wax', 14: 'waste-wax', 15: 'fuser',
  16: 'corona-wire', 17: 'fuser-oil-wick', 18: 'cleaner-unit', 19: 'fuser-cleaning-pad', 20: 'transfer-unit',
  21: 'toner-cartridge', 22: 'fuser-oiler', 32: 'staples',
};
/** At most this many table entries are read, however big the table */
const MAX_ROWS = 64;

export type OidName = keyof typeof OID;
export type RawReadings = Partial<Record<OidName, RawValue>> & {
  /** Printer MIB supplies, when read */
  markers?: Marker[];
  /** The supplies table has been read before but couldn't be read this time */
  suppliesUnread?: boolean;
  /** Printer MIB input table rows, when read */
  trays?: { oid: string; value: unknown }[];
};
export type SnmpVersion = '1' | '2c' | '3';

export const AUTH_PROTOCOLS = ['none', 'md5', 'sha', 'sha224', 'sha256', 'sha384', 'sha512'] as const;
export const PRIV_PROTOCOLS = ['none', 'des', 'aes', 'aes256b', 'aes256r'] as const;
export type AuthProtocol = typeof AUTH_PROTOCOLS[number];
export type PrivProtocol = typeof PRIV_PROTOCOLS[number];

/** SNMPv3 user. The security level follows from which protocols are set. */
export interface V3User {
  user: string;
  authProtocol?: AuthProtocol;
  authPassword?: string;
  privProtocol?: PrivProtocol;
  privPassword?: string;
  /** SNMPv3 context name; empty unless the printer has one set */
  context?: string;
}

const ALIASES: Record<string, string> = { sha1: 'sha', aes128: 'aes' };

/**
 * A protocol setting as typed by a user ("SHA-256", "aes128", ...): unset gives the
 * default, anything not supported throws, so it can't fail later as "can't reach".
 */
export function protocolSetting<T extends string>(value: unknown, allowed: readonly T[], def: T, what: string): T {
  if (value === undefined || value === null || String(value).trim() === '') { return def; }
  const key = String(value).trim().toLowerCase().replace(/[-_\s]/g, '');
  const name = ALIASES[key] ?? key;
  if ((allowed as readonly string[]).includes(name)) { return name as T; }
  throw new Error(`SNMPv3 ${what} "${String(value)}" isn't supported; use one of ${allowed.join(', ')}`);
}

/** How the plugin reads the printer: SNMP (the default), IPP, or SNMP with IPP when SNMP doesn't answer */
export type ReadProtocol = 'snmp' | 'ipp' | 'auto';

export interface QueryOptions {
  host: string;
  protocol?: ReadProtocol;
  /** IPP address; the default is ipp://<host>:631/ipp/print */
  ippUrl?: string;
  /** Over ipps://, accept a certificate that can't be verified (the printer's self-signed one) */
  ippAllowSelfSigned?: boolean;
  port?: number;
  community?: string;
  timeout?: number;
  retries?: number;
  /** '2c', '1', '3' or 'auto' (default: v2c, then v1) */
  version?: SnmpVersion | 'auto';
  /** Needed for version '3' */
  v3?: V3User;
  /** Remembers which SNMP version worked, across polls */
  state?: { version?: SnmpVersion; suppliesRead?: boolean; noBulk?: boolean };
  /**
   * Read the paper trays on every poll (for tray sensors and the settings test).
   * Without it they're read only while the printer reports paper low or out, to say which tray.
   */
  trays?: boolean;
}

export interface PrinterData extends StatusSummary {
  model: string | null;
  /** "Brother" over SNMP; over IPP whatever the printer says */
  manufacturer?: string | null;
  serial: string | null;
  type: PrinterType;
  statusText: string;
  printerStatus: number | null;
  errors: PrinterError[];
  supplies: Supply[];
  lowestSupply: Supply | null;
  drums: Partial<Record<Color, Drum>>;
  parts: Partial<Record<PartKey, Part>>;
  totalPages: number | null;
  colorPages: number | null;
  duplexPages: number | null;
  // Kept for the mono-laser view and the probe
  tonerPercent: number | null;
  tonerPercentFine: number | null;
  drumPercent: number | null;
  drumPagesUsed: number | null;
  drumPagesRemaining: number | null;
  unknown: Record<string, number>;
  /**
   * The printer answered, but its supplies table (read before) couldn't be read this
   * time: supplies, drums and parts are missing from this reading, not gone
   */
  suppliesUnread?: boolean;
  /** Paper trays, when read; undefined when not read this time */
  trays?: Tray[];
  /** The printer's firmware version as it gives it over IPP ("01.35", "SWP1FN1514BR"), when it does */
  firmware?: string | null;
}

export interface QueryResult extends PrinterData {
  /** The SNMP version that answered; null when read over IPP */
  snmpVersion: SnmpVersion | null;
  /** Set when the reading came over IPP */
  via?: 'ipp';
}

/** "SNMP v2c" or "IPP", for the log and the settings screen */
export function readVia(d: QueryResult): string {
  return d.via === 'ipp' ? 'IPP' : `SNMP v${d.snmpVersion}`;
}

const NAMES = Object.keys(OID) as OidName[];
const VERSIONS = { '2c': snmp.Version2c, 1: snmp.Version1 } as const;

/** net-snmp's user for a v3 session; throws on settings that can't work */
export function v3User(v3: V3User | undefined): snmp.User {
  if (!v3 || !v3.user) { throw new Error('SNMPv3 needs a user name'); }
  const auth = v3.authProtocol && v3.authProtocol !== 'none' ? v3.authProtocol : null;
  const priv = v3.privProtocol && v3.privProtocol !== 'none' ? v3.privProtocol : null;
  if (priv && !auth) { throw new Error('SNMPv3 encryption (privacy) also needs authentication'); }
  // Keys shorter than 8 characters are refused by SNMPv3 (RFC 3414)
  if (auth && (v3.authPassword || '').length < 8) { throw new Error('SNMPv3 authentication password must be at least 8 characters'); }
  if (priv && (v3.privPassword || '').length < 8) { throw new Error('SNMPv3 privacy password must be at least 8 characters'); }
  const user: snmp.User = {
    name: v3.user,
    level: priv ? snmp.SecurityLevel.authPriv : auth ? snmp.SecurityLevel.authNoPriv : snmp.SecurityLevel.noAuthNoPriv,
  };
  if (auth) {
    user.authProtocol = snmp.AuthProtocols[auth];
    user.authKey = v3.authPassword;
  }
  if (priv) {
    user.privProtocol = snmp.PrivProtocols[priv];
    user.privKey = v3.privPassword;
  }
  return user;
}

/** All values under an OID (GETBULK on v2c/v3, GETNEXT on v1), up to a limit */
/**
 * Walk a table column. With v2c and v3, net-snmp asks for many rows at once (GETBULK);
 * some printers never answer that (Brother's MFC-L2750DW), though they answer one row at
 * a time. So a bulk walk that times out is tried again row by row, and once that works,
 * the printer is read row by row from then on (state.noBulk).
 */
export async function subtree(session: snmp.Session, oid: string, limit: number,
  state: NonNullable<QueryOptions['state']> = {}): Promise<snmp.Varbind[]> {
  // v1 has no bulk requests (net-snmp walks it row by row anyway)
  if (state.noBulk || (session as unknown as { version?: number }).version === snmp.Version1) { return nextWalk(session, oid, limit); }
  try {
    return await bulkWalk(session, oid, limit);
  } catch (err) {
    if (!isTimeout(err)) { throw err; }
    const rows = await nextWalk(session, oid, limit);
    state.noBulk = true;
    return rows;
  }
}

const isTimeout = (err: unknown): boolean => /time(d)? ?out/i.test((err as Error)?.message ?? '');

function bulkWalk(session: snmp.Session, oid: string, limit: number): Promise<snmp.Varbind[]> {
  return new Promise((resolve, reject) => {
    const out: snmp.Varbind[] = [];
    session.subtree(oid, 20, (varbinds) => {
      for (const vb of varbinds) { if (!snmp.isVarbindError(vb)) { out.push(vb); } }
      return out.length >= limit; // true stops the walk
    }, (err) => (err ? reject(err) : resolve(out)));
  });
}

/** Row by row (GETNEXT), until the column ends or `limit` rows */
async function nextWalk(session: snmp.Session, oid: string, limit: number): Promise<snmp.Varbind[]> {
  const out: snmp.Varbind[] = [];
  let at = oid;
  while (out.length < limit) {
    let vb: snmp.Varbind | undefined;
    try {
      vb = (await new Promise<snmp.Varbind[]>((resolve, reject) => {
        session.getNext([at], (err, varbinds) => (err ? reject(err) : resolve(varbinds ?? [])));
      }))[0];
    } catch (err) {
      // v1 ends a walk with noSuchName
      if (/NoSuchName/i.test((err as Error)?.message ?? '')) { break; }
      throw err;
    }
    // The column's end, or an agent that doesn't move on (same OID again)
    if (!vb || snmp.isVarbindError(vb) || !vb.oid.startsWith(`${oid}.`) || vb.oid === at) { break; }
    out.push(vb);
    at = vb.oid;
  }
  return out;
}

const clean = (v: unknown): string => (Buffer.isBuffer(v) ? v.toString('utf8') : v === null || v === undefined ? '' : String(v))
  // Some printers end names with NULs or pad them; keep printable text
  // eslint-disable-next-line no-control-regex
  .replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();

/** The Printer MIB supplies table as markers, from walked values */
export function suppliesFromVarbinds(rows: { oid: string; value: unknown }[], colorants: { oid: string; value: unknown }[],
  charset: number | null = null): Marker[] {
  // Names: valid UTF-8 as such, else the printer's character set (prtLocalizationCharacterSet),
  // as for its display text, else Latin-1
  const utf8 = new TextDecoder('utf-8', { fatal: true });
  const text = (v: unknown): string => {
    if (!Buffer.isBuffer(v)) { return clean(v); }
    // Valid UTF-8 first: many printers declare US-ASCII or HP Roman8 whatever they send,
    // and text in a single-byte set (é as 0xE9) is almost never valid UTF-8
    try { return clean(utf8.decode(v)); } catch { return decode.decodeText(v, charset); }
  };
  const byIndex = new Map<string, Partial<Record<keyof typeof COLUMN, unknown>>>();
  const columns = Object.entries(COLUMN) as [keyof typeof COLUMN, number][];
  for (const { oid, value } of rows) {
    if (!oid.startsWith(`${SUPPLIES_TABLE}.`)) { continue; }
    const [col, ...index] = oid.slice(SUPPLIES_TABLE.length + 1).split('.');
    const name = columns.find(([, n]) => n === Number(col))?.[0];
    if (!name) { continue; }
    const key = index.join('.');
    const row = byIndex.get(key) ?? {};
    row[name] = value;
    byIndex.set(key, row);
  }
  // prtMarkerColorantValue, indexed by hrDeviceIndex.colorantIndex
  const colorant = new Map(colorants.map(({ oid, value }) => [oid.slice(COLORANT_VALUES.length + 1), text(value)]));
  const order = (k: string): number[] => k.split('.').map(Number);
  return [...byIndex.entries()]
    .sort(([a], [b]) => { const x = order(a); const y = order(b); return x[0] - y[0] || x[1] - y[1]; })
    .map(([key, row]) => {
      const num = (v: unknown): number | null => (typeof v === 'number' ? v : null);
      const device = key.split('.')[0];
      const type = num(row.type);
      return {
        name: text(row.name),
        type: type !== null ? SUPPLY_TYPES[type] ?? 'other' : '',
        colors: num(row.colorant) ? colorant.get(`${device}.${row.colorant as number}`) ?? '' : '',
        level: num(row.level),
        high: num(row.max),
      };
    })
    .filter((m) => m.name || m.level !== null);
}

/**
 * Read the Printer MIB supplies: only the columns used, and the colorant names
 * only when a supply refers to one. An empty list when the printer has no table.
 * A walk that fails once the table has been read before gives null: the supplies
 * are unknown this time, not gone (a lost packet mustn't take sensors away, and a
 * printer that answers everything else isn't offline); a printer whose table never
 * reads is treated as having none.
 */
export async function readSupplies(session: snmp.Session, charset: number | null, state: NonNullable<QueryOptions['state']>): Promise<Marker[] | null> {
  try {
    const rows: snmp.Varbind[] = [];
    for (const col of Object.values(COLUMN)) { rows.push(...await subtree(session, `${SUPPLIES_TABLE}.${col}`, MAX_ROWS, state)); }
    const wantsColorant = rows.some((vb) => vb.oid.startsWith(`${SUPPLIES_TABLE}.${COLUMN.colorant}.`) && typeof vb.value === 'number' && vb.value > 0);
    // Colors may come only from here (supplies named by part number), so once supplies have been
    // read a failure counts like the walk's; before that, carry on without the colorant names
    const colorants = !wantsColorant ? []
      : await subtree(session, COLORANT_VALUES, MAX_ROWS, state).catch((err: unknown) => { if (state.suppliesRead) { throw err; } return []; });
    const markers = suppliesFromVarbinds(rows.map((vb) => ({ oid: vb.oid, value: vb.value })),
      colorants.map((vb) => ({ oid: vb.oid, value: vb.value })), charset).slice(0, MAX_ROWS);
    if (markers.length) { state.suppliesRead = true; }
    return markers;
  } catch {
    return state.suppliesRead ? null : [];
  }
}

/**
 * The paper trays' rows (only the columns used), each column on its own: a printer that
 * refuses the type, capacity or status column still gives its trays. Without the names
 * or the levels there's nothing reliable to show, and a timeout stops the read (rather
 * than waiting on every column): both give undefined. Never fails the poll.
 */
export async function readTrays(session: snmp.Session, state: NonNullable<QueryOptions['state']> = {}): Promise<{ oid: string; value: unknown }[] | undefined> {
  const rows: { oid: string; value: unknown }[] = [];
  for (const col of TRAY_COLUMNS) {
    try {
      rows.push(...(await subtree(session, `${INPUT_TABLE}.${col}`, 32, state)).map((vb) => ({ oid: vb.oid, value: vb.value })));
    } catch (err) {
      if (REQUIRED_TRAY_COLUMNS.includes(col) || isTimeout(err)) { return undefined; }
    }
  }
  return rows;
}

function get(session: snmp.Session, oids: string[]): Promise<snmp.Varbind[]> {
  return new Promise((resolve, reject) => {
    session.get(oids, (err, varbinds) => (err ? reject(err) : resolve(varbinds || [])));
  });
}

/**
 * One request. Under SNMP v1 an OID the printer doesn't have fails the whole
 * request (noSuchName), so that OID is dropped and the request repeated.
 */
async function getAll(options: QueryOptions, version: SnmpVersion): Promise<RawReadings> {
  const common = {
    port: options.port || 161,
    timeout: options.timeout ?? 5000,
    retries: options.retries ?? 1,
    idBitsSize: 32 as const,
  };
  const session = version === '3'
    ? snmp.createV3Session(options.host, v3User(options.v3), {
      ...common, version: snmp.Version3, ...(options.v3?.context ? { context: options.v3.context } : {}),
    })
    : snmp.createSession(options.host, options.community || 'public', { ...common, version: VERSIONS[version] });
  (session as unknown as EventEmitter).on('error', () => { /* surfaced through the request callback */ });

  const names = [...NAMES];
  const raw: RawReadings = {};
  try {
    while (names.length) {
      try {
        const varbinds = await get(session, names.map((n) => OID[n]));
        varbinds.forEach((vb, idx) => {
          raw[names[idx]] = snmp.isVarbindError(vb) ? null : vb.value as RawValue;
        });
        // Not a Brother printer, or one whose records have no levels: the standard supplies table
        const brother = decode.supplyList(decode.decodeMaintenance(raw.maintenance, raw.nextCare).supplies);
        if (!brother.length) {
          const charset = typeof raw.charset === 'number' ? raw.charset : Number(decode.decodeText(raw.charset)) || null;
          const markers = await readSupplies(session, charset, options.state ||= {});
          if (markers) { raw.markers = markers; } else { raw.suppliesUnread = true; }
        }
        // Paper trays: when asked, or to say which tray is empty or low
        const paper = decode.decodeErrorState(raw.errorState).some((e) => e === 'noPaper' || e === 'lowPaper' || e === 'inputTrayEmpty');
        if (options.trays || paper) { raw.trays = await readTrays(session, options.state ||= {}); }
        return raw;
      } catch (err) {
        const e = err as Error | null;
        const missing = e && e.name === 'RequestFailedError' && /NoSuchName: ([\d.]+)/.exec(e.message);
        const idx = missing ? names.findIndex((n) => OID[n] === missing[1]) : -1;
        if (idx < 0) { throw err; }
        raw[names[idx]] = null;
        names.splice(idx, 1);
      }
    }
    return raw;
  } finally {
    try { session.close(); } catch { /* already closed */ }
  }
}

/**
 * Query the printer once and return decoded values. Rejects only when the
 * printer can't be reached at all.
 *
 * options.version: '2c', '1' or 'auto' (default). With 'auto', v2c is tried
 * first and v1 when v2c gets no answer; options.state remembers which worked.
 */
export async function query(options: QueryOptions): Promise<QueryResult> {
  const state = (options.state ||= {});
  const wanted = options.version && options.version !== 'auto' ? [String(options.version) as SnmpVersion] : null;
  const order: SnmpVersion[] = wanted || (state.version ? [state.version] : ['2c', '1']);

  let lastErr: unknown;
  for (const version of order) {
    try {
      const raw = await getAll(options, version);
      state.version = version;
      return { ...parse(raw), snmpVersion: version };
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

/** Some inkjets only report mono and color page counts */
function sumPages(c: decode.Counters): number | null {
  return typeof c.monoPages === 'number' && typeof c.colorPages === 'number' ? c.monoPages + c.colorPages : null;
}

/**
 * The model: hrDeviceDescr, unless it's a generic driver name ("Generic 28C-1")
 * and the device's description names the printer ("KONICA MINOLTA bizhub
 * C3110", "RICOH MP C2503 1.35 / RICOH Network Printer…", or a print server
 * "… Attached to MC873 …").
 */
export function modelOf(descr: string, sysDescr: string): string {
  const attached = /attached to\s+([\w-]+)/i.exec(sysDescr)?.[1];
  const fromSys = attached
    ?? (/jetdirect|ethernet|ROM |print(ing)? (server|system)|zebranet/i.test(sysDescr) ? ''
      : sysDescr.split(/[;,]| \/ |\s+version\s/i)[0].replace(/\s+\d+(\.\d+)+$/, '').trim().slice(0, 60));
  if (!descr || /^generic\b/i.test(descr)) { return fromSys || descr; }
  return descr;
}

export function parse(raw: RawReadings): PrinterData {
  const charset = typeof raw.charset === 'number' ? raw.charset : Number(decode.decodeText(raw.charset)) || null;
  const statusText = decode.decodeText(raw.statusText, charset);
  const printerStatus = typeof raw.printerStatus === 'number' ? raw.printerStatus : null;
  const errors = decode.decodeErrorState(raw.errorState);

  const deviceId = decode.decodeText(raw.deviceId);
  const sysDescr = decode.decodeText(raw.sysDescr) || '';
  const model = modelOf(decode.decodeText(raw.model) || decode.modelFromDeviceId(deviceId) || '', sysDescr);
  const maint = decode.decodeMaintenance(raw.maintenance, raw.nextCare);
  const counters = decode.decodeCounters(raw.counters);
  const brotherSupplies = decode.supplyList(maint.supplies);
  // Without Brother's records: the standard supplies table (any make of printer)
  const mib = !brotherSupplies.length && raw.markers?.length ? mapMarkers(raw.markers) : null;
  const supplies = mib ? mib.supplies : brotherSupplies;
  const type = mib?.ink ? 'ink' : mib?.toner ? 'laser' : decode.printerType(model, maint, deviceId);
  const mfg = /(?:^|;)\s*(?:MFG|MANUFACTURER):([^;]+)/i.exec(deviceId)?.[1]?.trim() ?? '';
  const isBrother = brotherSupplies.length > 0 || /brother/i.test(`${mfg} ${model}`);
  // null for a maker the plugin can't name: Home then shows "Printer", never Brother
  const manufacturer = isBrother ? 'Brother' : manufacturerOf(mfg, model) ?? manufacturerOf('', sysDescr);
  const pageCount = typeof raw.pageCount === 'number' ? raw.pageCount : null;

  // Inkjets have no drum; their 0x41 record means something else
  if (type === 'ink') { maint.drums = {}; }

  // Lowest supply; when coarse levels tie (they move in 10% steps), the finer
  // reading decides, so a 2% yellow beats a 10% cyan
  const rank = (s: Supply): [number, number] => [s.level, s.fine ?? s.level];
  if (mib && !Object.keys(maint.drums).length) { maint.drums = mib.drums; }
  const parts = { ...mib?.parts, ...maint.parts };
  const lowest = supplies.length
    ? supplies.reduce((a, b) => {
      const [al, af] = rank(a);
      const [bl, bf] = rank(b);
      return bl < al || (bl === al && bf < af) ? b : a;
    })
    : null;
  const black: Drum = maint.drums.black || {};

  return {
    model: model || null,
    manufacturer,
    serial: decode.decodeText(raw.serial) || decode.decodeText(raw.brSerial) || null,
    type,
    statusText,
    printerStatus,
    errors,
    ...decode.summarizeStatus({ statusText, printerStatus, errors }),
    supplies,
    lowestSupply: lowest,
    drums: maint.drums,
    parts,
    totalPages: counters.totalPages ?? pageCount ?? sumPages(counters),
    colorPages: counters.colorPages ?? null,
    duplexPages: counters.duplexPages ?? null,
    tonerPercent: supplies.find((s) => s.color === 'black')?.level ?? null,
    tonerPercentFine: supplies.find((s) => s.color === 'black')?.fine ?? null,
    drumPercent: black.percent ?? null,
    drumPagesUsed: black.pagesUsed ?? null,
    drumPagesRemaining: black.pagesRemaining ?? null,
    unknown: maint.unknown,
    ...(raw.suppliesUnread ? { suppliesUnread: true } : {}),
    ...(raw.trays ? { trays: traysFromTable(raw.trays, INPUT_TABLE) } : {}),
  };
}
