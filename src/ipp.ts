/*
 * Reading a printer over IPP (AirPrint), as an option next to SNMP.
 *
 * One Get-Printer-Attributes request (RFC 8011) over HTTP, encoded and decoded
 * here with no extra library. The answer is mapped onto the same readings the
 * SNMP path gives, so the sensors work the same. IPP has less detail than
 * Brother's SNMP records: many Brother printers report toner only as "some
 * remaining" over IPP, and drum or parts life only if the printer lists them
 * as supplies.
 */
import http from 'node:http';
import https from 'node:https';
import { printerType, summarizeStatus } from './decode';
import type { Color, Drum, Part, PartKey, PrinterError, Supply } from './decode';
import type { PrinterData } from './snmp';

/* --------------------------------------------------------------- encoding */

export const TAG = {
  operation: 0x01, end: 0x03, printer: 0x04, unsupported: 0x05,
  integer: 0x21, boolean: 0x22, enum: 0x23, octetString: 0x30, begCollection: 0x34, endCollection: 0x37,
  text: 0x41, name: 0x42, keyword: 0x44, uri: 0x45, charset: 0x47, language: 0x48, memberName: 0x4a,
} as const;

export type IppValue = string | number | boolean | null;
export type IppAttributes = Record<string, IppValue[]>;

/** One attribute for an IPP message: a value tag, a name and its values */
export interface IppAttribute { tag: number; name: string; values: IppValue[] }

function encodeValue(tag: number, value: IppValue): Buffer {
  if (tag === TAG.integer || tag === TAG.enum) {
    const b = Buffer.alloc(4);
    b.writeInt32BE(Number(value));
    return b;
  }
  if (tag === TAG.boolean) { return Buffer.from([value ? 1 : 0]); }
  return Buffer.from(String(value), 'utf8');
}

/** Encode an IPP message: version 2.0, an operation or status code, attribute groups */
export function ippMessage(code: number, requestId: number, groups: { tag: number; attributes: IppAttribute[] }[]): Buffer {
  const parts: Buffer[] = [];
  const head = Buffer.alloc(8);
  head.writeUInt8(2, 0);
  head.writeUInt8(0, 1);
  head.writeUInt16BE(code, 2);
  head.writeUInt32BE(requestId, 4);
  parts.push(head);
  for (const group of groups) {
    parts.push(Buffer.from([group.tag]));
    for (const attr of group.attributes) {
      attr.values.forEach((value, i) => {
        const name = Buffer.from(i === 0 ? attr.name : '', 'utf8'); // further values have no name
        const data = encodeValue(attr.tag, value);
        const len = Buffer.alloc(2);
        parts.push(Buffer.from([attr.tag]));
        len.writeUInt16BE(name.length);
        parts.push(Buffer.from(len), name);
        len.writeUInt16BE(data.length);
        parts.push(Buffer.from(len), data);
      });
    }
  }
  parts.push(Buffer.from([TAG.end]));
  return Buffer.concat(parts);
}

/** What the plugin asks the printer for */
export const REQUESTED = [
  'printer-state', 'printer-state-reasons', 'printer-state-message', 'printer-make-and-model',
  'printer-device-id', 'printer-serial-number', 'printer-info', 'marker-names', 'marker-levels',
  'marker-high-levels', 'marker-low-levels', 'marker-types', 'marker-colors', 'printer-impressions-completed',
];

export function getPrinterAttributes(uri: string, requestId: number): Buffer {
  return ippMessage(0x000b, requestId, [{
    tag: TAG.operation,
    attributes: [
      { tag: TAG.charset, name: 'attributes-charset', values: ['utf-8'] },
      { tag: TAG.language, name: 'attributes-natural-language', values: ['en'] },
      { tag: TAG.uri, name: 'printer-uri', values: [uri] },
      { tag: TAG.keyword, name: 'requested-attributes', values: REQUESTED },
    ],
  }]);
}

/* --------------------------------------------------------------- decoding */

export interface IppResponse {
  status: number;
  requestId: number;
  /** The printer attributes group; collections are skipped */
  printer: IppAttributes;
}

