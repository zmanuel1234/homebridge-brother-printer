// Page counts by kind: color, black-and-white and two-sided, over SNMP (Brother's
// counter record) and IPP (printer-impressions-completed-col), and where they show.
import test from 'node:test';
import assert from 'node:assert/strict';
import { countsByKind, parseResponse, toPrinterData, REQUESTED } from '../src/ipp';
import { monoPages, pageDetail, testSummary } from '../src/summary';
import * as snmp from '../src/snmp';
import type { QueryResult } from '../src/snmp';
import modelsJson from './fixtures/brother-models.json';

const models = modelsJson as unknown as Record<string, { raw: snmp.RawReadings }>;
const fromModel = (name: string): QueryResult => ({ ...snmp.parse(models[name].raw), snmpVersion: '2c' });

/** One IPP attribute value, encoded */
function value(tag: number, name: string, data: Buffer): Buffer {
  const n = Buffer.from(name);
  const head = Buffer.alloc(3);
  head[0] = tag;
  head.writeUInt16BE(n.length, 1);
  const len = Buffer.alloc(2);
  len.writeUInt16BE(data.length);
  return Buffer.concat([head, n, len, data]);
}
const int = (v: number): Buffer => { const b = Buffer.alloc(4); b.writeInt32BE(v); return b; };
const member = (name: string, v: number): Buffer[] => [value(0x4a, '', Buffer.from(name)), value(0x21, '', int(v))];

/** A Get-Printer-Attributes response with the given printer attributes */
function response(...attrs: Buffer[]): Buffer {
  return Buffer.concat([Buffer.from([2, 0, 0, 0, 0, 0, 0, 1, 0x01]),
    value(0x47, 'attributes-charset', Buffer.from('utf-8')), Buffer.from([0x04]), ...attrs, Buffer.from([0x03])]);
}

test('IPP: the counts collection is asked for', () => {
  assert.ok(REQUESTED.includes('printer-impressions-completed-col'));
});

test('IPP: color, black-and-white and two-sided pages from printer-impressions-completed-col', () => {
  const buf = response(
    value(0x21, 'printer-impressions-completed', int(1500)),
    value(0x34, 'printer-impressions-completed-col', Buffer.alloc(0)),
    ...member('monochrome', 1100), ...member('full-color', 400), ...member('monochrome-two-sided', 300),
    ...member('full-color-two-sided', 20),
    // A nested collection's members aren't counts
    value(0x4a, '', Buffer.from('other')), value(0x34, '', Buffer.alloc(0)), ...member('full-color', 999), value(0x37, '', Buffer.alloc(0)),
    value(0x37, '', Buffer.alloc(0)),
    value(0x21, 'marker-levels', int(70)),
  );
  const a = parseResponse(buf).printer;
  assert.deepEqual(a['printer-impressions-completed-col.full-color'], [400]);
  assert.deepEqual(a['marker-levels'], [70], 'attributes after the collection still read');
  assert.deepEqual(countsByKind(a), { colorPages: 400, monoPages: 1100, duplexPages: 320 });
  const d = toPrinterData(a);
  assert.equal(d.totalPages, 1500);
  assert.equal(d.colorPages, 400);
  assert.equal(pageDetail(d), '1,100 black-and-white, 400 color, 320 two-sided');
});

test('IPP: without the collection, no counts by kind', () => {
  const d = toPrinterData(parseResponse(response(value(0x21, 'printer-impressions-completed', int(10)))).printer);
  assert.equal(d.colorPages, null);
  assert.equal(d.duplexPages, null);
  assert.equal(pageDetail(d), null);
});

test('SNMP (Brother): counts by kind from the counter record', () => {
  const color = fromModel('dcp-l3550cdw');
  assert.equal(pageDetail(color), '709 black-and-white, 902 color, 538 two-sided');
  const mono = fromModel('hl-l2340dw');
  assert.equal(monoPages(mono), null, 'a black-and-white printer: just the total');
  assert.equal(pageDetail(mono), null);
});

test('black-and-white pages are the total less color ones when not given', () => {
  assert.equal(monoPages({ ...fromModel('hl-l2340dw'), totalPages: 100, colorPages: 30, monoPages: null }), 70);
  assert.equal(monoPages({ ...fromModel('hl-l2340dw'), totalPages: 10, colorPages: 30, monoPages: null }), null, 'not below zero');
});

test('Test connection and the dashboards get the breakdown', () => {
  assert.equal(testSummary(fromModel('dcp-t735dw')).pageDetail, '279 black-and-white, 1,031 color, 734 two-sided');
});

test('IPP: two-sided impressions counted apart from the one-sided ones are added in (the total says so)', () => {
  const a = { 'printer-impressions-completed': [1500], 'printer-impressions-completed-col.monochrome': [900],
    'printer-impressions-completed-col.full-color': [280], 'printer-impressions-completed-col.monochrome-two-sided': [300],
    'printer-impressions-completed-col.full-color-two-sided': [20] };
  assert.deepEqual(countsByKind(a), { colorPages: 300, monoPages: 1200, duplexPages: 320 });
});

test('IPP: a black-and-white printer\'s "0 color" gives no breakdown', () => {
  const buf = response(
    value(0x21, 'printer-impressions-completed', int(50)),
    value(0x34, 'printer-impressions-completed-col', Buffer.alloc(0)), ...member('monochrome', 50), ...member('full-color', 0),
    value(0x37, '', Buffer.alloc(0)),
    value(0x42, 'marker-names', Buffer.from('Black')), value(0x44, 'marker-types', Buffer.from('toner')),
    value(0x42, 'marker-colors', Buffer.from('#000000')), value(0x21, 'marker-levels', int(60)), value(0x21, 'marker-high-levels', int(100)),
  );
  const d = toPrinterData(parseResponse(buf).printer);
  assert.equal(d.colorPages, null);
  assert.equal(pageDetail(d), null);
});

test('SNMP (Brother): the main firmware, shown in Test connection', () => {
  const raw = { ...models['hl-l2340dw'].raw, brFirmware: Buffer.from('ZE2505240255') };
  const d = { ...snmp.parse(raw), snmpVersion: '2c' as const };
  assert.equal(d.firmware, 'ZE2505240255');
  assert.equal(testSummary(d).firmware, 'ZE2505240255');
  assert.equal(snmp.parse(models['hl-l2340dw'].raw).firmware, undefined, 'none without it');
});
