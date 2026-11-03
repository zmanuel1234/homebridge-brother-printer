'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const d = require('../lib/decode');
const { parse } = require('../lib/snmp');
const fx = require('./fixtures');

test('maintenance blob matches the printer web page', () => {
  const m = d.decodeMaintenance(fx.maintenance);
  assert.equal(m.tonerPercent, 70);
  assert.equal(m.drumPercent, 60);
  assert.equal(m.drumPagesUsed, 4886);
  assert.equal(m.tonerPercentFine, 63);
  assert.equal(m.unknown, undefined);
});

test('counters and next-care', () => {
  assert.deepEqual(d.decodeCounters(fx.counters), { totalPages: 4886, duplexPages: 1630 });
  assert.deepEqual(d.decodeNextCare(fx.nextCare), { drumPagesRemaining: 7114 });
});

test('drum used + remaining equals the 12,000 page rating', () => {
  const used = d.decodeMaintenance(fx.maintenance).drumPagesUsed;
  const left = d.decodeNextCare(fx.nextCare).drumPagesRemaining;
  assert.equal(used + left, 12000);
});

test('text fields', () => {
  assert.equal(d.decodeText(fx.statusText), 'Sleep');
  assert.equal(d.decodeText(fx.model), 'Brother MFC-L2750DW series');
  assert.equal(d.decodeText(Buffer.from('Ready  \0')), 'Ready');
});

test('parse() with Buffers like net-snmp returns', () => {
  const raw = {};
  for (const [k, v] of Object.entries(fx)) { raw[k] = d.toBuffer(v); }
  raw.printerStatus = 3;
  raw.errorState = Buffer.from([0x00]);
  const r = parse(raw);
  assert.equal(r.model, 'Brother MFC-L2750DW series');
  assert.equal(r.tonerPercent, 70);
  assert.equal(r.drumPercent, 60);
  assert.equal(r.totalPages, 4886);
  assert.equal(r.printing, false);
  assert.equal(r.fault, false);
  assert.equal(r.sleeping, true);
});

test('missing OIDs come back as null, not crashes', () => {
  const r = parse({});
  assert.equal(r.tonerPercent, null);
  assert.equal(r.statusText, '');
  assert.equal(r.printing, false);
});

test('truncated or garbage blobs are ignored safely', () => {
  assert.deepEqual(d.parseRecords('81 01 04 00 00'), []);
  assert.deepEqual(d.parseRecords('zz'), []);
  assert.deepEqual(d.parseRecords(null), []);
  assert.deepEqual(d.parseRecords(Buffer.from([0x81, 0x01, 0x00])), []);
});

test('error-state bits', () => {
  assert.deepEqual(d.decodeErrorState(Buffer.from([0x04])), ['jammed']);
  assert.deepEqual(d.decodeErrorState(Buffer.from([0x20])), ['lowToner']);
  assert.deepEqual(d.decodeErrorState(Buffer.from([0x48, 0x00])), ['noPaper', 'doorOpen']);
});

test('status summary', () => {
  const s = (statusText, extra = {}) => d.summarizeStatus({ statusText, ...extra });
  assert.equal(s('Printing').printing, true);
  assert.equal(s('Ready').printing, false);
  assert.equal(s('Sleep').printing, false);
  assert.equal(s('', { printerStatus: 4 }).printing, true);
  assert.equal(s('Paper Jam').fault, true);
  assert.equal(s('Cover is Open').fault, true);
  assert.equal(s('No Paper T1').fault, true);
  assert.equal(s('Replace Toner').fault, true);
  assert.equal(s('Print Unable 1A').fault, true);
  assert.equal(s('Print Unable 1A').printing, false);
  assert.equal(s('Toner Low').fault, false);
  assert.equal(s('Drum End Soon').fault, false);
  assert.equal(s('Ready', { errors: ['lowToner'] }).fault, false);
  assert.equal(s('Ready', { errors: ['jammed'] }).fault, true);
});
