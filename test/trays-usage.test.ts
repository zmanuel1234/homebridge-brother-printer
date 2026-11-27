// Paper trays (SNMP input table, IPP printer-input-tray) and usage over time
// (pages printed, how long the toner or ink should last). Tray rows follow the
// shapes real printers report (Brother, HP, Sharp, Ricoh, Fujifilm, Konica Minolta
// recordings from LibreNMS's test data; HP, Canon, Epson IPP recordings).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trayName, traysFromIpp, traysFromTable } from '../src/trays';
import { INPUT_TABLE, query, readTrays } from '../src/snmp';
import type * as snmpLib from 'net-snmp';
import { parseResponse, toPrinterData } from '../src/ipp';
import { readFileSync } from 'node:fs';
import { addSample, daysLeft, describeDays, describeLeft, pagesInLast } from '../src/usage';
import type { UsageSample } from '../src/usage';
import { cachedUsage, testPrinter } from '../src/homebridge-ui/server';
import { startFakePrinter } from './fake-agent';
import { parse } from '../src/snmp';
import type { RawReadings } from '../src/snmp';
import modelsJson from './fixtures/brother-models.json';

const models = modelsJson as unknown as Record<string, { raw: RawReadings }>;
const fromModel = (name: string) => parse(models[name].raw);

const rows = (trays: [string, number, number][]): { oid: string; value: unknown }[] => trays.flatMap(([name, max, level], i) => [
  { oid: `${INPUT_TABLE}.9.1.${i + 1}`, value: max },
  { oid: `${INPUT_TABLE}.10.1.${i + 1}`, value: level },
  { oid: `${INPUT_TABLE}.13.1.${i + 1}`, value: Buffer.from(name) },
]);
const show = (trays: ReturnType<typeof traysFromIpp>): string =>
  trays.map((t) => `${t.name}${t.secondary ? '*' : ''} ${t.state}${t.percent !== null ? ` ${t.percent}` : ''}`).join(', ');

test('trays: names tidied', () => {
  assert.equal(trayName('TRAY1', 1), 'Tray 1');
  assert.equal(trayName('MPTRAY', 1), 'MP Tray');
  assert.equal(trayName('MANUAL TRAY', 1), 'Manual Tray');
  assert.equal(trayName('tray-1', 1), 'Tray 1');
  assert.equal(trayName('InputTray 2', 1), 'Input Tray 2');
  assert.equal(trayName('Paper Tray 1', 1), 'Paper Tray 1');
  assert.equal(trayName('', 3), 'Tray 3');
});

test('trays: from the Printer MIB input table', () => {
  // Brother: "some paper" in the main tray, the MP tray empty; "AUTO" isn't a tray
  assert.equal(show(traysFromTable(rows([['AUTO', 250, -3], ['MP TRAY', 50, 0], ['TRAY1', 250, -3]]), INPUT_TABLE)),
    'MP Tray* empty 0, Tray 1 ok');
  // Sharp: sheet counts; the bypass tray empty
  assert.equal(show(traysFromTable(rows([['Bypass Tray', 100, 0], ['Tray 1', 550, 181], ['Tray 2', 550, 40]]), INPUT_TABLE)),
    'Bypass Tray* empty 0, Tray 1 ok 33, Tray 2 low 7');
  // HP: "Tray 1" is the multipurpose tray (small next to the cassettes)
  assert.equal(show(traysFromTable(rows([['Tray 1', 100, 0], ['Tray 2', 500, 200], ['Tray 3', 1500, 0]]), INPUT_TABLE)),
    'Tray 1* empty 0, Tray 2 ok 40, Tray 3 empty 0');
  // One tray only: never secondary, however small
  assert.equal(show(traysFromTable(rows([['Tray 1', 150, -3]]), INPUT_TABLE)), 'Tray 1 ok');
  // Unknown levels
  assert.equal(show(traysFromTable(rows([['Rear Auto Sheet Feeder', 80, -2], ['Sheet feeder bin 1', 250, -2]]), INPUT_TABLE)),
    'Rear Auto Sheet Feeder* unknown, Sheet Feeder Bin 1 unknown'.replace('Sheet Feeder Bin 1', 'Sheet feeder bin 1'));
});

