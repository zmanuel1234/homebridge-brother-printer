// Printers of any make over SNMP: the standard Printer MIB supplies table
// (RFC 3805), read when there are no Brother records. Checked by hand against
// SNMP recordings of real printers (HP, Canon, Dell, Epson, Fujifilm, Konica
// Minolta, OKI, Ricoh, Samsung, Sharp, Utax, Xerox) from LibreNMS's test data;
// the rows below are short examples in the same shapes, some with the supply
// names and numbers those printers report.
import test from 'node:test';
import assert from 'node:assert/strict';
import { COLORANT_VALUES, SUPPLIES_TABLE, modelOf, parse, query, readSupplies, suppliesFromVarbinds } from '../src/snmp';
import type * as snmpLib from 'net-snmp';
import type { RawReadings } from '../src/snmp';
import { startFakePrinter } from './fake-agent';
import type { FakeSupply } from './fake-agent';

const levels = (r: { supplies: { color: string; level: number }[] }): string => r.supplies.map((s) => `${s.color} ${s.level}`).join(', ');

test('Printer MIB: walked rows become markers, with colorant names', () => {
  const T = SUPPLIES_TABLE;
  const rows = [
    { oid: `${T}.3.1.1`, value: 1 }, { oid: `${T}.5.1.1`, value: 3 }, { oid: `${T}.6.1.1`, value: Buffer.from('Toner\u0000\u0000') },
    { oid: `${T}.8.1.1`, value: 20000 }, { oid: `${T}.9.1.1`, value: 5000 },
    { oid: `${T}.5.1.2`, value: 9 }, { oid: `${T}.6.1.2`, value: Buffer.from('Drum Unit') },
    { oid: `${T}.8.1.2`, value: 100 }, { oid: `${T}.9.1.2`, value: -3 },
    { oid: `${T}.2.1.1`, value: 1 }, // a column the plugin doesn't use
  ];
  const markers = suppliesFromVarbinds(rows, [{ oid: `${COLORANT_VALUES}.1.1`, value: Buffer.from('black') }]);
  assert.deepEqual(markers, [
    { name: 'Toner', type: 'toner', colors: 'black', level: 5000, high: 20000 },
    { name: 'Drum Unit', type: 'opc', colors: '', level: -3, high: 100 },
  ]);
});

/** A reading with no Brother records, only supplies */
const reading = (markers: RawReadings['markers'], extra: RawReadings = {}) =>
  parse({ model: Buffer.from('ACME Laser 9000'), printerStatus: 3, ...extra, markers });

test('Printer MIB: a color laser with page-counted supplies, drums and parts', () => {
  const d = reading([
    { name: 'Black Toner, PN 006R01509', type: '', colors: '', level: 1060, high: 5300 },
    { name: 'Cyan Toner', type: 'toner', colors: '', level: 1980, high: 3000 },
    { name: 'Toner (Magenta)', type: '', colors: '', level: 72, high: 100 },
    { name: 'Patrone Gelb HP 415A', type: 'toner-cartridge', colors: '', level: 60, high: 100 },
    { name: 'Black Image Drum Unit', type: 'opc', colors: '', level: 28407, high: 30000 },
    { name: 'Developer Cartridge (Black)', type: '', colors: '', level: 71, high: 100 },
    { name: 'Waste Toner Container', type: 'waste-toner', colors: '', level: 5, high: 100 },
    { name: 'Fusing Unit', type: 'fuser', colors: '', level: -2, high: -2 },
    { name: 'Transfer Roller', type: 'other', colors: '', level: 127066, high: 150000 },
    { name: 'Stapler 1', type: 'staples', colors: '', level: -3, high: -2 },
  ]);
  assert.equal(levels(d), 'black 20, cyan 66, magenta 72, yellow 60');
  assert.equal(d.type, 'laser');
  assert.deepEqual(d.drums, { black: { percent: 95 } });
  assert.deepEqual(d.parts, { developer: { percent: 71 }, wasteToner: { percent: 5 }, belt: { percent: 85 } });
  assert.equal(d.manufacturer, 'ACME', 'a maker the plugin doesn\'t know: the first word of the model');
});

