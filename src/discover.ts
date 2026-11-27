/*
 * Finding printers on the local network, for the settings screen, and finding a
 * printer again after its address changes.
 *
 * Two searches run at once:
 * - one SNMP v1 GetRequest (sysDescr) broadcast on every IPv4 network the
 *   Homebridge machine is on, the way Brother's own tools find printers;
 * - a Bonjour (mDNS) query for printer services, the way AirPrint finds them,
 *   which also finds printers with SNMP off.
 * Each device found is then read with the plugin's normal query (over IPP when
 * SNMP doesn't answer and it has an IPP service), and the ones that turn out to
 * be printers are returned: any make, Brother ones read in most detail.
 */
import dgram from 'node:dgram';
import os from 'node:os';
import { query } from './snmp';
import type { QueryOptions, QueryResult } from './snmp';
import type { PrinterType } from './decode';
import { browse } from './mdns';
import type { BonjourPrinter } from './mdns';
import { readIpp } from './read';

const SYS_DESCR = '1.3.6.1.2.1.1.1.0';

export interface FoundPrinter {
  host: string;
  /** Model as the printer names it, without "Brother" and "series" */
  model: string;
  serial: string | null;
  type: PrinterType;
  /** A short summary for the list, e.g. "toner 70%" */
  levels: string;
  /** How it answered: SNMP, or only IPP (SNMP off) */
  protocol: 'snmp' | 'ipp';
  /** Its IPP address from Bonjour, when it advertises one */
  ippUrl: string | null;
  /** The name it advertises by Bonjour, when it does */
  bonjourName: string | null;
}

export interface DiscoverOptions {
  community?: string;
  port?: number;
  /** How long to wait for answers to the broadcast, ms */
  wait?: number;
  /** Addresses to send to; the default is every IPv4 broadcast address */
  targets?: string[];
  /** Reads one printer; tests pass their own */
  read?: (options: QueryOptions) => Promise<QueryResult>;
  /** Reads one printer over IPP; tests pass their own */
  readIpp?: (options: QueryOptions) => Promise<QueryResult>;
  /**
   * The Bonjour search; false for none. The default searches, except when
   * `targets` is given (a search of given addresses only).
   */
  bonjour?: false | (() => Promise<BonjourPrinter[]>);
}

/** The Bonjour search as the options ask for it */
function bonjourSearch(options: DiscoverOptions): Promise<BonjourPrinter[]> {
  const search = options.bonjour ?? (options.targets ? false : () => browse({ wait: options.wait ?? 2000 }));
  return search ? search().catch(() => []) : Promise.resolve([]);
}

/** Every address that answered either search, with what Bonjour said about it */
export async function findCandidates(options: DiscoverOptions = {}): Promise<{ host: string; bonjour?: BonjourPrinter }[]> {
  const [snmpHosts, bonjour] = await Promise.all([findResponders(options).catch(() => [] as string[]), bonjourSearch(options)]);
  const byHost = new Map(bonjour.map((b) => [b.host, b]));
  return [...new Set([...snmpHosts, ...byHost.keys()])].map((host) => ({ host, bonjour: byHost.get(host) }));
}

/* ------------------------------------------------------------ BER encoding */

function length(n: number): Buffer {
  if (n < 0x80) { return Buffer.from([n]); }
  const bytes: number[] = [];
  for (let v = n; v > 0; v >>= 8) { bytes.unshift(v & 0xff); }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function tlv(tag: number, value: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), length(value.length), value]);
}

function integer(n: number): Buffer {
  const bytes: number[] = [];
  let v = n;
  do { bytes.unshift(v & 0xff); v = Math.floor(v / 256); } while (v > 0);
  if (bytes[0] & 0x80) { bytes.unshift(0); } // stay positive
  return tlv(0x02, Buffer.from(bytes));
}

function oid(dotted: string): Buffer {
  const parts = dotted.split('.').map(Number);
  const out = [parts[0] * 40 + parts[1]];
  for (const p of parts.slice(2)) {
    const sub: number[] = [p & 0x7f];
    for (let v = p >> 7; v > 0; v >>= 7) { sub.unshift((v & 0x7f) | 0x80); }
    out.push(...sub);
  }
  return tlv(0x06, Buffer.from(out));
}

/** An SNMP v1 GetRequest for one OID */
export function getRequest(community: string, requestId: number, target = SYS_DESCR): Buffer {
  const varbind = tlv(0x30, Buffer.concat([oid(target), Buffer.from([0x05, 0x00])]));
  const pdu = tlv(0xa0, Buffer.concat([integer(requestId), integer(0), integer(0), tlv(0x30, varbind)]));
  return tlv(0x30, Buffer.concat([integer(0), tlv(0x04, Buffer.from(community, 'utf8')), pdu]));
}

