/*
 * Finding printers by Bonjour (multicast DNS), the way Macs, iPhones and AirPrint
 * find them. This finds printers with SNMP off too, and gives their IPP address.
 *
 * One query for the printer services is sent from an ordinary port, so printers
 * answer it directly (a "legacy unicast" query, RFC 6762 section 6.7) and this
 * works next to the Bonjour service the Homebridge machine may already run
 * (Avahi on a Raspberry Pi holds port 5353).
 */
import dgram from 'node:dgram';

export const MDNS_ADDRESS = '224.0.0.251';
export const MDNS_PORT = 5353;
/** IPP first: its records say where the printer's IPP service is */
export const SERVICES = ['_ipp._tcp.local', '_ipps._tcp.local', '_pdl-datastream._tcp.local', '_printer._tcp.local'];

const TYPE = { A: 1, PTR: 12, TXT: 16, SRV: 33 } as const;

export interface BonjourPrinter {
  /** IPv4 address */
  host: string;
  /** The name the printer advertises ("Brother MFC-L2750DW series") */
  name: string;
  /** Its model as the ty record gives it, when it does */
  model: string | null;
  /** The IPP address from its _ipp/_ipps record, e.g. ipp://10.0.4.150:631/ipp/print; null when it has none */
  ippUrl: string | null;
  /** The printer's UUID, when it gives one */
  uuid: string | null;
}

/* -------------------------------------------------------------- encoding */

function encodeName(name: string): Buffer {
  const parts = name.split('.').filter(Boolean).map((p) => {
    const b = Buffer.from(p, 'utf8');
    return Buffer.concat([Buffer.from([b.length]), b]);
  });
  return Buffer.concat([...parts, Buffer.from([0])]);
}

/** A DNS query for the PTR records of each service */
export function buildQuery(services: string[] = SERVICES, id = 0): Buffer {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(id, 0);
  header.writeUInt16BE(services.length, 4);
  return Buffer.concat([header, ...services.map((s) => {
    const tail = Buffer.alloc(4);
    tail.writeUInt16BE(TYPE.PTR, 0);
    tail.writeUInt16BE(1, 2); // class IN
    return Buffer.concat([encodeName(s), tail]);
  })]);
}

/* -------------------------------------------------------------- decoding */

export interface DnsRecord {
  /** Lower case */
  name: string;
  type: number;
  data: string | { port: number; target: string } | Record<string, string>;
}

function readName(buf: Buffer, start: number): { name: string; next: number } {
  const labels: string[] = [];
  let offset = start;
  let next = -1;
  // Pointers can only go back; a loop or a cut-off name ends the name
  for (let guard = 0; guard < 128 && offset < buf.length; guard++) {
    const len = buf[offset];
    if (len === 0) { offset += 1; break; }
    if ((len & 0xc0) === 0xc0) {
      if (offset + 1 >= buf.length) { break; }
      if (next < 0) { next = offset + 2; }
      const to = ((len & 0x3f) << 8) | buf[offset + 1];
      if (to >= offset) { break; }
      offset = to;
      continue;
    }
    labels.push(buf.toString('utf8', offset + 1, Math.min(buf.length, offset + 1 + len)));
    offset += 1 + len;
  }
  return { name: labels.join('.'), next: next >= 0 ? next : offset };
}

