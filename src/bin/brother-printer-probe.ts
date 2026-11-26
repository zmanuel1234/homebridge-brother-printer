#!/usr/bin/env node

/*
 * Quick check from the command line:
 *   npx brother-printer-probe 10.0.4.150 [community]
 *   npx brother-printer-probe 10.0.4.150 --v3 <user> [--auth sha] [--auth-pass <pw>] [--priv aes] [--priv-pass <pw>]
 * Prints what the plugin would read from the printer.
 */

import { AUTH_PROTOCOLS, PRIV_PROTOCOLS, query } from '../snmp';
import type { AuthProtocol, PrivProtocol, QueryOptions } from '../snmp';

const USAGE = `Usage: brother-printer-probe <printer-ip-or-hostname[:port]> [community]
       brother-printer-probe <printer[:port]> --v3 <user> [--auth ${AUTH_PROTOCOLS.join('|')}] [--auth-pass <password>]
                             [--priv ${PRIV_PROTOCOLS.join('|')}] [--priv-pass <password>]
SNMPv3 defaults to SHA authentication and AES encryption; use --auth none or --priv none to turn them off.`;

function fail(message: string): never {
  console.error(message);
  process.exit(2);
}

const args = process.argv.slice(2);
const positional: string[] = [];
const flags: Record<string, string> = {};
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '-h' || a === '--help') { console.log(USAGE); process.exit(0); }
  if (!a.startsWith('--')) { positional.push(a); continue; }
  const value = args[i + 1];
  if (value === undefined || value.startsWith('--')) { fail(`${a} needs a value.\n${USAGE}`); }
  flags[a.slice(2)] = value;
  i++;
}
const known = ['v3', 'auth', 'auth-pass', 'priv', 'priv-pass'];
const unknown = Object.keys(flags).find((k) => !known.includes(k));
if (unknown) { fail(`Unknown option --${unknown}.\n${USAGE}`); }

const [target, community = 'public'] = positional;
const [host, port] = (target || '').split(':');
if (!host) { fail(USAGE); }

const options: QueryOptions = { host, port: Number(port) || 161, community };
if (flags.v3 !== undefined) {
  const auth = flags.auth ?? 'sha';
  const priv = flags.priv ?? 'aes';
  if (!(AUTH_PROTOCOLS as readonly string[]).includes(auth)) { fail(`--auth must be one of ${AUTH_PROTOCOLS.join(', ')}.`); }
  if (!(PRIV_PROTOCOLS as readonly string[]).includes(priv)) { fail(`--priv must be one of ${PRIV_PROTOCOLS.join(', ')}.`); }
  options.version = '3';
  options.v3 = {
    user: flags.v3,
    authProtocol: auth as AuthProtocol,
    authPassword: flags['auth-pass'] ?? '',
    privProtocol: priv as PrivProtocol,
    privPassword: flags['priv-pass'] ?? '',
  };
} else if (Object.keys(flags).length) {
  fail(`--auth, --priv and their passwords need --v3 <user>.\n${USAGE}`);
}

query(options)
  .then((d) => {
    console.log(JSON.stringify(d, null, 2));
  })
  .catch((err: unknown) => {
    const e = err as { message?: string } | null;
    console.error(`Couldn't read ${host}: ${e?.message || String(err)}`);
    console.error('Check the address, and that SNMP is enabled on the printer (Network > Protocol).');
    if (options.version === '3') { console.error('For SNMPv3, also check the user name, protocols and passwords.'); }
    process.exit(1);
  });
