import test from 'node:test';
import assert from 'node:assert/strict';
import * as snmpLib from 'net-snmp';
import { AUTH_PROTOCOLS, OID, PRIV_PROTOCOLS, protocolSetting, query, v3User } from '../src/snmp';
import type { QueryOptions } from '../src/snmp';
import { startFakePrinter } from './fake-agent';

const PORT = 16161;

test('reads a fake MFC-L2750DW over real SNMP', async (t) => {
  const printer = await startFakePrinter(PORT);
  t.after(() => printer.close());

  const r = await query({ host: '127.0.0.1', port: PORT });
  assert.equal(r.model, 'Brother MFC-L2750DW series');
  assert.equal(r.statusText, 'Sleep');
  assert.equal(r.printerStatus, 3);
  assert.equal(r.tonerPercent, 70);
  assert.equal(r.drumPercent, 60);
  assert.equal(r.drumPagesRemaining, 7114);
  assert.equal(r.totalPages, 4886);
  assert.equal(r.printing, false);
  assert.equal(r.fault, false);

  printer.set('printerStatus', 4);
  printer.set('statusText', Buffer.from('Printing'));
  const p = await query({ host: '127.0.0.1', port: PORT });
  assert.equal(p.printing, true);

  printer.set('printerStatus', 3);
  printer.set('statusText', Buffer.from('Paper Jam'));
  printer.set('errorState', Buffer.from([0x04]));
  const j = await query({ host: '127.0.0.1', port: PORT });
  assert.equal(j.fault, true);
  assert.deepEqual(j.errors, ['jammed']);
});

test('unreachable printer rejects instead of hanging', async () => {
  await assert.rejects(query({ host: '127.0.0.1', port: 16199, timeout: 300, retries: 0 }));
});

test('SNMP v1: drops OIDs the printer lacks and still reads the rest', async (t) => {
  // An old printer: no Host Resources printer table, no device ID
  const printer = await startFakePrinter(16170, { printerStatus: undefined, errorState: undefined, model: undefined });
  t.after(() => printer.close());
  const state: QueryOptions['state'] = {};
  const r = await query({ host: '127.0.0.1', port: 16170, version: '1', state });
  assert.equal(r.snmpVersion, '1');
  assert.equal(r.tonerPercent, 70);
  assert.equal(r.printerStatus, null);
  assert.equal(r.model, null);
});

test('SNMP v1: OIDs a printer refuses with noSuchName aren\'t asked for again', async (t) => {
  // A v1 agent that refuses the whole request for an OID it lacks (net-snmp's own agent doesn't)
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const lib = require('net-snmp') as { createSession: typeof snmpLib.createSession };
  const real = lib.createSession;
  t.after(() => { lib.createSession = real; });
  const asked: string[][] = [];
  const lacks = new Set<string>([OID.brFirmware, OID.deviceId]);
  lib.createSession = (() => ({
    on: () => {},
    close: () => {},
    get: (oids: string[], cb: (err: Error | null, vbs?: snmpLib.Varbind[]) => void) => {
      asked.push(oids);
      const bad = oids.find((o) => lacks.has(o));
      if (bad) { const e = new Error(`NoSuchName: ${bad}`); e.name = 'RequestFailedError'; cb(e); return; }
      cb(null, oids.map((oid) => ({ oid, type: 4, value: oid === OID.model ? Buffer.from('Old printer') : null } as unknown as snmpLib.Varbind)));
    },
    subtree: (_o: string, _m: number, _f: unknown, done: (err?: Error) => void) => done(),
    getNext: (_o: string[], cb: (err: Error | null, vbs?: snmpLib.Varbind[]) => void) => cb(new Error('NoSuchName: end'), []),
  })) as unknown as typeof snmpLib.createSession;
  const state: QueryOptions['state'] = {};
  const r = await query({ host: '10.0.0.1', version: '1', state });
  assert.equal(r.model, 'Old printer');
  assert.deepEqual(new Set(state.missing), new Set(['brFirmware', 'deviceId']));
  const first = asked.length;
  asked.length = 0;
  await query({ host: '10.0.0.1', version: '1', state });
  assert.equal(asked.length, 1, `one request the second time (${first} the first)`);
  assert.ok(!asked[0].includes(OID.brFirmware));
});

test('auto: uses v2c when it answers and remembers it', async (t) => {
  const printer = await startFakePrinter(16171);
  t.after(() => printer.close());
  const state: QueryOptions['state'] = {};
  const r = await query({ host: '127.0.0.1', port: 16171, state });
  assert.equal(r.snmpVersion, '2c');
  assert.equal(state.version, '2c');
});