test('Printer MIB: inkjets, names in other languages, part numbers, two black toners', () => {
  const ink = reading([
    { name: 'CANON Matte Black Ink Tank', type: 'ink-cartridge', colors: '', level: 2400, high: 3000 },
    { name: 'CANON Black Ink Tank', type: 'ink-cartridge', colors: '', level: 3000, high: 3000 },
    { name: 'CANON Cyan Ink Tank', type: 'ink-cartridge', colors: '', level: 2100, high: 3000 },
    { name: 'CANON Waste Ink Tank', type: 'waste-ink', colors: '', level: 6030, high: 6700 },
  ], { model: Buffer.from('Canon TM-5300') });
  assert.equal(levels(ink), 'black 80, cyan 70, photoBlack 100');
  assert.equal(ink.type, 'ink');
  assert.deepEqual(ink.parts, { inkWasteBox: { percent: 90 } });
  assert.equal(ink.manufacturer, 'Canon');

  const ricoh = reading([
    { name: '黑色碳粉', type: 'toner', colors: '', level: 80, high: 100 },
    { name: '青色碳粉', type: 'toner', colors: '', level: 30, high: 100 },
    { name: '洋紅色碳粉', type: 'toner', colors: '', level: 30, high: 100 },
    { name: '黃色碳粉', type: 'toner', colors: '', level: 20, high: 100 },
    { name: '廢棄碳粉', type: 'waste-toner', colors: '', level: 100, high: 100 },
  ]);
  assert.equal(levels(ricoh), 'black 80, cyan 30, magenta 30, yellow 20');

  const utax = reading([{ name: 'PK-3010S', type: 'toner', colors: '', level: 5340, high: 6000 }]);
  assert.equal(levels(utax), 'black 89', 'a part number, not photo black');

  const fuji = reading([
    { name: 'Black Toner 1', type: 'toner', colors: '', level: 23000, high: 23000 },
    { name: 'Black Toner 2', type: 'toner', colors: '', level: 20700, high: 23000 },
  ]);
  assert.equal(levels(fuji), 'black 90', 'the lower of two black toners');
});

test('Printer MIB: "some remaining" and unknown levels give no %', () => {
  const d = reading([
    { name: 'Black Toner Cartridge', type: 'toner', colors: '', level: -3, high: -2 },
    { name: 'Drum Unit', type: 'opc', colors: '', level: 11501, high: 12000 },
  ], { model: Buffer.from('Brother MFC-L2710DW series') });
  assert.equal(levels(d), '');
  assert.deepEqual(d.drums, { black: { percent: 96 } });
  assert.equal(d.manufacturer, 'Brother');
});

test('model: generic driver names and print servers give way to the device\'s description', () => {
  assert.equal(modelOf('Generic 28C-1', 'KONICA MINOLTA bizhub C3110'), 'KONICA MINOLTA bizhub C3110');
  assert.equal(modelOf('', 'RICOH MP C2503 1.35 / RICOH Network Printer C model'), 'RICOH MP C2503');
  assert.equal(modelOf('', 'OKI OkiLAN 9450g Rev.00.69 Ethernet PrintServer: Attached to MC873 Rev.07.87'), 'MC873');
  assert.equal(modelOf('', 'HP ETHERNET MULTI-ENVIRONMENT,ROM none,JETDIRECT,JD153'), '');
  assert.equal(modelOf('HP Color LaserJet M452nw', 'HP ETHERNET MULTI-ENVIRONMENT'), 'HP Color LaserJet M452nw');
  const d = parse({ sysDescr: Buffer.from('KONICA MINOLTA bizhub C3110'), model: Buffer.from('Generic 28C-1') });
  assert.equal(d.manufacturer, 'Konica Minolta');
});

const HP_COLOR: FakeSupply[] = [
  { colorant: 1, type: 21, name: 'Black Cartridge HP CF410A', max: 100, level: 54 },
  { colorant: 2, type: 21, name: 'Cyan Cartridge HP CF411A', max: 100, level: 44 },
  { colorant: 3, type: 21, name: 'Magenta Cartridge HP CF413A', max: 100, level: 76 },
  { colorant: 4, type: 21, name: 'Yellow Cartridge HP CF412A', max: 100, level: 71 },
  { colorant: 0, type: 9, name: 'Imaging Drum', max: 100, level: 80 },
];