/** Decode an IPP response. Throws on a message that's cut short or malformed. */
export function parseResponse(buf: Buffer): IppResponse {
  if (buf.length < 9) { throw new Error('IPP response too short'); }
  if (buf[0] < 1 || buf[0] > 2) { throw new Error(`Not an IPP response (version ${buf[0]}.${buf[1]})`); }
  const status = buf.readUInt16BE(2);
  const requestId = buf.readUInt32BE(4);
  const printer: IppAttributes = {};
  let group = 0;
  let last = '';
  let depth = 0; // inside a collection: values belong to its members, not kept
  let i = 8;
  const need = (n: number): void => { if (i + n > buf.length) { throw new Error('IPP response cut short'); } };
  for (;;) {
    need(1);
    const tag = buf[i++];
    if (tag === TAG.end) { break; }
    if (tag < 0x10) { group = tag; continue; } // a new attribute group
    need(2);
    const nameLen = buf.readUInt16BE(i); i += 2;
    need(nameLen);
    const name = buf.toString('utf8', i, i + nameLen); i += nameLen;
    need(2);
    const valueLen = buf.readUInt16BE(i); i += 2;
    need(valueLen);
    const data = buf.subarray(i, i + valueLen); i += valueLen;

    if (tag === TAG.begCollection) { if (depth === 0 && name) { last = name; } depth++; continue; }
    if (tag === TAG.endCollection) { depth = Math.max(0, depth - 1); continue; }
    if (depth > 0 || tag === TAG.memberName) { continue; }
    if (name) { last = name; }
    if (group !== TAG.printer || !last) { continue; }

    let value: IppValue;
    if ((tag === TAG.integer || tag === TAG.enum) && data.length === 4) {
      value = data.readInt32BE(0);
    } else if (tag === TAG.boolean && data.length === 1) {
      value = data[0] !== 0;
    } else if (tag === 0x35 || tag === 0x36) {
      // textWithLanguage / nameWithLanguage: language, then the text
      const langLen = data.length >= 2 ? data.readUInt16BE(0) : 0;
      const at = 2 + langLen;
      value = data.length >= at + 2 ? data.toString('utf8', at + 2, at + 2 + data.readUInt16BE(at)) : '';
    } else if (tag >= 0x40) {
      value = data.toString('utf8');
    } else {
      // unknown / no-value, dates, resolutions, ranges: kept as a gap, so that
      // marker-levels stays in step with marker-names
      value = null;
    }
    (printer[last] ||= []).push(value);
  }
  return { status, requestId, printer };
}

/* ---------------------------------------------------------------- mapping */

/** printer-state-reasons keywords (RFC 8011, PWG 5100.9) and what they mean here */
const REASONS: Record<string, PrinterError> = {
  'media-empty': 'noPaper', 'media-needed': 'noPaper', 'media-low': 'lowPaper',
  'toner-low': 'lowToner', 'marker-supply-low': 'lowToner', 'ink-low': 'lowToner',
  'toner-empty': 'noToner', 'marker-supply-empty': 'noToner', 'ink-empty': 'noToner',
  'door-open': 'doorOpen', 'cover-open': 'doorOpen', 'interlock-open': 'doorOpen',
  'media-jam': 'jammed',
  'input-tray-missing': 'inputTrayMissing', 'output-tray-missing': 'outputTrayMissing',
  'output-area-full': 'outputFull', 'output-area-almost-full': 'outputNearFull',
  'marker-supply-missing': 'markerSupplyMissing', 'toner-missing': 'markerSupplyMissing',
  'ink-missing': 'markerSupplyMissing', 'offline': 'offline', 'shutdown': 'offline',
  'service-needed': 'serviceRequested',
  // Drum, developer, fuser and waste toner (PWG 5100.9): end of life stops the
  // printer; near it is a warning
  'opc-life-over': 'serviceRequested', 'developer-empty': 'serviceRequested', 'fuser-over-temp': 'serviceRequested',
  'fuser-under-temp': 'serviceRequested', 'marker-waste-full': 'serviceRequested',
  'opc-near-eol': 'overduePreventMaint', 'marker-waste-almost-full': 'overduePreventMaint',
  'developer-low': 'overduePreventMaint',
};

/** A reason keyword without its severity suffix; "-report" ones are information only */
export function reasonErrors(reasons: IppValue[]): PrinterError[] {
  const out = new Set<PrinterError>();
  for (const r of reasons.map(String)) {
    if (r.endsWith('-report')) { continue; }
    const key = r.replace(/-(warning|error)$/, '');
    if (REASONS[key]) { out.add(REASONS[key]); }
  }
  return [...out];
}