/* ------------------------------------------------------------------ SNMPv3 */

const V3_USER: snmpLib.User = {
  name: 'homebridge',
  level: snmpLib.SecurityLevel.authPriv,
  authProtocol: snmpLib.AuthProtocols.sha,
  authKey: 'auth-pass-1',
  privProtocol: snmpLib.PrivProtocols.aes,
  privKey: 'priv-pass-1',
};

test('SNMPv3: reads with authentication and encryption', async (t) => {
  const printer = await startFakePrinter(16180, {}, [V3_USER]);
  t.after(() => printer.close());
  const r = await query({
    host: '127.0.0.1', port: 16180, version: '3', timeout: 1000, retries: 0,
    v3: { user: 'homebridge', authProtocol: 'sha', authPassword: 'auth-pass-1', privProtocol: 'aes', privPassword: 'priv-pass-1' },
  });
  assert.equal(r.snmpVersion, '3');
  assert.equal(r.tonerPercent, 70);
  assert.equal(r.model, 'Brother MFC-L2750DW series');
});

test('SNMPv3: a wrong password is refused', async (t) => {
  const printer = await startFakePrinter(16181, {}, [V3_USER]);
  t.after(() => printer.close());
  await assert.rejects(query({
    host: '127.0.0.1', port: 16181, version: '3', timeout: 500, retries: 0,
    v3: { user: 'homebridge', authProtocol: 'sha', authPassword: 'wrong-pass', privProtocol: 'aes', privPassword: 'priv-pass-1' },
  }));
});

test('SNMPv3: the security level follows the protocols set', () => {
  assert.equal(v3User({ user: 'u' }).level, snmpLib.SecurityLevel.noAuthNoPriv);
  assert.equal(v3User({ user: 'u', authProtocol: 'md5', authPassword: '12345678' }).level, snmpLib.SecurityLevel.authNoPriv);
  const full = v3User({ user: 'u', authProtocol: 'sha256', authPassword: '12345678', privProtocol: 'des', privPassword: '87654321' });
  assert.equal(full.level, snmpLib.SecurityLevel.authPriv);
  assert.equal(full.authProtocol, snmpLib.AuthProtocols.sha256);
  assert.equal(full.privProtocol, snmpLib.PrivProtocols.des);
});

test('SNMPv3: settings that can\'t work are refused with a clear reason', () => {
  assert.throws(() => v3User(undefined), /user name/);
  assert.throws(() => v3User({ user: '' }), /user name/);
  assert.throws(() => v3User({ user: 'u', privProtocol: 'aes', privPassword: '12345678' }), /needs authentication/);
  assert.throws(() => v3User({ user: 'u', authProtocol: 'sha', authPassword: 'short' }), /at least 8/);
  assert.throws(() => v3User({ user: 'u', authProtocol: 'sha', authPassword: '12345678', privProtocol: 'aes' }), /at least 8/);
});

test('SNMPv3: authentication without encryption works end to end', async (t) => {
  const user: snmpLib.User = {
    name: 'reader', level: snmpLib.SecurityLevel.authNoPriv, authProtocol: snmpLib.AuthProtocols.sha256, authKey: 'auth-pass-2',
  };
  const printer = await startFakePrinter(16182, {}, [user]);
  t.after(() => printer.close());
  const r = await query({
    host: '127.0.0.1', port: 16182, version: '3', timeout: 1000, retries: 0,
    v3: { user: 'reader', authProtocol: 'sha256', authPassword: 'auth-pass-2', privProtocol: 'none' },
  });
  assert.equal(r.tonerPercent, 70);
});

test('SNMPv3: protocol settings accept common spellings and refuse unknown ones', () => {
  assert.equal(protocolSetting(undefined, AUTH_PROTOCOLS, 'sha', 'authentication'), 'sha');
  assert.equal(protocolSetting('', AUTH_PROTOCOLS, 'sha', 'authentication'), 'sha');
  assert.equal(protocolSetting('SHA-256', AUTH_PROTOCOLS, 'sha', 'authentication'), 'sha256');
  assert.equal(protocolSetting('SHA1', AUTH_PROTOCOLS, 'sha', 'authentication'), 'sha');
  assert.equal(protocolSetting('AES128', PRIV_PROTOCOLS, 'aes', 'encryption'), 'aes');
  assert.equal(protocolSetting('None', PRIV_PROTOCOLS, 'aes', 'encryption'), 'none');
  assert.throws(() => protocolSetting('3des', PRIV_PROTOCOLS, 'aes', 'encryption'), /encryption "3des" isn't supported/);
});
