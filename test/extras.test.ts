// Paper type per tray, printer uptime, and the output tray full sensor's reading.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mediaName, traysFromIpp, traysFromTable } from '../src/trays';
import { INPUT_TABLE, parse } from '../src/snmp';
import { REQUESTED, toPrinterData } from '../src/ipp';
import { describeUptime, pageDetail, shownCounts, testSummary } from '../src/summary';
import type * as snmp from '../src/snmp';
import modelsJson from './fixtures/brother-models.json';

const models = modelsJson as unknown as Record<string, { raw: snmp.RawReadings }>;

test('paper type: from the Printer MIB (prtInputMediaName), as the MFC-L2750DW gives it', () => {
  // The user's printer: AUTO (skipped), MANUAL TRAY "THIN", TRAY1 "REGULAR"
  const rows = [
    ['13.1.1', 'AUTO'], ['13.1.2', 'MANUAL TRAY'], ['13.1.3', 'TRAY1'],
    ['10.1.1', -3], ['10.1.2', -3], ['10.1.3', -3], ['9.1.1', 250], ['9.1.2', 1], ['9.1.3', 250],
    ['2.1.1', 1], ['2.1.2', 5], ['2.1.3', 4], ['12.1.1', 'THIN'], ['12.1.2', 'THIN'], ['12.1.3', 'REGULAR'],
  ].map(([c, v]) => ({ oid: `${INPUT_TABLE}.${c}`, value: typeof v === 'string' ? Buffer.from(v) : v }));
  const trays = traysFromTable(rows, INPUT_TABLE);
  assert.deepEqual(trays.map((t) => [t.name, t.media]), [['Manual Tray', 'Thin'], ['Tray 1', 'Regular']]);
});

test('paper type: from IPP medianame; unknown or none says nothing', () => {
  const trays = traysFromIpp(['type=sheetFeedAutoNonRemovableTray;maxcapacity=250;level=-3;status=0;name=TRAY1;medianame=REGULAR;',
    'type=sheetFeedAutoRemovableTray;maxcapacity=500;level=-3;status=0;name=Tray 2;medianame=Unknown;']);
  assert.equal(trays[0].media, 'Regular');
  assert.equal(trays[1].media, undefined);
  assert.equal(mediaName('stationery-heavyweight'), 'Stationery heavyweight');
  assert.equal(mediaName('Plain Paper'), 'Plain Paper', 'mixed case kept');
  assert.equal(mediaName(''), undefined);
});

test('paper type: in Test connection\'s paper line', () => {
  const d = { ...parse(models['hl-l2340dw'].raw), snmpVersion: '2c' as const,
    trays: traysFromIpp(['type=sheetFeedAutoNonRemovableTray;maxcapacity=250;level=-3;status=0;name=TRAY1;medianame=REGULAR;']) };
  assert.equal(testSummary(d).paper, 'Tray 1 has paper (Regular)');
});

test('uptime: from sysUpTime (hundredths of a second) and IPP printer-up-time (seconds)', () => {
  const raw = { ...models['hl-l2340dw'].raw, uptime: 49260865 };
  const d = { ...parse(raw), snmpVersion: '2c' as const };
  assert.equal(d.uptime, 492609);
  assert.equal(testSummary(d).uptime, '6 days');
  assert.ok(REQUESTED.includes('printer-up-time'));
  assert.equal(toPrinterData({ 'printer-up-time': [5400] }).uptime, 5400);
  assert.equal(toPrinterData({}).uptime, undefined);
});

test('uptime: in words', () => {
  assert.equal(describeUptime(30), '1 minute');
  assert.equal(describeUptime(40 * 60), '40 minutes');
  assert.equal(describeUptime(18 * 3600), '18 hours');
  assert.equal(describeUptime(47 * 3600), '47 hours');
  assert.equal(describeUptime(5 * 86400 + 3600), '5 days');
  assert.equal(describeUptime(null), null);
});

test('black-and-white printers: no "0 color" or black-and-white count over SNMP or IPP; two-sided stays', () => {
  const mono = parse(models['hl-l2340dw'].raw);
  assert.equal(pageDetail({ ...mono, colorPages: 0, monoPages: 986, duplexPages: 12 }), '12 two-sided');
  // IPP listing only "monochrome"
  const ipp = toPrinterData({ 'printer-impressions-completed': [100], 'printer-impressions-completed-col.monochrome': [100],
    'marker-names': ['Black'], 'marker-types': ['toner'], 'marker-colors': ['#000000'], 'marker-levels': [60], 'marker-high-levels': [100] });
  assert.equal(pageDetail(ipp), null);
  assert.deepEqual(shownCounts(ipp), { color: null, mono: null, duplex: null });
  // A color printer keeps them
  const color = parse(models['dcp-l3550cdw'].raw);
  assert.deepEqual(shownCounts(color), { color: 902, mono: 709, duplex: 538 });
});

test('uptime: a clock time sent as uptime is left out', () => {
  assert.equal(describeUptime(1.7e9), null);
  assert.equal(describeUptime(9 * 365 * 86400), '3285 days');
});
