'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { query } = require('../lib/snmp');
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
