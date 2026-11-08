'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const d = require('../dist/decode');
const { parse } = require('../dist/snmp');
const fx = require('./fixtures');

test('maintenance blob matches the printer web page', () => {
  const m = d.decodeMaintenance(fx.maintenance, fx.nextCare);
  assert.deepEqual(m.supplies.black, { level: 70, fine: 63, status: 7 });
  assert.equal(m.drums.black.percent, 60);
  assert.equal(m.drums.black.pagesUsed, 4886);
  assert.deepEqual(m.unknown, {});
  assert.deepEqual(d.supplyList(m.supplies), [{ color: 'black', level: 70, fine: 63 }]);
});

test('counters and next-care', () => {
  assert.deepEqual(d.decodeCounters(fx.counters), { totalPages: 4886, duplexPages: 1630 });
  assert.equal(d.decodeMaintenance(fx.maintenance, fx.nextCare).drums.black.pagesRemaining, 7114);
});

test('drum used + remaining equals the 12,000 page rating', () => {
  const drum = d.decodeMaintenance(fx.maintenance, fx.nextCare).drums.black;
  assert.equal(drum.pagesUsed + drum.pagesRemaining, 12000);
});

test('MFC-L2750DW is a mono laser', () => {
  const raw = {};
  for (const [k, v] of Object.entries(fx)) { raw[k] = d.toBuffer(v); }
  const r = parse(raw);
  assert.equal(r.type, 'laser');
  assert.equal(r.supplies.length, 1);
  assert.equal(r.lowestSupply.level, 70);
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
