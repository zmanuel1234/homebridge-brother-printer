/*
 * The settings screen's server side (Homebridge UI custom UI): searching the
 * network for Brother printers, and testing a printer's settings.
 * It runs in its own process, started by the Homebridge UI while the plugin's
 * settings are open.
 */
import { HomebridgePluginUiServer, RequestError } from '@homebridge/plugin-ui-utils';
import { discover } from '../discover';
import { queryOptions } from '../accessory';
import type { PrinterConfig } from '../accessory';
import { readVia } from '../snmp';
import { readPrinter } from '../read';
import type { QueryResult } from '../snmp';
import { describeLeft, pagesInLast } from '../usage';
import type { UsageSample } from '../usage';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

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
}

const errorText = (err: unknown): string => (err as { message?: string } | null)?.message || String(err);

const TRAY_STATE = { empty: 'empty', low: 'low', ok: 'has paper', unknown: 'unknown' } as const;

export function testSummary(d: QueryResult, cached?: CachedUsage): TestResult {
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
    ...usageSummary(d, cached),
  };
}

function usageSummary(d: QueryResult, cached?: CachedUsage): { usage: string | null; left: string | null } {
  const now = Math.round(Date.now() / 1000);
  const samples = cached?.samples;
  // IPP's page count may not match the SNMP one the plugin keeps
  const pages = d.via === 'ipp' && cached?.snmpAnswered ? null : d.totalPages;
  const week = pagesInLast(samples, now, pages, 7);
  const month = pagesInLast(samples, now, pages, 30);
  const usage = [week !== null ? `${week} pages in the last 7 days` : '', month !== null ? `${month} in the last 30 days` : '']
    .filter(Boolean).join(', ') || null;
  const levels = Object.fromEntries(d.supplies.map((s) => [s.color, s.fine ?? s.level]));
  return { usage, left: describeLeft(samples, now, levels, d.type === 'ink' ? 'Ink' : 'Toner') };
}

export interface CachedUsage {
  samples: UsageSample[];
  /** The plugin has read this printer over SNMP: its page counts are SNMP's */
  snmpAnswered: boolean;
}

/**
 * The plugin's daily readings for a printer, from Homebridge's accessory cache (the
 * main bridge's and any child bridge's), matched by name and address. Empty when
 * the printer hasn't been running in Homebridge.
 */
export function cachedUsage(storagePath: string | undefined, name: string, host: string): CachedUsage | undefined {
  if (!storagePath) { return undefined; }
  const dir = join(storagePath, 'accessories');
  let files: string[];
  try { files = readdirSync(dir).filter((f) => f.startsWith('cachedAccessories')); } catch { return undefined; }
  for (const file of files) {
    try {
      const list = JSON.parse(readFileSync(join(dir, file), 'utf8')) as {
        platform?: string; context?: { name?: string; host?: string; usage?: UsageSample[]; snmpAnswered?: boolean };
      }[];
      const hit = list.find((a) => a.platform === 'BrotherPrinter' && a.context?.host === host && (a.context?.name ?? name) === name);
      if (hit?.context?.usage) { return { samples: hit.context.usage, snmpAnswered: hit.context.snmpAnswered === true }; }
    } catch { /* unreadable or being written: no history */ }
  }
  return undefined;
}

/** Read one printer with the settings as entered (not yet saved) */
export async function testPrinter(entry: unknown, read = readPrinter, storagePath?: string): Promise<TestResult> {
  const config = (entry && typeof entry === 'object' ? entry : {}) as Partial<PrinterConfig> & Record<string, unknown>;
  if (!String(config.host ?? '').trim()) { throw new Error('Enter the printer\'s IP address or hostname first.'); }
  const options = queryOptions({ ...config, name: String(config.name || 'Printer'), host: String(config.host) });
  try {
    const d = await read({ ...options, timeout: 3000, retries: 0, trays: true });
    return testSummary(d, cachedUsage(storagePath, String(config.name || 'Printer').trim(), options.host));
  } catch (err) {
    const what = options.protocol === 'ipp' ? 'IPP' : options.protocol === 'auto' ? 'SNMP or IPP' : 'SNMP';
    throw new Error(`Couldn't read ${options.host}: ${errorText(err)}. Check the address, that ${what} is on in the `
      + `printer's web page (Network > Protocol), and the ${what} settings.`, { cause: err });
  }
}

export class BrotherPrinterUiServer extends HomebridgePluginUiServer {
  constructor() {
    super();
    this.onRequest('/discover', async (payload: unknown) => {
      const community = (payload as { community?: unknown } | null)?.community;
      try {
        return await discover({ community: typeof community === 'string' && community ? community : 'public' });
      } catch (err) {
        throw new RequestError(`Search failed: ${errorText(err)}`, {});
      }
    });
    this.onRequest('/test', async (payload: unknown) => {
      try {
        return await testPrinter(payload, readPrinter, this.homebridgeStoragePath);
      } catch (err) {
        throw new RequestError(errorText(err), {});
      }
    });
    this.ready();
  }
}

// Started as a process by the Homebridge UI; tests import the functions above
if (require.main === module) {
  new BrotherPrinterUiServer();
}