const HEX_COLORS: Record<string, Color> = { '#000000': 'black', '#00ffff': 'cyan', '#ff00ff': 'magenta', '#ffff00': 'yellow' };

function markerColor(name: string, hex: string): Color | null {
  const byHex = HEX_COLORS[hex.toLowerCase()];
  if (byHex) { return byHex; }
  const m = /\b(black|cyan|magenta|yellow)\b/i.exec(name) || /\b(BK|C|M|Y)\b/.exec(name);
  if (!m) { return null; }
  const word = m[1].toLowerCase();
  return ({ bk: 'black', c: 'cyan', m: 'magenta', y: 'yellow' } as Record<string, Color>)[word] ?? word as Color;
}

function partKey(name: string, type: string): PartKey | null {
  const n = name.toLowerCase();
  if (/waste/.test(type) || /waste/.test(n)) { return 'inkWasteBox'; }
  if (type === 'fuser' || /fuser/.test(n)) { return 'fuser'; }
  if (/transfer|belt/.test(type) || /belt/.test(n)) { return 'belt'; }
  if (/laser/.test(n)) { return 'laser'; }
  if (/feed/.test(n)) { return /mp/.test(n) ? 'paperFeedMP' : 'paperFeed1'; }
  return null;
}

/** The printer's IPP attributes as the plugin's readings */
export function toPrinterData(a: IppAttributes): PrinterData {
  const str = (k: string): string => (a[k]?.[0] !== undefined && a[k][0] !== null ? String(a[k][0]) : '');
  const num = (k: string, i: number): number | null => (typeof a[k]?.[i] === 'number' ? a[k][i] as number : null);

  const deviceId = str('printer-device-id');
  const field = (re: RegExp): string => (re.exec(deviceId)?.[1] ?? '').trim();
  const model = str('printer-make-and-model') || field(/(?:^|;)\s*(?:MDL|MODEL):([^;]+)/i);
  const serial = str('printer-serial-number') || field(/(?:^|;)\s*(?:SN|SERN):([^;]+)/i) || null;
  const errors = reasonErrors(a['printer-state-reasons'] || []);
  const state = num('printer-state', 0); // 3 idle, 4 processing, 5 stopped
  // As hrPrinterStatus, which the status logic understands: 3 idle, 4 printing, 1 other
  const printerStatus = state === 3 ? 3 : state === 4 ? 4 : state === 5 ? 1 : null;
  // Information-only reasons ("-report") stay out of the text the status logic also reads
  const reasons = (a['printer-state-reasons'] || []).map(String).filter((r) => r !== 'none' && !r.endsWith('-report'));
  const statusText = str('printer-state-message') || reasons.join(', ');

  const supplies: Supply[] = [];
  const drums: Partial<Record<Color, Drum>> = {};
  const parts: Partial<Record<PartKey, Part>> = {};
  const names = (a['marker-names'] || []).map(String);
  const types = names.map((_, i) => String(a['marker-types']?.[i] ?? '').toLowerCase());
  const isSupply = (type: string, name: string): boolean =>
    /^(toner|ink|ink-cartridge|toner-cartridge|solid-wax|ribbon-wax)$/.test(type) || (type === '' && /toner|ink/i.test(name));
  // A printer with one toner and no color for it is a mono printer: black
  const onlyOne = names.filter((n, i) => isSupply(types[i], n)).length === 1;
  let ink = false;
  names.forEach((name, i) => {
    const type = types[i];
    const level = num('marker-levels', i);
    const high = num('marker-high-levels', i) ?? 100;
    // -1 unavailable, -2 unknown, -3 "some remaining": no number to show
    const percent = level !== null && level >= 0 && high > 0 ? Math.max(0, Math.min(100, Math.round(level * 100 / high))) : null;
    if (/ink/.test(type)) { ink = true; }
    const color = markerColor(name, String(a['marker-colors']?.[i] ?? '')) ?? (onlyOne && isSupply(type, name) ? 'black' : null);
    if (isSupply(type, name)) {
      if (percent !== null && color && !supplies.some((s) => s.color === color)) { supplies.push({ color, level: percent, fine: null }); }
      return;
    }
    if (type === 'opc' || type === 'photo-conductor' || /drum/i.test(name)) {
      if (percent !== null) { drums[color || 'black'] = { percent }; }
      return;
    }
    const key = partKey(name, type);
    if (key && percent !== null) { parts[key] = { percent }; }
  });
  const order: Color[] = ['black', 'cyan', 'magenta', 'yellow'];
  supplies.sort((x, y) => order.indexOf(x.color) - order.indexOf(y.color));
  const lowest = supplies.length ? supplies.reduce((x, y) => (y.level < x.level ? y : x)) : null;
  const black = drums.black || {};
  const type = ink || parts.inkWasteBox ? 'ink' : printerType(model, null, deviceId);

  return {
    model: model || null,
    serial,
    type,
    statusText,
    printerStatus,
    errors,
    ...summarizeStatus({ statusText, printerStatus, errors }),
    supplies,
    lowestSupply: lowest,
    drums,
    parts,
    totalPages: num('printer-impressions-completed', 0),
    colorPages: null,
    duplexPages: null,
    tonerPercent: supplies.find((s) => s.color === 'black')?.level ?? null,
    tonerPercentFine: null,
    drumPercent: black.percent ?? null,
    drumPagesUsed: null,
    drumPagesRemaining: null,
    unknown: {},
  };
}