/* ------------------------------------------------------------- discovery */

/** The broadcast address of every IPv4 network this machine is on, plus the limited broadcast */
export function broadcastAddresses(): string[] {
  const out = new Set<string>(['255.255.255.255']);
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family !== 'IPv4' || ni.internal) { continue; }
      const a = ni.address.split('.').map(Number);
      const m = ni.netmask.split('.').map(Number);
      out.add(a.map((v, i) => (v & m[i]) | (~m[i] & 0xff)).join('.'));
    }
  }
  return [...out];
}

/** Send the GetRequest and collect the addresses that answer */
export function findResponders(options: DiscoverOptions = {}): Promise<string[]> {
  const port = options.port ?? 161;
  const wait = options.wait ?? 2000;
  const targets = options.targets ?? broadcastAddresses();
  const requestId = Math.floor(Math.random() * 0x7fffffff);
  const packet = getRequest(options.community || 'public', requestId);

  return new Promise((resolve, reject) => {
    const found = new Set<string>();
    const socket = dgram.createSocket('udp4');
    let done = false;
    const finish = (err?: Error): void => {
      if (done) { return; }
      done = true;
      try { socket.close(); } catch { /* already closed */ }
      if (err) { reject(err); } else { resolve([...found]); }
    };
    socket.on('error', (err) => finish(err));
    // Any SNMP answer to this request counts; the community or version may still
    // be wrong for a full read, which the query afterwards finds out.
    // Only answers to this request (its id in the reply)
    const id = integer(requestId);
    socket.on('message', (msg, rinfo) => { if (msg[0] === 0x30 && msg.includes(id)) { found.add(rinfo.address); } });
    socket.bind(0, () => {
      try { socket.setBroadcast(true); } catch { /* not allowed here; unicast targets still work */ }
      for (const target of targets) {
        socket.send(packet, port, target, () => { /* send errors (e.g. no route) just mean no answers from there */ });
      }
      setTimeout(() => finish(), wait);
    });
  });
}

const cleanModel = (model: string): string => model.replace(/^Brother\s+/i, '').replace(/\s+series$/i, '').trim();

function summary(d: QueryResult): string {
  const kind = d.type === 'ink' ? 'ink' : 'toner';
  if (!d.supplies.length) { return `no ${kind} levels reported`; }
  return d.supplies.map((s) => (d.supplies.length === 1 ? `${kind} ${s.level}%` : `${s.color} ${s.level}%`)).join(', ');
}

/** A reading that is a printer (not a router, or a computer's virtual printer) */
export function isPrinter(d: QueryResult): boolean {
  // Printers have a printer status (Host Resources MIB) or supplies; routers and the like don't
  // A computer's virtual printer ("Microsoft Print To PDF") has a printer status too
  // (but not a real fax-printer such as a Brother FAX-L2700DN)
  const virtual = /microsoft|print to|\bpdf\b|\bxps\b|onenote|^fax$/i.test((d.model || '').trim());
  return !virtual && (d.printerStatus !== null || d.supplies.length > 0 || Object.keys(d.drums).length > 0
    || /brother/i.test(d.model || '') || d.via === 'ipp');
}

const ip = (h: string): number => h.split('.').reduce((n, v) => n * 256 + Number(v), 0);

/** Run `fn` over the list a few at a time, so a busy network doesn't get hundreds of requests at once */
async function inBatches<T, R>(list: T[], fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < list.length; i += 16) { out.push(...await Promise.all(list.slice(i, i + 16).map(fn))); }
  return out;
}

/** Find printers on the network, sorted by address */
export async function discover(options: DiscoverOptions = {}): Promise<FoundPrinter[]> {
  const read = options.read ?? query;
  const overIpp = options.readIpp ?? readIpp;
  const candidates = await findCandidates(options);
  const results = await inBatches(candidates, readOne);
  return results.filter((r): r is FoundPrinter => r !== null).sort((a, b) => ip(a.host) - ip(b.host));

  async function readOne({ host, bonjour }: { host: string; bonjour?: BonjourPrinter }): Promise<FoundPrinter | null> {
    let d: QueryResult | null = null;
    try {
      d = await read({ host, port: options.port ?? 161, community: options.community || 'public', timeout: 2000, retries: 0 });
    } catch { /* SNMP off, or another community */ }
    if ((!d || !isPrinter(d)) && bonjour?.ippUrl) {
      try {
        d = await overIpp({ host, protocol: 'ipp', ippUrl: bonjour.ippUrl, timeout: 3000 });
      } catch { /* not readable over IPP either */ }
    }
    if (!d || !isPrinter(d)) { return null; }
    const model = d.model || bonjour?.model
      || (d.manufacturer && d.manufacturer !== 'Brother' ? `${d.manufacturer} printer` : bonjour?.name || 'Printer');
    return {
      host, model: cleanModel(model), serial: d.serial, type: d.type, levels: summary(d),
      protocol: d.via === 'ipp' ? 'ipp' : 'snmp', ippUrl: bonjour?.ippUrl ?? null, bonjourName: bonjour?.name ?? null,
    };
  }
}

