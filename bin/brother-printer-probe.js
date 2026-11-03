#!/usr/bin/env node
'use strict';

/*
 * Quick check from the command line:
 *   npx brother-printer-probe 10.0.4.150 [community]
 * Prints what the plugin would read from the printer.
 */

const { query } = require('../lib/snmp');

const [target, community = 'public'] = process.argv.slice(2);
const [host, port] = (target || '').split(':');
if (!host) {
  console.error('Usage: brother-printer-probe <printer-ip-or-hostname[:port]> [community]');
  process.exit(2);
}

query({ host, port: Number(port) || 161, community })
  .then((d) => {
    console.log(JSON.stringify(d, null, 2));
  })
  .catch((err) => {
    console.error(`Couldn't read ${host}: ${err.message}`);
    console.error('Check the address, and that SNMP is enabled on the printer (Network > Protocol).');
    process.exit(1);
  });