/** The answer and additional records of an mDNS message; malformed parts are skipped */
export function parseMessage(buf: Buffer): DnsRecord[] {
  if (buf.length < 12 || !(buf[2] & 0x80)) { return []; } // too short, or a query rather than an answer
  const questions = buf.readUInt16BE(4);
  const total = buf.readUInt16BE(6) + buf.readUInt16BE(8) + buf.readUInt16BE(10);
  let off = 12;
  for (let i = 0; i < questions && off < buf.length; i++) { off = readName(buf, off).next + 4; }
  const out: DnsRecord[] = [];
  for (let i = 0; i < total && off + 10 <= buf.length; i++) {
    const { name, next } = readName(buf, off);
    off = next;
    if (off + 10 > buf.length) { break; }
    const type = buf.readUInt16BE(off);
    const rdlen = buf.readUInt16BE(off + 8);
    const rd = off + 10;
    off = rd + rdlen;
    if (off > buf.length) { break; }
    const lower = name.toLowerCase();
    if (type === TYPE.PTR) {
      out.push({ name: lower, type, data: readName(buf, rd).name });
    } else if (type === TYPE.SRV && rdlen >= 7) {
      out.push({ name: lower, type, data: { port: buf.readUInt16BE(rd + 4), target: readName(buf, rd + 6).name.toLowerCase() } });
    } else if (type === TYPE.A && rdlen === 4) {
      out.push({ name: lower, type, data: [...buf.subarray(rd, rd + 4)].join('.') });
    } else if (type === TYPE.TXT) {
      const txt: Record<string, string> = {};
      for (let p = rd; p < rd + rdlen;) {
        const l = buf[p];
        const s = buf.toString('utf8', p + 1, Math.min(rd + rdlen, p + 1 + l));
        const eq = s.indexOf('=');
        if (eq > 0) { txt[s.slice(0, eq).toLowerCase()] = s.slice(eq + 1); }
        p += 1 + l;
      }
      out.push({ name: lower, type, data: txt });
    }
  }
  return out;
}

const unescapeName = (s: string): string => s.replace(/\\(\d{3})/g, (_, d: string) => String.fromCharCode(Number(d))).replace(/\\(.)/g, '$1');

/** Printers from the records of all answers, one per address */
export function printersFrom(records: DnsRecord[], services: string[] = SERVICES): BonjourPrinter[] {
  const of = (type: number, name: string): DnsRecord[] => records.filter((r) => r.type === type && r.name === name.toLowerCase());
  const byHost = new Map<string, BonjourPrinter>();
  for (const service of services) {
    for (const ptr of of(TYPE.PTR, service)) {
      const instance = String(ptr.data);
      const srv = of(TYPE.SRV, instance)[0]?.data as { port: number; target: string } | undefined;
      const txt = (of(TYPE.TXT, instance)[0]?.data ?? {}) as Record<string, string>;
      const address = srv ? of(TYPE.A, srv.target)[0]?.data as string | undefined : undefined;
      if (!srv || !address) { continue; }
      const label = unescapeName(instance.slice(0, instance.length - service.length - 1) || instance);
      const ipp = service.startsWith('_ipp');
      const path = (txt.rp ?? 'ipp/print').replace(/^\/+/, '');
      const ippUrl = ipp ? `${service.startsWith('_ipps') ? 'ipps' : 'ipp'}://${address}:${srv.port}/${path}` : null;
      const have = byHost.get(address);
      if (have) {
        // An earlier service (IPP before IPPS) wins; fill in what it lacked
        have.ippUrl ??= ippUrl;
        have.model ??= txt.ty || null;
        have.uuid ??= txt.uuid || null;
        continue;
      }
      byHost.set(address, { host: address, name: label, model: txt.ty || null, ippUrl, uuid: txt.uuid || null });
    }
  }
  return [...byHost.values()];
}

/* --------------------------------------------------------------- the query */

export interface BrowseOptions {
  /** How long to collect answers, ms */
  wait?: number;
  /** Where to send the query; tests pass their own */
  address?: string;
  port?: number;
}

/** Ask the network for printers by Bonjour. Resolves with what answered in time; never rejects. */
export function browse(options: BrowseOptions = {}): Promise<BonjourPrinter[]> {
  const wait = options.wait ?? 2000;
  return new Promise((resolve) => {
    const records: DnsRecord[] = [];
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    let done = false;
    const finish = (): void => {
      if (done) { return; }
      done = true;
      try { socket.close(); } catch { /* already closed */ }
      resolve(printersFrom(records));
    };
    socket.on('error', () => finish()); // no multicast here: no Bonjour printers
    socket.on('message', (msg) => { try { records.push(...parseMessage(msg)); } catch { /* not for us */ } });
    socket.bind(0, () => {
      const query = buildQuery();
      // Twice, since a multicast packet can be lost
      const send = (): void => { socket.send(query, options.port ?? MDNS_PORT, options.address ?? MDNS_ADDRESS, () => { /* no route: no answers */ }); };
      try { socket.setMulticastTTL(255); } catch { /* not allowed here */ }
      send();
      setTimeout(() => { if (!done) { send(); } }, Math.min(500, wait / 3));
      setTimeout(finish, wait);
    });
  });
}