/** Model names compared loosely: "Brother MFC-L2750DW series" and "MFC-L2750DW" match */
const modelKey = (m: string | null | undefined): string => cleanModel(m ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Look for the printer with this serial number at another address (`skip` is its old
 * one). Resolves with the new address, or null.
 *
 * The printer's SNMP community and SNMPv3 settings go only to a device already
 * identified as it: first every device either search finds is asked without them
 * (IPP, which needs none, and SNMP with the "public" community, broadcast as the
 * settings screen's search does). Only with a private community or SNMPv3, and nothing
 * found that way, are the settings used, and then only with a device whose Bonjour
 * model is this printer's (`model`).
 */
export async function findBySerial(serial: string, settings: QueryOptions & { host: string }, skip: string,
  options: DiscoverOptions & { model?: string | null } = {}): Promise<{ host: string; ippUrl?: string } | null> {
  const read = options.read ?? query;
  const overIpp = options.readIpp ?? readIpp;
  const want = serial.trim().toUpperCase();
  const matches = (d: QueryResult | null): boolean => !!d?.serial && d.serial.trim().toUpperCase() === want;
  const candidates = (await findCandidates({ ...options, community: 'public', port: options.port ?? settings.port }))
    .filter((c) => c.host !== skip);
  // The IPP address to try at a candidate: the settings' one moved there, else what Bonjour says, else the default
  const ippAt = (host: string, bonjour?: BonjourPrinter): string | undefined => movedIppUrl(settings.ippUrl, skip, host) ?? bonjour?.ippUrl ?? undefined;
  const snmpWanted = settings.protocol !== 'ipp';
    const publicSnmp = snmpWanted && settings.version !== '3' && (settings.community || 'public') === 'public';

  let hit: { host: string; ippUrl?: string } | null = null;
  // Without credentials
  await inBatches(candidates, async ({ host, bonjour }) => {
    if (hit) { return; }
    const ippUrl = ippAt(host, bonjour);
    let d: QueryResult | null = null;
    if (snmpWanted) {
      try {
        d = await read({ host, port: settings.port, community: 'public', version: publicSnmp ? settings.version : 'auto', timeout: 2000, retries: 0, state: {} });
      } catch { /* no public SNMP */ }
    }
    // IPP needs no credentials; tried where Bonjour advertises it, or where the printer is read over IPP anyway
    if (!matches(d) && (bonjour?.ippUrl || settings.protocol !== 'snmp')) {
      try {
        d = await overIpp({ host, ippUrl, ippAllowSelfSigned: settings.ippAllowSelfSigned, timeout: 3000 });
      } catch { /* no IPP */ }
    }
    if (!hit && matches(d)) { hit = { host, ...(ippUrl && settings.protocol !== 'snmp' ? { ippUrl } : {}) }; }
  });
  if (hit || publicSnmp || !snmpWanted) { return hit; }

  // With the printer's own SNMP settings, only where Bonjour names the same model
  const model = modelKey(options.model);
  if (!model) { return null; }
  for (const { host, bonjour } of candidates) {
    if (!bonjour || (modelKey(bonjour.model) !== model && modelKey(bonjour.name) !== model)) { continue; }
    try {
      const d = await read({ ...settings, host, timeout: 2000, retries: 0, state: { ...settings.state }, trays: false });
      if (matches(d)) { return { host }; }
    } catch { /* not this one */ }
  }
  return null;
}

/**
 * An IPP address from the settings for the printer at its new address: the same
 * address with the old host replaced (and no user name or password in it).
 * Undefined when there's none, or it doesn't name the old host (then it says
 * nothing about where to find the printer at another address).
 */
export function movedIppUrl(url: string | undefined, from: string, to: string): string | undefined {
  if (!url) { return undefined; }
  try {
    const u = new URL(url);
    if (u.hostname.replace(/^\[|\]$/g, '') !== from) { return undefined; }
    u.hostname = to.includes(':') ? `[${to}]` : to;
    u.username = '';
    u.password = '';
    return u.toString();
  } catch {
    return undefined;
  }
}
