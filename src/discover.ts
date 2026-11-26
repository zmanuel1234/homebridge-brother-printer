/*
 * Finding Brother printers on the local network, for the settings screen.
 *
 * One SNMP v1 GetRequest (sysDescr) is broadcast on every IPv4 network the
 * Homebridge machine is on, the way Brother's own tools find printers. Each
 * device that answers is then read with the plugin's normal query, and the ones
 * that turn out to be Brother printers are returned.
 */
import dgram from 'node:dgram';
import os from 'node:os';
import { query } from './snmp';
import type { QueryOptions, QueryResult } from './snmp';
import type { PrinterType } from './decode';

const SYS_DESCR = '1.3.6.1.2.1.1.1.0';

export interface FoundPrinter {
  host: string;
  /** Model as the printer names it, without "Brother" and "series" */
  model: string;
  serial: string | null;
  type: PrinterType;
  /** A short summary for the list, e.g. "toner 70%" */
  levels: string;
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
    // Any SNMP answer counts; the community or version may still be wrong for a
    // full read, which the query afterwards finds out.
    socket.on('message', (msg, rinfo) => { if (msg[0] === 0x30) { found.add(rinfo.address); } });
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

/** Find Brother printers on the network, sorted by address */
export async function discover(options: DiscoverOptions = {}): Promise<FoundPrinter[]> {
  const read = options.read ?? query;
  const hosts = await findResponders(options);
  const results = await Promise.all(hosts.map(async (host) => {
    try {
      const d = await read({
        host, port: options.port ?? 161, community: options.community || 'public', timeout: 2000, retries: 0,
      });
      const brother = /brother/i.test(d.model || '') || d.supplies.length > 0 || Object.keys(d.drums).length > 0;
      if (!brother) { return null; }
      const found: FoundPrinter = {
        host, model: cleanModel(d.model || 'Brother printer'), serial: d.serial, type: d.type, levels: summary(d),
      };
      return found;
    } catch {
      return null; // not a printer, or not readable with this community
    }
  }));
  const ip = (h: string): number => h.split('.').reduce((n, v) => n * 256 + Number(v), 0);
  return results.filter((r): r is FoundPrinter => r !== null).sort((a, b) => ip(a.host) - ip(b.host));
}
