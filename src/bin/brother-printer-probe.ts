#!/usr/bin/env node

/*
 * Quick check from the command line:
 *   npx brother-printer-probe 10.0.4.150 [community]
 *   npx brother-printer-probe 10.0.4.150 --v3 <user> [--auth sha] [--auth-pass <pw>] [--priv aes] [--priv-pass <pw>]
 * Prints what the plugin would read from the printer.
 */

import { AUTH_PROTOCOLS, PRIV_PROTOCOLS, protocolSetting, query, v3User } from '../snmp';
import type { QueryOptions } from '../snmp';

const USAGE = `Usage: brother-printer-probe <printer-ip-or-hostname[:port]> [community]
       brother-printer-probe <printer[:port]> --v3 <user> [--auth ${AUTH_PROTOCOLS.join('|')}] [--auth-pass <password>]
                             [--priv ${PRIV_PROTOCOLS.join('|')}] [--priv-pass <password>] [--context <name>]
SNMPv3 defaults to SHA authentication and AES encryption. --priv none turns encryption off;
--auth none needs --priv none too. Passwords given as options are saved in your shell
history and visible in the process list; to avoid that, set the environment variables
BROTHER_SNMP_AUTH_PASS and BROTHER_SNMP_PRIV_PASS with \`read -rs\` and \`export\` instead.`;

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
  if (!a.startsWith('-')) { positional.push(a); continue; }
  if (!a.startsWith('--')) { fail(`Unknown option ${a} (options start with --).\n${USAGE}`); }
  const value = args[i + 1];
  if (value === undefined) { fail(`${a} needs a value.\n${USAGE}`); }
  flags[a.slice(2)] = value;
  i++;
}
const known = ['v3', 'auth', 'auth-pass', 'priv', 'priv-pass', 'context'];
const unknown = Object.keys(flags).find((k) => !known.includes(k));
if (unknown) { fail(`Unknown option --${unknown}.\n${USAGE}`); }

if (positional.length > 2) { fail(`Too many arguments.\n${USAGE}`); }
const [target, community = 'public'] = positional;
const [host, port] = (target || '').split(':');
if (!host) { fail(USAGE); }

const options: QueryOptions = { host, port: Number(port) || 161, community };
if (flags.v3 !== undefined) {
  if (!flags.v3 || flags.v3.startsWith('-')) { fail(`--v3 needs a user name.\n${USAGE}`); }
  if (positional.length > 1) { fail('A community string is for SNMP v1/v2c; leave it out with --v3.'); }
  options.version = '3';
  try {
    options.v3 = {
      user: flags.v3,
      authProtocol: protocolSetting(flags.auth, AUTH_PROTOCOLS, 'sha', 'authentication'),
      authPassword: flags['auth-pass'] ?? process.env.BROTHER_SNMP_AUTH_PASS ?? '',
      privProtocol: protocolSetting(flags.priv, PRIV_PROTOCOLS, 'aes', 'encryption'),
      privPassword: flags['priv-pass'] ?? process.env.BROTHER_SNMP_PRIV_PASS ?? '',
      context: flags.context ?? '',
    };
    v3User(options.v3);
  } catch (err) {
    fail(`${(err as Error).message}.\n${USAGE}`);
  }
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
