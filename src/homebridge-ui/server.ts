/*
 * The settings screen's server side (Homebridge UI custom UI): searching the
 * network for printers, testing a printer's settings, and its report.
 * It runs in its own process, started by the Homebridge UI while the plugin's
 * settings are open.
 */
import { HomebridgePluginUiServer, RequestError } from '@homebridge/plugin-ui-utils';
import { discover } from '../discover';
import { queryOptions } from '../accessory';
import type { PrinterConfig } from '../accessory';
import { readPrinter } from '../read';
import type { UsageSample } from '../usage';
import { testSummary } from '../summary';
import type { CachedUsage, TestResult } from '../summary';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { buildReport } from '../report';

export { testSummary } from '../summary';
export type { CachedUsage, TestResult } from '../summary';

const errorText = (err: unknown): string => (err as { message?: string } | null)?.message || String(err);

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
        platform?: string; context?: { name?: string; host?: string; usage?: UsageSample[]; snmpAnswered?: boolean; noBulk?: boolean;
          moved?: { from?: string; to?: string; ippUrl?: string } };
      }[];
      const hit = list.find((a) => a.platform === 'BrotherPrinter' && a.context?.host === host && (a.context?.name ?? name) === name);
      const moved = hit?.context?.moved;
      if (hit?.context) {
        return {
          samples: hit.context.usage ?? [], snmpAnswered: hit.context.snmpAnswered === true,
          ...(hit.context.noBulk ? { noBulk: true } : {}),
          ...(moved?.to && moved.from === host ? { movedTo: moved.to, movedIppUrl: moved.ippUrl } : {}),
        };
      }
    } catch { /* unreadable or being written: no history */ }
  }
  return undefined;
}

/** Read one printer with the settings as entered (not yet saved) */
export async function testPrinter(entry: unknown, read = readPrinter, storagePath?: string): Promise<TestResult> {
  const config = (entry && typeof entry === 'object' ? entry : {}) as Partial<PrinterConfig> & Record<string, unknown>;
  if (!String(config.host ?? '').trim()) { throw new Error('Enter the printer\'s IP address or hostname first.'); }
  const options = queryOptions({ ...config, name: String(config.name || 'Printer'), host: String(config.host) });
  const cached = cachedUsage(storagePath, String(config.name || 'Printer').trim(), options.host);
  // The plugin found the printer at another address: read it there, and say so
  if (cached?.movedTo) {
    options.host = cached.movedTo;
    if (cached.movedIppUrl) { options.ippUrl = cached.movedIppUrl; }
  }
  // Known not to answer bulk requests: read row by row straight away
  if (cached?.noBulk) { options.state = { ...options.state, noBulk: true }; }
  try {
    const d = await read({ ...options, timeout: 3000, retries: 0, trays: true });
    return { ...testSummary(d, cached, options.protocol), ...(cached?.movedTo ? { movedTo: cached.movedTo } : {}) };
  } catch (err) {
    const what = options.protocol === 'ipp' ? 'IPP' : options.protocol === 'auto' ? 'SNMP or IPP' : 'SNMP';
    throw new Error(`Couldn't read ${options.host}: ${errorText(err)}. Check the address, that ${what} is on in the `
      + `printer's web page (Network > Protocol), and the ${what} settings.`, { cause: err });
  }
}

/** The report for "Copy a report", for the settings as entered */
export async function printerReport(entry: unknown, storagePath?: string): Promise<string> {
  const config = (entry && typeof entry === 'object' ? entry : {}) as Partial<PrinterConfig> & Record<string, unknown>;
  if (!String(config.host ?? '').trim()) { throw new Error('Enter the printer\'s IP address or hostname first.'); }
  const options = queryOptions({ ...config, name: String(config.name || 'Printer'), host: String(config.host) });
  const cached = cachedUsage(storagePath, String(config.name || 'Printer').trim(), options.host);
  if (cached?.noBulk) { options.state = { ...options.state, noBulk: true }; }
  return buildReport(config, options);
}

export class BrotherPrinterUiServer extends HomebridgePluginUiServer {
  constructor() {
    super();
    this.onRequest('/discover', async (payload: unknown) => {
      const community = (payload as { community?: unknown } | null)?.community;
      try {
        return await discover({ community: typeof community === 'string' && community ? community : 'public', wait: 2500 });
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
    this.onRequest('/report', async (payload: unknown) => {
      try {
        return { text: await printerReport(payload, this.homebridgeStoragePath) };
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
