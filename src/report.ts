/*
 * A report of what a printer answers, to paste into a GitHub issue: what the
 * plugin reads from it, and the raw SNMP and IPP answers behind that. The
 * settings screen's "Copy a report" button and the probe's --report make it.
 *
 * Passwords, the community and the SNMPv3 user are left out, and so are the
 * printer's location and contact details; the serial number, MAC addresses
 * (also in Brother's BRN/BRW names) and UUIDs are shortened, so the report can be
 * posted in public. It's cut to fit a GitHub issue.
 */
import os from 'node:os';
import { bulkWalk, nextWalk, openSession, query } from './snmp';
import type { QueryOptions, QueryResult, SnmpVersion } from './snmp';
import { ippAttributes } from './ipp';
import type { IppAttributes } from './ipp';
import { defaultIppUrl, readPrinter } from './read';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { version } = require('../package.json') as { version: string };

/** The parts of the printer's SNMP tree a report shows, with at most this many values each */
export const SNMP_SECTIONS: [string, string, number][] = [
  ['System', '1.3.6.1.2.1.1', 10],
  ['Devices (Host Resources MIB)', '1.3.6.1.2.1.25.3.2.1', 40],
  ['Printer status', '1.3.6.1.2.1.25.3.5.1', 10],
  ['Printer general', '1.3.6.1.2.1.43.5.1.1', 30],
  ['Paper trays', '1.3.6.1.2.1.43.8.2.1', 120],
  ['Output trays', '1.3.6.1.2.1.43.9.2.1', 60],
  ['Markers and page counts', '1.3.6.1.2.1.43.10.2.1', 30],
  ['Supplies', '1.3.6.1.2.1.43.11.1.1', 120],
  ['Colorants', '1.3.6.1.2.1.43.12.1.1', 40],
  ['Console display', '1.3.6.1.2.1.43.16.5.1', 10],
  ['Alerts', '1.3.6.1.2.1.43.18.1.1', 80],
  ['Brother records', '1.3.6.1.4.1.2435.2.3.9.4.2.1.5.5', 30],
  ['Brother status', '1.3.6.1.4.1.2435.2.3.9.4.2.1.5.4.5', 10],
  ['Brother device ID', '1.3.6.1.4.1.2435.2.3.9.1.1.7', 2],
];

export interface ReportDeps {
  read?: (options: QueryOptions) => Promise<QueryResult>;
  /** Raw SNMP: one section's values as "oid = value" lines */
  walk?: (options: QueryOptions, version: SnmpVersion, oid: string, limit: number) => Promise<string[]>;
  /** Does the printer answer bulk requests (GETBULK)? */
  bulk?: (options: QueryOptions, version: SnmpVersion) => Promise<boolean>;
  ipp?: (options: QueryOptions) => Promise<IppAttributes>;
}

const errorText = (err: unknown): string => (err as { message?: string } | null)?.message || String(err);

/** A value as text: printable strings as they are, other bytes in hex */
export function valueText(v: unknown): string {
  if (Buffer.isBuffer(v)) {
    const text = v.toString('utf8');
    // eslint-disable-next-line no-control-regex
    return /^[\u0009\u000a\u000d -~ -￿]*$/.test(text) && !text.includes('�')
      ? JSON.stringify(text)
      : `hex ${v.toString('hex')}`;
  }
  return v === null || v === undefined ? 'null' : String(v);
}

async function snmpWalk(options: QueryOptions, ver: SnmpVersion, oid: string, limit: number): Promise<string[]> {
  const session = openSession(options, ver);
  try {
    const rows = await nextWalk(session, oid, limit);
    return rows.map((vb) => `${vb.oid} = ${valueText(vb.value)}`);
  } finally {
    try { session.close(); } catch { /* already closed */ }
  }
}

async function answersBulk(options: QueryOptions, ver: SnmpVersion): Promise<boolean> {
  const session = openSession({ ...options, retries: 0 }, ver);
  try {
    await bulkWalk(session, '1.3.6.1.2.1.43.11.1.1', 5);
    return true;
  } catch {
    return false;
  } finally {
    try { session.close(); } catch { /* already closed */ }
  }
}

const SECRET_SETTINGS = ['community', 'v3AuthPassword', 'v3PrivPassword', 'v3User'];