test('trays: type and status (HP marks its bypass tray "on request"; unknown status makes 0 unknown)', () => {
  const withCols = (list: [string, number, number, number, number][]) => list.flatMap(([name, max, level, type, status], i) => [
    ...rows([[name, max, level]]).map((r) => ({ ...r, oid: r.oid.replace(/\.1\.1$/, `.1.${i + 1}`) })),
    { oid: `${INPUT_TABLE}.2.1.${i + 1}`, value: type },
    { oid: `${INPUT_TABLE}.11.1.${i + 1}`, value: status },
  ]);
  // HP LaserJet M880: Tray 1 is the bypass by its size; "on request" (9) isn't taken as a sign of
  // one, since an empty cassette may be marked the same way: Tray 2 (made up here) stays a main tray
  assert.equal(show(traysFromTable(withCols([['Tray 1', 100, 0, 4, 9], ['Tray 2', 500, 0, 4, 9], ['Tray 3', 1500, 300, 3, 0]]), INPUT_TABLE)),
    'Tray 1* empty 0, Tray 2 empty 0, Tray 3 ok 20');
  // A manual feed by type, however big; a tray at 0 whose status is unknown (5)
  assert.equal(show(traysFromTable(withCols([['Feeder', 250, 0, 5, 0], ['Tray 2', 500, 0, 3, 5]]), INPUT_TABLE)),
    'Feeder* empty 0, Tray 2 unknown');
  // A rear feeder isn't taken for a bypass tray (the main tray on many inkjets)
  assert.equal(traysFromIpp(['type=sheetFeedAutoNonRemovableTray;maxcapacity=100;level=0;status=0;name=Rear;'])[0].secondary, false);
  assert.equal(traysFromIpp(['type=sheetFeedManual;maxcapacity=250;level=0;status=0;name=Slot;'])[0].secondary, true);
  // A cassette marked "on request" while empty stays a main tray, removable or not
  assert.equal(traysFromIpp(['type=sheetFeedAutoRemovableTray;maxcapacity=500;level=0;status=9;name=Tray 2;'])[0].secondary, false);
  assert.equal(traysFromIpp(['type=sheetFeedAutoNonRemovableTray;maxcapacity=500;level=0;status=9;name=Tray 2;'])[0].secondary, false);
});

test('trays: from real IPP answers (HP LaserJet M605, Epson XP-6000)', () => {
  const read = (f: string) => toPrinterData(parseResponse(readFileSync(join(__dirname, 'fixtures', 'ipp', f))).printer).trays!;
  assert.equal(show(read('hp-laserjet-m605.bin')), 'Tray 3 ok, Tray 2 ok, Tray 1* empty 0');
  assert.ok(read('epson-xp-6000.bin').every((t) => t.state === 'unknown'));
});

test('firmware: from IPP printer-firmware-string-version, as the printer gives it', () => {
  const firmware = (f: string) => toPrinterData(parseResponse(readFileSync(join(__dirname, 'fixtures', 'ipp', f))).printer).firmware;
  assert.equal(firmware('canon-ts6000.bin'), '2.0');
  assert.equal(firmware('hp-laserjet-m605.bin'), '2307781_551188');
});

test('trays: from IPP printer-input-tray', () => {
  const trays = traysFromIpp([
    'type=other;mediafeed=0;mediaxfeed=0;maxcapacity=-2;level=-2;status=0;name=auto;',
    'type=sheetFeedManual;mediafeed=0;mediaxfeed=0;maxcapacity=1;level=-2;status=0;name=manual;',
    'type=sheetFeedAutoRemovableTray;mediafeed=0;mediaxfeed=0;maxcapacity=250;level=0;status=0;name=tray-1;',
    null,
  ]);
  assert.equal(show(trays), 'Manual* unknown, Tray 1 empty 0');
  assert.deepEqual(trays.map((t) => t.key), ['manual', 'tray-1']);
});