test('over SNMP: a non-Brother printer is read through its supplies table (v2c and v1)', async (t) => {
  const printer = await startFakePrinter(16210, {
    maintenance: undefined, counters: undefined, nextCare: undefined, statusText: undefined,
    model: Buffer.from('HP Color LaserJet M452nw'), serial: Buffer.from('VNB3K12345'),
  }, [], HP_COLOR, ['black', 'cyan', 'magenta', 'yellow']);
  t.after(() => printer.close());
  for (const version of ['2c', '1'] as const) {
    const d = await query({ host: '127.0.0.1', port: 16210, version, timeout: 1000, retries: 0 });
    assert.equal(levels(d), 'black 54, cyan 44, magenta 76, yellow 71', `SNMP v${version}`);
    assert.deepEqual(d.drums, { black: { percent: 80 } });
    assert.equal(d.manufacturer, 'HP');
    assert.equal(d.serial, 'VNB3K12345');
  }
});

test('over SNMP: a Brother printer with its own records doesn\'t read the supplies table', async (t) => {
  // Its Brother records say toner 70%; the table would say 1%
  const printer = await startFakePrinter(16211, {}, [], [{ colorant: 1, type: 3, name: 'Black Toner', max: 100, level: 1 }], ['black']);
  t.after(() => printer.close());
  const d = await query({ host: '127.0.0.1', port: 16211, timeout: 1000, retries: 0 });
  assert.equal(levels(d), 'black 70');
  assert.equal(d.manufacturer, 'Brother');
});

/** A session whose walks answer from a list, or fail */
function fakeSession(answer: (oid: string) => snmpLib.Varbind[] | Error): snmpLib.Session {
  return {
    subtree(oid: string, _max: number, feed: (vbs: snmpLib.Varbind[]) => boolean, done: (err?: Error) => void) {
      const a = answer(oid);
      if (a instanceof Error) { done(a); } else { feed(a); done(); }
    },
  } as unknown as snmpLib.Session;
}

test('Printer MIB: a walk that fails partway is a failed poll once the table has been read before', async () => {
  const ok = (oid: string): snmpLib.Varbind[] => (oid.endsWith('.6') ? [{ oid: `${oid}.1.1`, type: 4, value: Buffer.from('Black Toner') }]
    : oid.endsWith('.9') ? [{ oid: `${oid}.1.1`, type: 2, value: 50 }] : oid.endsWith('.8') ? [{ oid: `${oid}.1.1`, type: 2, value: 100 }] : []);
  const state: { suppliesRead?: boolean } = {};
  // Never read before: a failure means no table
  assert.deepEqual(await readSupplies(fakeSession(() => new Error('Request timed out')), null, state), []);
  assert.equal((await readSupplies(fakeSession(ok), null, state))[0].level, 50);
  assert.equal(state.suppliesRead, true);
  // Read before: a lost packet mid-walk must not look like "no supplies"
  await assert.rejects(readSupplies(fakeSession((oid) => (oid.endsWith('.9') ? new Error('Request timed out') : ok(oid))), null, state),
    /timed out/);
});

test('Printer MIB: names follow the printer\'s character set', () => {
  // "Schwarz Tönerkartusche" in Latin-1 (IANA charset 4)
  const latin1 = Buffer.from('Toner Schwarz \u00e4', 'latin1');
  const markers = suppliesFromVarbinds([{ oid: `${SUPPLIES_TABLE}.6.1.1`, value: latin1 }], [], 4);
  assert.equal(markers[0].name, 'Toner Schwarz \u00e4');
  // No character set given: UTF-8 when valid, so Chinese names come through
  assert.equal(suppliesFromVarbinds([{ oid: `${SUPPLIES_TABLE}.6.1.1`, value: Buffer.from('黑色碳粉') }], [])[0].name, '黑色碳粉');
  assert.equal(suppliesFromVarbinds([{ oid: `${SUPPLIES_TABLE}.6.1.1`, value: latin1 }], [])[0].name, 'Toner Schwarz \u00e4');
});
