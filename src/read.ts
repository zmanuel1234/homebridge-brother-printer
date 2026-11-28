/*
 * Reading a printer by the protocol its settings ask for: SNMP (Brother's own
 * records, the most detail), IPP (AirPrint, when SNMP is off or gives no
 * levels), or auto: SNMP, and IPP when SNMP doesn't answer.
 */
import { ippQuery } from './ipp.js';
import { query } from './snmp.js';
import type { QueryOptions, QueryResult } from './snmp.js';

/** The IPP address Brother printers use, for a host name or address */
export function defaultIppUrl(host: string): string {
  return `ipp://${host.includes(':') && !host.startsWith('[') ? `[${host}]` : host}:631/ipp/print`;
}

export async function readIpp(options: QueryOptions): Promise<QueryResult> {
  const data = await ippQuery({
    url: options.ippUrl || defaultIppUrl(options.host),
    timeout: options.timeout ?? 5000,
    allowSelfSigned: options.ippAllowSelfSigned === true,
  });
  return { ...data, snmpVersion: null, via: 'ipp' };
}

const message = (err: unknown): string => (err as { message?: string } | null)?.message || String(err);

/** The two readers, as an object tests can stand in for */
export const readers = { query, readIpp };

/** Read the printer. Rejects only when it can't be read by any allowed protocol. */
export async function readPrinter(options: QueryOptions): Promise<QueryResult> {
  const { query: readSnmp, readIpp: readOverIpp } = readers;
  const protocol = options.protocol ?? 'snmp';
  if (protocol === 'ipp') { return readOverIpp(options); }
  if (protocol === 'snmp') { return readSnmp(options); }

  // auto: SNMP on every poll, since it has the most detail; IPP only when SNMP
  // doesn't answer, so one lost packet doesn't change what Home shows for long
  let snmp: QueryResult;
  try {
    snmp = await readSnmp(options);
  } catch (snmpErr) {
    try {
      return await readOverIpp(options);
    } catch (ippErr) {
      throw new Error(`SNMP: ${message(snmpErr)}; IPP: ${message(ippErr)}`, { cause: ippErr });
    }
  }
  // SNMP answered but its supplies table didn't: IPP's levels stand in for this poll
  if (snmp.suppliesUnread) {
    try { return await readOverIpp(options); } catch { /* SNMP's reading, without supplies */ }
  }
  return snmp;
}