test('a printer that never answers bulk requests (MFC-L2750DW) is read row by row, and remembered', async () => {
  // The MFC-L2750DW's input table, as snmpwalk shows it; it answers GETNEXT but never GETBULK
  const table: [string, unknown][] = [
    ...[['1.1', 'AUTO'], ['1.2', 'MANUAL TRAY'], ['1.3', 'TRAY1']].map(([i, v]) => [`${INPUT_TABLE}.13.${i}`, Buffer.from(v)] as [string, unknown]),
    ...[['1.1', -3], ['1.2', -3], ['1.3', 0]].map(([i, v]) => [`${INPUT_TABLE}.10.${i}`, v] as [string, unknown]),
    ...[['1.1', 250], ['1.2', 1], ['1.3', 250]].map(([i, v]) => [`${INPUT_TABLE}.9.${i}`, v] as [string, unknown]),
    ...[['1.1', 1], ['1.2', 5], ['1.3', 4]].map(([i, v]) => [`${INPUT_TABLE}.2.${i}`, v] as [string, unknown]),
    ...[['1.1', 0], ['1.2', 0], ['1.3', 19]].map(([i, v]) => [`${INPUT_TABLE}.11.${i}`, v] as [string, unknown]),
  ];
  const cmp = (a: string, b: string) => { const x = a.split('.').map(Number); const y = b.split('.').map(Number);
    for (let i = 0; i < Math.max(x.length, y.length); i++) { if ((x[i] ?? -1) !== (y[i] ?? -1)) { return (x[i] ?? -1) - (y[i] ?? -1); } } return 0; };
  table.sort(([a], [b]) => cmp(a, b));
  let bulk = 0;
  let next = 0;
  const session = {
    subtree(_o: string, _m: number, _f: unknown, done: (err?: Error) => void) { bulk++; done(new Error('Request timed out')); },
    getNext(oids: string[], cb: (err: Error | null, vbs?: snmpLib.Varbind[]) => void) {
      next++;
      const hit = table.find(([oid]) => cmp(oid, oids[0]) > 0);
      cb(null, [hit ? { oid: hit[0], type: 2, value: hit[1] } as snmpLib.Varbind : { oid: '1.3.6.1.2.1.43.9', type: 130, value: null } as unknown as snmpLib.Varbind]);
    },
  } as unknown as snmpLib.Session;
  const state: { noBulk?: boolean } = {};
  const trays = traysFromTable((await readTrays(session, state))!, INPUT_TABLE);
  assert.equal(show(trays), 'Manual Tray* ok, Tray 1 empty 0');
  assert.equal(state.noBulk, true);
  assert.equal(bulk, 1, 'one bulk try, then row by row');
  // The next poll goes row by row at once
  await readTrays(session, state);
  assert.equal(bulk, 1);
  assert.ok(next > 0);
});

test('trays: a column the printer doesn\'t answer (type, status) loses only itself', async () => {
  // A session whose walks of the type (2) and status (11) columns fail, as on a printer without them
  const session = {
    subtree(oid: string, _max: number, feed: (vbs: snmpLib.Varbind[]) => boolean, done: (err?: Error) => void) {
      const col = Number(oid.split('.').pop());
      if (col === 2 || col === 11) { done(new Error('Request failed: GenErr')); return; }
      const value = col === 9 ? 250 : col === 10 ? -3 : Buffer.from('TRAY1');
      feed([{ oid: `${oid}.1.1`, type: 2, value } as snmpLib.Varbind]);
      done();
    },
  } as unknown as snmpLib.Session;
  const trays = traysFromTable((await readTrays(session))!, INPUT_TABLE);
  assert.equal(show(trays), 'Tray 1 ok');
  // Without names or levels there's nothing reliable: not read
  const failing = (cols: number[], message = 'GenErr') => ({
    subtree(oid: string, _max: number, feed: (vbs: snmpLib.Varbind[]) => boolean, done: (err?: Error) => void) {
      const col = Number(oid.split('.').pop());
      if (cols.includes(col)) { done(new Error(message)); return; }
      feed([{ oid: `${oid}.1.1`, type: 2, value: col === 13 ? Buffer.from('TRAY1') : 0 } as snmpLib.Varbind]);
      done();
    },
  } as unknown as snmpLib.Session);
  assert.equal(await readTrays(failing([13])), undefined);
  assert.equal(await readTrays(failing([10])), undefined);
  // A timeout stops the read at once rather than waiting on every column
  // (a bulk walk that times out is tried once row by row; when that times out too, the read stops)
  let walks = 0;
  const slow = {
    subtree: (_o: string, _m: number, _f: unknown, done: (err?: Error) => void) => { walks++; done(new Error('Request timed out')); },
    getNext: (_o: string[], cb: (err: Error) => void) => { walks++; cb(new Error('Request timed out')); },
  } as unknown as snmpLib.Session;
  assert.equal(await readTrays(slow), undefined);
  assert.equal(walks, 2);
  // Nothing answers: undefined, never an error
  const none = { subtree: (_o: string, _m: number, _f: unknown, done: (err?: Error) => void) => done(new Error('timeout')) } as unknown as snmpLib.Session;
  assert.equal(await readTrays(none), undefined);
});

