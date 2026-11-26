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
import { query } from '../snmp';
import type { QueryResult } from '../snmp';

export interface TestResult {
  model: string | null;
  serial: string | null;
  snmpVersion: string;
  status: string;
  levels: string;
  drum: string | null;
  pages: number | null;
}

const errorText = (err: unknown): string => (err as { message?: string } | null)?.message || String(err);

export function testSummary(d: QueryResult): TestResult {
  const kind = d.type === 'ink' ? 'ink' : 'toner';
  const levels = d.supplies.length
    ? d.supplies.map((s) => (d.supplies.length === 1 ? `${kind} ${s.level}%` : `${s.color} ${s.level}%`)).join(', ')
    : `no ${kind} levels reported`;
  return {
    model: d.model,
    serial: d.serial,
    snmpVersion: d.snmpVersion,
    status: d.statusText || (d.printing ? 'printing' : d.fault ? 'problem' : 'unknown'),
    levels,
    drum: d.drumPercent !== null ? `${d.drumPercent}%` : null,
    pages: d.totalPages,
  };
}

/** Read one printer with the settings as entered (not yet saved) */
export async function testPrinter(entry: unknown, read = query): Promise<TestResult> {
  const config = (entry && typeof entry === 'object' ? entry : {}) as Partial<PrinterConfig> & Record<string, unknown>;
  if (!String(config.host ?? '').trim()) { throw new Error('Enter the printer\'s IP address or hostname first.'); }
  const options = queryOptions({ ...config, name: String(config.name || 'Printer'), host: String(config.host) });
  try {
    return testSummary(await read({ ...options, timeout: 3000, retries: 0 }));
  } catch (err) {
    throw new Error(`Couldn't read ${options.host}: ${errorText(err)}. Check the address, that SNMP is on in the `
      + 'printer\'s web page (Network > Protocol), and the SNMP settings.', { cause: err });
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
        return await testPrinter(payload);
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