/* ---------------------------------------------------------------- request */

export interface IppOptions {
  /** ipp://, ipps://, http:// or https:// address of the printer's IPP service */
  url: string;
  timeout?: number;
}

/** The HTTP address for an IPP printer URI, and the URI to put in the request */
export function ippEndpoint(url: string): { http: URL; uri: string } {
  const u = new URL(url);
  const secure = u.protocol === 'ipps:' || u.protocol === 'https:';
  if (!['ipp:', 'ipps:', 'http:', 'https:'].includes(u.protocol)) { throw new Error(`Not an IPP address: ${url}`); }
  const port = u.port || (u.protocol === 'ipp:' || u.protocol === 'ipps:' ? '631' : '');
  // hostname keeps an IPv6 address's brackets
  const target = new URL(`${secure ? 'https' : 'http'}://${u.hostname}${port ? `:${port}` : ''}${u.pathname}${u.search}`);
  const uri = `${secure ? 'ipps' : 'ipp'}://${target.host}${target.pathname}`;
  return { http: target, uri };
}

/** Read a printer over IPP. Rejects when it can't be reached or refuses the request. */
export function ippQuery(options: IppOptions): Promise<PrinterData> {
  const { http: target, uri } = ippEndpoint(options.url);
  const requestId = 1 + Math.floor(Math.random() * 0x7ffffffe);
  const body = getPrinterAttributes(uri, requestId);
  const timeout = options.timeout ?? 5000;
  const lib = target.protocol === 'https:' ? https : http;

  return new Promise((resolve, reject) => {
    // An overall deadline: the socket timeout alone doesn't end a reply that trickles in
    const deadline = setTimeout(() => req.destroy(new Error('Request timed out')), timeout * 2);
    const settle = <T>(fn: (v: T) => void) => (v: T): void => { clearTimeout(deadline); fn(v); };
    resolve = settle(resolve);
    reject = settle(reject);
    const req = lib.request(target, {
      method: 'POST',
      headers: { 'Content-Type': 'application/ipp', 'Content-Length': body.length },
      timeout,
      // Printers use self-signed certificates; on the local network that's normal
      rejectUnauthorized: false,
    }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (c: Buffer) => {
        size += c.length;
        if (size > 1_000_000) { req.destroy(new Error('IPP response too large')); return; }
        chunks.push(c);
      });
      res.on('end', () => {
        if (res.statusCode !== 200) { reject(new Error(`IPP request failed: HTTP ${res.statusCode}`)); return; }
        try {
          const r = parseResponse(Buffer.concat(chunks));
          if (r.requestId !== requestId) { reject(new Error('IPP response is for another request')); return; }
          if (r.status > 0x00ff) { reject(new Error(`IPP request refused (status 0x${r.status.toString(16).padStart(4, '0')})`)); return; }
          resolve(toPrinterData(r.printer));
        } catch (err) {
          reject(err as Error);
        }
      });
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('Request timed out')));
    req.on('error', reject);
    req.end(body);
  });
}
