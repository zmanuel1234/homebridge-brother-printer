import type { EventEmitter } from 'node:events';
import * as snmp from 'net-snmp';
import * as decode from './decode';
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
} as const;

export type OidName = keyof typeof OID;
export type RawReadings = Partial<Record<OidName, RawValue>>;
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
  state?: { version?: SnmpVersion };
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
  const state = options.state || {};
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

export function parse(raw: RawReadings): PrinterData {
  const charset = typeof raw.charset === 'number' ? raw.charset : Number(decode.decodeText(raw.charset)) || null;
  const statusText = decode.decodeText(raw.statusText, charset);
  const printerStatus = typeof raw.printerStatus === 'number' ? raw.printerStatus : null;
  const errors = decode.decodeErrorState(raw.errorState);

  const deviceId = decode.decodeText(raw.deviceId);
  const model = decode.decodeText(raw.model) || decode.modelFromDeviceId(deviceId) || '';
  const maint = decode.decodeMaintenance(raw.maintenance, raw.nextCare);
  const counters = decode.decodeCounters(raw.counters);
  const supplies = decode.supplyList(maint.supplies);
  const type = decode.printerType(model, maint, deviceId);
  const pageCount = typeof raw.pageCount === 'number' ? raw.pageCount : null;

  // Inkjets have no drum; their 0x41 record means something else
  if (type === 'ink') { maint.drums = {}; }

  // Lowest supply; when coarse levels tie (they move in 10% steps), the finer
  // reading decides, so a 2% yellow beats a 10% cyan
  const rank = (s: Supply): [number, number] => [s.level, s.fine ?? s.level];
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
    serial: decode.decodeText(raw.serial) || decode.decodeText(raw.brSerial) || null,
    type,
    statusText,
    printerStatus,
    errors,
    ...decode.summarizeStatus({ statusText, printerStatus, errors }),
    supplies,
    lowestSupply: lowest,
    drums: maint.drums,
    parts: maint.parts,
    totalPages: counters.totalPages ?? pageCount ?? sumPages(counters),
    colorPages: counters.colorPages ?? null,
    duplexPages: counters.duplexPages ?? null,
    tonerPercent: supplies.find((s) => s.color === 'black')?.level ?? null,
    tonerPercentFine: supplies.find((s) => s.color === 'black')?.fine ?? null,
    drumPercent: black.percent ?? null,
    drumPagesUsed: black.pagesUsed ?? null,
    drumPagesRemaining: black.pagesRemaining ?? null,
    unknown: maint.unknown,
  };
}