test('trays: read over SNMP on request, or when the printer reports paper low or out', async (t) => {
  const printer = await startFakePrinter(16220, {}, [], [], [], [{ name: 'MP TRAY', max: 50, level: 0 }, { name: 'TRAY1', max: 250, level: 0 }]);
  t.after(() => printer.close());
  const plain = await query({ host: '127.0.0.1', port: 16220, timeout: 1000, retries: 0 });
  assert.equal(plain.trays, undefined, 'not read without a reason');
  const asked = await query({ host: '127.0.0.1', port: 16220, timeout: 1000, retries: 0, trays: true });
  assert.equal(show(asked.trays!), 'MP Tray* empty 0, Tray 1 empty 0');
  // hrPrinterDetectedErrorState: noPaper is bit 1 of the first byte (0x40)
  printer.set('errorState', Buffer.from([0x40]));
  const out = await query({ host: '127.0.0.1', port: 16220, timeout: 1000, retries: 0 });
  assert.equal(out.trays?.length, 2);
});

/* ------------------------------------------------------------------ usage */

const DAY = 86400;
const T0 = 1_700_000_000;
/** One sample a day: pages and black level as given */
const days = (list: [number, number][], from = T0): UsageSample[] =>
  list.map(([p, black], i) => ({ t: from + i * DAY, p, l: { black } }));

test('usage: a sample from a wrong clock (in the future) doesn\'t block new ones', () => {
  const future = [{ t: T0 + 3650 * DAY, p: 1, l: {} }, { t: T0 - DAY, p: 1, l: {} }];
  const next = addSample(future, T0, 2, { black: 50 })!;
  assert.deepEqual(next.map((s) => s.t), [T0 - DAY, T0]);
});

test('usage: one sample a day, about 120 days kept', () => {
  const first = addSample(undefined, T0, 100, { black: 80 })!;
  assert.equal(first.length, 1);
  assert.equal(addSample(first, T0 + 3600, 101, { black: 80 }), null, 'not due yet');
  const second = addSample(first, T0 + DAY, 120, { black: 79 })!;
  assert.deepEqual(second[1], { t: T0 + DAY, p: 120, l: { black: 79 } });
  assert.equal(first.length, 1, 'the list given is left as it was');
  const old = addSample(second, T0 + 130 * DAY, 500, { black: 50 })!;
  assert.equal(old.length, 1, 'samples over 120 days old are dropped');
  // No pages: no p
  assert.equal(addSample([], T0, null, { black: 1 })![0].p, undefined);
  // Junk in the cache doesn't break it
  assert.equal(addSample([null, { t: 'x' }] as unknown as UsageSample[], T0, 1, {})!.length, 1);
});

test('usage: pages in the last 7 and 30 days, once there\'s history for it', () => {
  const s = days(Array.from({ length: 31 }, (_, i) => [1000 + i * 10, 80] as [number, number]));
  const now = T0 + 30 * DAY;
  assert.equal(pagesInLast(s, now, 1300, 7), 70);
  assert.equal(pagesInLast(s, now, 1300, 30), 300);
  assert.equal(pagesInLast(s.slice(-3), now, 1300, 7), null, 'only 2 days of history');
  assert.equal(pagesInLast(s, now, null, 7), null);
  assert.equal(pagesInLast(s, now, 900, 7), null, 'a counter that went back');
});