/** The printer's settings without passwords, the community or the SNMPv3 user */
export function safeSettings(entry: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(entry)) {
    if (SECRET_SETTINGS.includes(k)) {
      out[k] = k === 'community' && (v === 'public' || v === '' || v === undefined) ? v : '(set, not shown)';
    } else if (k === 'ippUrl' && typeof v === 'string') {
      out[k] = v.replace(/^([a-z]+:\/\/)[^/@]*@/i, '$1');
    } else {
      out[k] = v;
    }
  }
  return out;
}

/** SNMP values and IPP attributes about where the printer is and who looks after it: not shown */
const PRIVATE_OIDS = ['1.3.6.1.2.1.1.4.0', '1.3.6.1.2.1.1.6.0']; // sysContact, sysLocation
const PRIVATE_IPP = /^printer-(location|geo-location|organization|organizational-unit|contact.*)$/;
/** IPP attributes left out for size: media lists run to tens of kilobytes */
const BULKY_IPP = /^media-(col-database|col-ready|supported|size-supported|type-supported|source-supported|col-supported)$|^printer-icons$|^printer-strings-uri$/;
/** GitHub refuses issue bodies over 65,536 characters */
export const MAX_REPORT = 60000;

/**
 * The report's text with secrets left out and identifiers shortened: the serial
 * number (as text or hex), MAC addresses (with separators, bare, and in Brother's
 * BRN/BRW names), UUIDs, and the given secrets (community, SNMPv3 user).
 */
export function redact(text: string, serials: (string | null | undefined)[], secrets: string[] = []): string {
  let out = text;
  // In the printer's raw values only (after " = "): elsewhere a community such as "brother"
  // would be replaced in the plugin's own name, and so give itself away
  const hidden = [...new Set(secrets.filter((v) => v && v.length >= 4 && v !== 'public'))];
  if (hidden.length) {
    out = out.split('\n').map((line) => {
      const at = line.indexOf(' = ');
      if (at < 0) { return line; }
      let value = line.slice(at + 3);
      for (const secret of hidden) { value = value.split(secret).join('(not shown)'); }
      return line.slice(0, at + 3) + value;
    }).join('\n');
  }
  for (const s of new Set(serials.map((v) => (v ?? '').trim()).filter((v) => v.length >= 5))) {
    const short = `…${s.slice(-4)}`;
    out = out.split(s).join(short);
    const hex = Buffer.from(s, 'utf8').toString('hex');
    out = out.replace(new RegExp(hex, 'gi'), short);
  }
  // UUIDs first, so a MAC inside one doesn't break its pattern
  out = out.replace(/\b([0-9a-f]{8})-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-([0-9a-f]{12})\b/gi, (_, a: string, b: string) => `${a.slice(0, 4)}…${b.slice(-4)}`);
  // MACs seen with separators or in BRN/BRW names, then the same MACs written without
  const macs = new Set<string>();
  out = out.replace(/\b([0-9a-f]{2})([:-])([0-9a-f]{2})\2([0-9a-f]{2})\2([0-9a-f]{2})\2([0-9a-f]{2})\2([0-9a-f]{2})\b/gi,
    (_m, a: string, sep: string, b: string, c: string, d: string, e: string, f: string) => {
      macs.add(`${a}${b}${c}${d}${e}${f}`.toLowerCase());
      return `${a}${sep}…${sep}${e}${sep}${f}`;
    });
  out = out.replace(/\b(BR[NW])([0-9a-f]{12})\b/gi, (_m, p: string, mac: string) => {
    macs.add(mac.toLowerCase());
    return `${p}…${mac.slice(-4)}`;
  });
  for (const mac of macs) { out = out.replace(new RegExp(`\\b${mac}\\b`, 'gi'), (m) => `…${m.slice(-4)}`); }
  return out;
}

