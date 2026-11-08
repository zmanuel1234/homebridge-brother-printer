'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { query } = require('../dist/snmp');
const { startFakePrinter } = require('./fake-agent');

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
  const state = {};
  const r = await query({ host: '127.0.0.1', port: 16170, version: '1', state });
  assert.equal(r.snmpVersion, '1');
  assert.equal(r.tonerPercent, 70);
  assert.equal(r.printerStatus, null);
  assert.equal(r.model, null);
});

test('auto: uses v2c when it answers and remembers it', async (t) => {
  const printer = await startFakePrinter(16171);
  t.after(() => printer.close());
  const state = {};
  const r = await query({ host: '127.0.0.1', port: 16171, state });
  assert.equal(r.snmpVersion, '2c');
  assert.equal(state.version, '2c');
});