test('usage: days left at the rate since the last cartridge change', () => {
  // 1% a day: 50 days from 50%
  const steady = days(Array.from({ length: 20 }, (_, i) => [0, 70 - i] as [number, number]));
  const now = T0 + 20 * DAY;
  assert.equal(Math.round(daysLeft(steady, 'black', now, 50)!), 50);
  // A new cartridge 5 days ago: only the readings since count, and that's under a week
  const refilled = [...steady, ...days([[0, 100], [0, 99], [0, 98], [0, 97], [0, 96]], T0 + 20 * DAY)];
  assert.equal(daysLeft(refilled, 'black', T0 + 25 * DAY, 95), null);
  // Flat or rising: no estimate
  assert.equal(daysLeft(days(Array.from({ length: 10 }, () => [0, 60] as [number, number])), 'black', T0 + 10 * DAY, 60), null);
  // A color without readings
  assert.equal(daysLeft(steady, 'cyan', now, 50), null);
  assert.equal(describeDays(0.5), 'less than a day');
  assert.equal(describeDays(5), 'about 5 days');
  assert.equal(describeDays(42), 'about 6 weeks');
  assert.equal(describeDays(120), 'about 4 months');
  assert.equal(describeDays(500), 'over a year');
  assert.equal(describeLeft(steady, now, { black: 50 }, 'Toner'), 'Toner: about 7 weeks left');
  const color = steady.map((s, i) => ({ ...s, l: { black: s.l.black!, cyan: 60 - 2 * i } }));
  assert.equal(describeLeft(color, now, { black: 50, cyan: 20 }, 'Ink'), 'Cyan: about 10 days, Black: about 7 weeks left');
  assert.equal(describeLeft(undefined, now, { black: 50 }, 'Toner'), null);
});

test('settings test: paper trays and the plugin\'s usage history from the accessory cache', async () => {
  const storage = mkdtempSync(join(tmpdir(), 'bp-'));
  mkdirSync(join(storage, 'accessories'));
  const now = Math.round(Date.now() / 1000);
  const usage = Array.from({ length: 31 }, (_, i) => ({ t: now - (30 - i) * DAY, p: 1000 + i * 10, l: { black: 80 - i } }));
  // A child bridge's cache, next to an unreadable main one
  writeFileSync(join(storage, 'accessories', 'cachedAccessories'), '{not json');
  writeFileSync(join(storage, 'accessories', 'cachedAccessories.0E1234567890'), JSON.stringify([
    { platform: 'Other', context: { host: '10.0.0.5', usage: [] } },
    { platform: 'BrotherPrinter', context: { name: 'Office', host: '10.0.0.5', usage } },
  ]));
  assert.equal(cachedUsage(storage, 'Office', '10.0.0.5')?.samples.length, 31);
  assert.equal(cachedUsage(storage, 'Office', '10.0.0.6'), undefined);
  assert.equal(cachedUsage(join(storage, 'none'), 'Office', '10.0.0.5'), undefined);

  const d = { ...fromModel('hl-l2340dw'), snmpVersion: '2c' as const, totalPages: 1300,
    supplies: [{ color: 'black' as const, level: 50, fine: null }],
    trays: traysFromTable(rows([['MP TRAY', 50, 0], ['TRAY1', 250, -3]]), INPUT_TABLE) };
  let asked = false;
  const r = await testPrinter({ name: 'Office', host: '10.0.0.5' }, (o) => { asked = o.trays === true; return Promise.resolve(d); }, storage);
  assert.ok(asked, 'the test reads the trays');
  assert.equal(r.paper, 'MP Tray (bypass) empty, Tray 1 has paper');
  assert.equal(r.usage, '70 pages in the last 7 days, 300 in the last 30 days');
  // Read over IPP while the plugin counts SNMP's pages: no page figures from a mix of the two
  writeFileSync(join(storage, 'accessories', 'cachedAccessories.0E1234567890'), JSON.stringify([
    { platform: 'BrotherPrinter', context: { name: 'Office', host: '10.0.0.5', usage, snmpAnswered: true } },
  ]));
  const ipp = await testPrinter({ name: ' Office ', host: '10.0.0.5', protocol: 'auto' }, () => Promise.resolve({ ...d, via: 'ipp' as const }), storage);
  assert.deepEqual([ipp.usage, ipp.left], [null, null]);
  // Switched to IPP only: the history is IPP's own from then on (the name matched trimmed)
  const ippOnly = await testPrinter({ name: ' Office ', host: '10.0.0.5', protocol: 'ipp' }, () => Promise.resolve({ ...d, via: 'ipp' as const }), storage);
  assert.equal(ippOnly.left, 'Toner: about 7 weeks left');
  assert.equal(r.left, 'Toner: about 7 weeks left');
  // Not running in Homebridge yet: no history
  const fresh = await testPrinter({ name: 'New', host: '10.0.0.9' }, () => Promise.resolve(d), storage);
  assert.deepEqual([fresh.usage, fresh.left], [null, null]);
});