/** Cut to fit a GitHub issue, closing an open code block and details */
export function fit(text: string, max = MAX_REPORT): string {
  if (text.length <= max) { return text; }
  let cut = text.slice(0, max);
  cut = cut.slice(0, cut.lastIndexOf('\n'));
  const fences = (cut.match(/^```/gm) || []).length;
  return `${cut}${fences % 2 ? '\n```' : ''}${cut.lastIndexOf('<details>') > cut.lastIndexOf('</details>') ? '\n</details>' : ''}\n\n(cut here to fit a GitHub issue)`;
}

/**
 * The report for one printer, from its settings (as in config.json). Never rejects:
 * what couldn't be read is said in the report.
 */
export async function buildReport(entry: Record<string, unknown>, options: QueryOptions & { host: string },
  deps: ReportDeps = {}): Promise<string> {
  const read = deps.read ?? readPrinter;
  const walk = deps.walk ?? snmpWalk;
  const bulk = deps.bulk ?? answersBulk;
  const ipp = deps.ipp ?? ((o: QueryOptions) => ippAttributes({
    url: o.ippUrl || defaultIppUrl(o.host), timeout: o.timeout ?? 3000, allowSelfSigned: o.ippAllowSelfSigned === true,
  }, ['all']));
  const lines: string[] = [];
  const add = (...l: string[]): void => { lines.push(...l); };
  // Keep what's known of the printer (it doesn't answer bulk requests), not the rest of the plugin's state
  const base: QueryOptions & { host: string } = { ...options, timeout: 3000, retries: 0, trays: true,
    state: options.state?.noBulk ? { noBulk: true } : {} };

  add('### Printer report', '',
    `- Plugin: homebridge-brother-printer ${version}`,
    `- Node.js ${process.version} on ${os.platform()} ${os.arch()}`,
    `- Made ${new Date().toISOString()}`, '',
    '#### Settings', '```json', JSON.stringify(safeSettings(entry), null, 2), '```', '');

  // What the plugin makes of it
  let reading: QueryResult | null = null;
  const started = Date.now();
  try {
    reading = await read(base);
    add(`#### What the plugin reads (${Date.now() - started} ms, over ${reading.via === 'ipp' ? 'IPP' : `SNMP v${reading.snmpVersion}`})`,
      '```json', JSON.stringify(reading, null, 2), '```', '');
  } catch (err) {
    add(`#### What the plugin reads`, '', `Couldn't read the printer (${Date.now() - started} ms): ${errorText(err)}`, '');
  }

  // Raw SNMP, in the version that answered (or the one set)
  if (options.protocol !== 'ipp') {
    let ver: SnmpVersion | null = reading?.snmpVersion ?? (options.version && options.version !== 'auto' ? options.version : null);
    // Read over IPP (auto): does SNMP answer at all?
    if (!ver && reading?.via === 'ipp') {
      try { ver = (await query({ ...base, trays: false })).snmpVersion; } catch { /* no SNMP */ }
    }
    if (!ver) {
      add('#### SNMP', '', 'No answer over SNMP.', '');
    } else {
      const bulkText = ver === '1' ? 'not used with v1'
        : base.state?.noBulk ? 'no (known from the plugin; read row by row)'
          : (await bulk(base, ver)) ? 'yes' : 'no (read row by row)';
      add(`#### SNMP v${ver}`, '', `Answers bulk requests: ${bulkText}`, '');
      for (const [title, oid, limit] of SNMP_SECTIONS) {
        let rows: string[];
        try {
          rows = await walk(base, ver, oid, limit);
        } catch (err) {
          rows = [`(couldn't read: ${errorText(err)})`];
        }
        rows = rows.map((r) => (PRIVATE_OIDS.some((o) => r.startsWith(`${o} = `)) ? `${r.split(' = ')[0]} = (not shown)` : r));
        if (!rows.length) { continue; }
        add(`<details><summary>${title} (${oid})</summary>`, '', '```', ...rows, '```', '</details>', '');
      }
    }
  }

  // Raw IPP: every attribute the printer gives
  try {
    const attrs = await ipp(base);
    const rows = Object.entries(attrs).filter(([k]) => !BULKY_IPP.test(k)).map(([k, v]) => (PRIVATE_IPP.test(k)
      ? `${k} = (not shown)`
      : `${k} = ${v.map((x) => (typeof x === 'string' ? JSON.stringify(x) : String(x))).join(', ')}`));
    add(`<details><summary>IPP (${base.ippUrl || defaultIppUrl(base.host)})</summary>`, '', '```', ...rows, '```', '</details>', '');
  } catch (err) {
    add('#### IPP', '', `No answer over IPP: ${errorText(err)}`, '');
  }

  return fit(redact(lines.join('\n'), [reading?.serial, String(entry.serial ?? '')],
    [String(options.community ?? ''), options.v3?.user ?? '', String(entry.community ?? ''), String(entry.v3User ?? '')]));
}
