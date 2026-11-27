import test from 'node:test';
import assert from 'node:assert/strict';
import type { API, Characteristic, Logging, PlatformAccessory, Service } from 'homebridge';
import { PrinterAccessory } from '../src/accessory';
import type { PrinterConfig, PrinterContext, QueryFn } from '../src/accessory';
import * as snmp from '../src/snmp';
import { startHistory } from '../src/history';
import { parseResponse, toPrinterData } from '../src/ipp';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { HistoryEntry } from '../src/history';
import type { QueryResult } from '../src/snmp';
import type * as HapNodejs from '@homebridge/hap-nodejs';
import modelsJson from './fixtures/brother-models.json';

type Hap = typeof HapNodejs;
const models = modelsJson as unknown as Record<string, { raw: snmp.RawReadings }>;

// These tests use Homebridge's HAP library, an ES module whose current release
// targets newer Node versions. If it can't be loaded, only these tests are
// skipped (with the reason); the decoder, SNMP and package tests still run.
let hap: Hap | null = null;
let loadError = '';
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  hap = require('@homebridge/hap-nodejs') as Hap;
} catch (err) {
  loadError = (err as Error).message.split('\n')[0];
}

if (!hap) {
  test('accessory tests', { skip: `HAP library doesn't load on Node ${process.version}: ${loadError}` }, () => {});
} else {
  defineTests(hap);
}

function defineTests(hap: Hap): void {
  const { Service: S, Characteristic: C } = hap;
  const OPEN = C.ContactSensorState.CONTACT_NOT_DETECTED;
  const CLOSED = C.ContactSensorState.CONTACT_DETECTED;
  type Acc = PlatformAccessory<PrinterContext>;

  // Polls are driven by hand: by default the accessory's own polls never
  // resolve; pollWith answers or fails one poll.
  const never: QueryFn = () => new Promise(() => {});
  let respond: QueryFn = never;

  // Eve history: recorded by default; one test uses the real fakegato-history
  let storageDir = '';
  let entries: HistoryEntry[] = [];
  let started = 0;
  const recordHistory: typeof startHistory = () => {
    started++;
    return { addEntry: (e) => { entries.push(e); } };
  };
  let historyStarter: typeof startHistory = recordHistory;

  // Looking for a printer that moved: nothing found unless a test says otherwise
  type Find = NonNullable<ConstructorParameters<typeof PrinterAccessory>[3]>['find'] & {};
  const findNothing: Find = () => Promise.resolve(null);
  let finder: Find = findNothing;

  function setup(config: Partial<PrinterConfig> & Record<string, unknown>, accessory?: Acc | null, lines: string[] = []) {
    respond = never;
    const acc = accessory || Object.assign(
      new hap.Accessory('Printer', hap.uuid.generate(String(Math.random()))), { context: {} },
    ) as unknown as Acc;
    const log = Object.fromEntries(['info', 'warn', 'error', 'debug']
      .map((l) => [l, (m: string) => lines.push(`${l}: ${m}`)])) as unknown as Logging;
    const api = { hap, updatePlatformAccessories: () => {}, user: { storagePath: () => storageDir } } as unknown as API;
    const printer = new PrinterAccessory({ log, api }, acc, { name: 'Printer', host: '10.0.0.1', ...config },
      { query: (options) => respond(options), startHistory: (...args) => historyStarter(...args), find: (...args) => finder(...args) });
    printer.stop();
    return { acc, printer, lines };
  }

  /** Run one poll by hand with the given answer (data) or failure (Error) */
  async function pollWith(printer: PrinterAccessory, answer: QueryResult | Error): Promise<void> {
    respond = () => (answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer));
    printer.stopped = false;
    await printer.poll();
    printer.stop();
    respond = never;
  }

  /** What Home gets when it reads a characteristic: its value, or the HAP error status */
  async function read(ch: Characteristic): Promise<unknown> {
    try {
      return await ch.handleGetRequest();
    } catch (status) {
      return { error: status };
    }
  }

  const fromModel = (name: string): QueryResult => ({ ...snmp.parse(models[name].raw), snmpVersion: '2c' });
  const reading = (level: number, fine: number = level, extra: Partial<QueryResult> = {}): QueryResult => {
    const s = { color: 'black' as const, level, fine };
    return { ...fromModel('hl-l2340dw'), supplies: [s], lowestSupply: s, ...extra };
  };
  const service = (acc: Acc, type: typeof S.Battery | typeof S.ContactSensor, subtype: string): Service | undefined =>
    acc.getServiceById(type, subtype);
  const lowSensor = (acc: Acc) => service(acc, S.ContactSensor, 'lowToner');
  const low = (acc: Acc) => lowSensor(acc)!;
  const state = (acc: Acc) => lowSensor(acc)?.getCharacteristic(C.ContactSensorState).value;

  /* ------------------------------------------------------- low toner sensor */

  test('low toner sensor: off by default', () => {
    const { acc, printer } = setup({});
    printer.apply(reading(5));
    assert.equal(lowSensor(acc), undefined);
  });

  test('low toner sensor: closed while toner is fine, opens at the threshold', () => {
    const { acc, printer } = setup({ lowTonerSensor: true, lowTonerThreshold: 10 });
    printer.apply(reading(80));
    assert.equal(lowSensor(acc)?.getCharacteristic(C.ConfiguredName).value, 'Toner Low');
    assert.equal(state(acc), CLOSED);
    printer.apply(reading(10));
    assert.equal(state(acc), OPEN);
    printer.apply(reading(100)); // new cartridge
    assert.equal(state(acc), CLOSED);
  });

  test('low toner sensor: opens on the finer reading or when the printer flags it', () => {
    const { acc, printer } = setup({ lowTonerSensor: true, lowTonerThreshold: 10 });
    printer.apply(reading(20, 8));
    assert.equal(state(acc), OPEN);
    printer.apply(reading(40, 40, { errors: ['lowToner'] }));
    assert.equal(state(acc), OPEN);
  });

  test('low toner sensor: says Ink on inkjets', () => {
    const { acc, printer } = setup({ lowTonerSensor: true });
    printer.apply(reading(50, 50, { type: 'ink' }));
    assert.equal(lowSensor(acc)?.getCharacteristic(C.ConfiguredName).value, 'Ink Low');
  });

  test('low toner sensor: without levels it follows the printer\'s own low flag', () => {
    const { acc, printer } = setup({ lowTonerSensor: true });
    printer.apply({ ...reading(50), supplies: [], lowestSupply: null });
    assert.equal(state(acc), CLOSED);
    printer.apply({ ...reading(50), supplies: [], lowestSupply: null, errors: ['lowToner'] });
    assert.equal(state(acc), OPEN);
  });

  /* ------------------------------------------------------------------- IPP */

  const viaIpp = (d: QueryResult): QueryResult => ({ ...d, via: 'ipp', snmpVersion: null });
  const noLevels = (extra: Partial<QueryResult> = {}): QueryResult =>
    viaIpp({ ...reading(50), supplies: [], lowestSupply: null, drums: {}, parts: {}, serial: 'IPP-FORMAT', ...extra });

  test('IPP in auto: standing in for SNMP keeps its battery, drum, maintenance and serial', () => {
    const { acc, printer } = setup({ protocol: 'auto', lowTonerSensor: true, maintenanceSensor: true, showDrum: true });
    printer.apply({ ...reading(40), serial: 'E111', drums: { black: { percent: 5 } } });
    const maintenance = service(acc, S.ContactSensor, 'maintenance');
    assert.equal(maintenance?.getCharacteristic(C.ContactSensorState).value, OPEN);

    printer.apply(noLevels());
    assert.ok(battery(acc), 'the toner battery stays');
    assert.equal(battery(acc)?.getCharacteristic(C.BatteryLevel).value, 40, 'with SNMP\'s level');
    assert.equal(acc.context.noLevels, false);
    assert.equal(maintenance?.getCharacteristic(C.ContactSensorState).value, OPEN, 'not reset');
    assert.equal(acc.context.serial, 'E111', 'SNMP\'s serial number stays');
    assert.equal(state(acc), CLOSED);

    printer.apply(noLevels({ errors: ['lowToner'] }));
    assert.equal(state(acc), OPEN, 'the printer\'s low flag still shows');
    assert.equal(battery(acc)?.getCharacteristic(C.StatusLowBattery).value, C.StatusLowBattery.BATTERY_LEVEL_LOW);
  });

  test('IPP in auto with levels: updates SNMP\'s tiles but removes none, and stores nothing', () => {
    const { acc, printer } = setup({ protocol: 'auto', tonerTile: true, tileType: 'humidity' });
    const two = (b: number, c: number): QueryResult => {
      const supplies = [{ color: 'black' as const, level: b, fine: b }, { color: 'cyan' as const, level: c, fine: c }];
      return { ...reading(b), supplies, lowestSupply: supplies[c < b ? 1 : 0] };
    };
    printer.apply(two(60, 50));
    const cyan = acc.getServiceById(S.HumiditySensor, 'tile-cyan');
    assert.ok(cyan);
    const remembered = { ...acc.context };
    printer.apply(viaIpp({ ...reading(55), drums: {}, parts: {} })); // black only
    assert.equal(acc.getServiceById(S.HumiditySensor, 'tile-cyan'), cyan, 'the cyan tile stays');
    assert.equal(acc.getServiceById(S.HumiditySensor, 'tonerTile')?.getCharacteristic(C.CurrentRelativeHumidity).value, 55);
    assert.deepEqual(acc.context, remembered, 'nothing stored from the stand-in reading');
  });

  test('IPP in auto: the battery is the lowest of IPP\'s and SNMP\'s last levels; a full reading can clear low', () => {
    const { acc, printer } = setup({ protocol: 'auto', lowTonerSensor: true, lowTonerThreshold: 10 });
    const sup = (b: number, c: number): QueryResult => {
      const supplies = [{ color: 'black' as const, level: b, fine: b }, { color: 'cyan' as const, level: c, fine: c }];
      return { ...reading(b), supplies, lowestSupply: supplies[c < b ? 1 : 0] };
    };
    printer.apply(sup(60, 50));
    printer.apply(viaIpp({ ...reading(55), drums: {}, parts: {} })); // black only
    assert.equal(battery(acc)?.getCharacteristic(C.BatteryLevel).value, 50, 'cyan is still at 50');
    printer.apply(viaIpp({ ...reading(5), drums: {}, parts: {} }));
    assert.equal(state(acc), OPEN);
    printer.apply(viaIpp({ ...reading(100), drums: {}, parts: {} }));
    assert.equal(state(acc), OPEN, 'black only: not enough to clear');
    printer.apply(viaIpp({ ...sup(100, 50), drums: {}, parts: {} }));
    assert.equal(state(acc), CLOSED, 'every color SNMP had, none low: cleared');
    assert.equal(battery(acc)?.getCharacteristic(C.StatusLowBattery).value, C.StatusLowBattery.BATTERY_LEVEL_NORMAL);
  });

  test('IPP in auto: after a restart, SNMP having answered before still counts', () => {
    const first = setup({ protocol: 'auto', tonerTile: true, tileType: 'humidity' });
    first.printer.apply({ ...reading(60), serial: 'E1' });
    assert.equal(first.acc.context.snmpAnswered, true);
    const again = setup({ protocol: 'auto', tonerTile: true, tileType: 'humidity' }, first.acc);
    again.printer.apply(viaIpp({ ...reading(60), supplies: [], lowestSupply: null, serial: 'e1' }));
    assert.equal(first.acc.context.serial, 'E1', 'not changed by IPP');
    assert.ok(battery(first.acc), 'the battery stays');
  });

  test('IPP in auto: right after a restart IPP doesn\'t raise the battery; a finer-reading low stays low', () => {
    const sup = (b: number, c: number, cFine = c): QueryResult => {
      const supplies = [{ color: 'black' as const, level: b, fine: b }, { color: 'cyan' as const, level: c, fine: cFine }];
      return { ...reading(b), supplies, lowestSupply: supplies[c < b ? 1 : 0] };
    };
    const first = setup({ protocol: 'auto', lowTonerSensor: true, lowTonerThreshold: 10 });
    first.printer.apply(sup(60, 5));
    const again = setup({ protocol: 'auto', lowTonerSensor: true, lowTonerThreshold: 10 }, first.acc);
    again.printer.apply(viaIpp({ ...reading(60), drums: {}, parts: {} })); // black only, before SNMP answers
    assert.equal(battery(first.acc)?.getCharacteristic(C.BatteryLevel).value, 5, 'the cached level stays');

    const { acc, printer } = setup({ protocol: 'auto', lowTonerSensor: true, lowTonerThreshold: 10 });
    printer.apply(sup(60, 20, 8)); // cyan low by its finer reading
    assert.equal(state(acc), OPEN);
    printer.apply(viaIpp({ ...sup(60, 20), drums: {}, parts: {} }));
    assert.equal(state(acc), OPEN, 'not cleared by IPP, which has no finer reading');
    printer.apply(viaIpp({ ...sup(60, 25), drums: {}, parts: {} }));
    assert.equal(state(acc), OPEN, 'IPP rounding a little higher isn\'t a new cartridge');
    printer.apply(viaIpp({ ...sup(60, 100), drums: {}, parts: {} }));
    assert.equal(state(acc), CLOSED, 'a new cartridge clears it');
  });

  test('IPP in auto: a printer without SNMP levels ignores IPP\'s', () => {
    const { acc, printer } = setup({ protocol: 'auto', lowTonerSensor: true, lowTonerThreshold: 10 });
    printer.apply({ ...reading(50), supplies: [], lowestSupply: null });
    printer.apply(viaIpp({ ...reading(5), drums: {}, parts: {} }));
    assert.equal(state(acc), CLOSED);
  });

  test('IPP in auto: a higher drum reading doesn\'t clear the drum warning', () => {
    const { printer, lines } = setup({ protocol: 'auto' });
    printer.apply({ ...reading(50), drums: { black: { percent: 5 } } });
    printer.apply(viaIpp({ ...reading(50), drums: { black: { percent: 40 } }, parts: {} }));
    printer.apply({ ...reading(50), drums: { black: { percent: 5 } } });
    assert.equal(lines.filter((l) => l.includes('Drum is near end of life')).length, 1);
  });

  test('showDrum is retired: no drum battery (Home shows one battery), one note in the log', () => {
    const first = setup({});
    first.acc.addService(S.Battery, 'Printer Drum', 'drum'); // from an older version
    const lines: string[] = [];
    setup({ showDrum: true }, first.acc, lines);
    assert.equal(first.acc.getServiceById(S.Battery, 'drum'), undefined);
    assert.equal(lines.filter((l) => /showDrum\) is no longer used/.test(l)).length, 1);
  });

  test('IPP in auto: an ink tank printer without levels over SNMP doesn\'t get a battery from IPP', () => {
    const { acc, printer } = setup({ protocol: 'auto' });
    printer.apply({ ...reading(50), supplies: [], lowestSupply: null });
    assert.equal(battery(acc), undefined);
    printer.apply(viaIpp(reading(70)));
    assert.equal(battery(acc), undefined);
    assert.equal(acc.context.noLevels, true);
  });

  test('IPP in auto: drums without parts don\'t close the Maintenance sensor', () => {
    const { acc, printer } = setup({ protocol: 'auto', maintenanceSensor: true });
    printer.apply({ ...reading(50), drums: { black: { percent: 60 } }, parts: { fuser: { percent: 2 } } });
    const maintenance = service(acc, S.ContactSensor, 'maintenance');
    assert.equal(maintenance?.getCharacteristic(C.ContactSensorState).value, OPEN);
    printer.apply(viaIpp({ ...reading(50), drums: { black: { percent: 60 } }, parts: {} }));
    assert.equal(maintenance?.getCharacteristic(C.ContactSensorState).value, OPEN, 'still open');
    printer.apply(viaIpp({ ...reading(50), drums: { black: { percent: 3 } }, parts: {} }));
    assert.equal(maintenance?.getCharacteristic(C.ContactSensorState).value, OPEN);
  });

  test('IPP in auto before SNMP has ever answered: IPP readings count in full', () => {
    const { acc, printer } = setup({ protocol: 'auto', lowTonerSensor: true });
    printer.apply(noLevels({ model: 'Brother MFC-L2750DW series', serial: 'E9' }));
    assert.equal(acc.context.model, 'MFC-L2750DW series');
    assert.equal(acc.context.serial, 'E9');
    assert.equal(battery(acc), undefined, 'no level to show');
    assert.ok(lowSensor(acc), 'the low sensor follows the printer\'s flag');
  });

  test('IPP from a real Epson XP-6000: photo black gets its own tile; the maker and model show in Home', () => {
    const epson = toPrinterData(parseResponse(readFileSync(join(__dirname, 'fixtures', 'ipp', 'epson-xp-6000.bin'))).printer);
    const { acc, printer } = setup({ protocol: 'ipp', tonerTile: true, tileType: 'humidity' });
    printer.apply(viaIpp({ ...epson, snmpVersion: null }));
    const photo = acc.getServiceById(S.HumiditySensor, 'tile-photoBlack');
    assert.equal(photo?.getCharacteristic(C.ConfiguredName).value, 'Photo Black Ink');
    assert.equal(photo?.getCharacteristic(C.CurrentRelativeHumidity).value, 27);
    assert.equal(acc.getServiceById(S.HumiditySensor, 'tonerTile')?.getCharacteristic(C.CurrentRelativeHumidity).value, 64);
    assert.equal(battery(acc)?.getCharacteristic(C.BatteryLevel).value, 6, 'the lowest: yellow');
    const info = acc.getService(S.AccessoryInformation)!;
    assert.equal(info.getCharacteristic(C.Manufacturer).value, 'Epson');
    assert.equal(info.getCharacteristic(C.Model).value, 'XP-6000 Series');
    // Renaming the printer renames the extra tiles too
    const renamed = setup({ protocol: 'ipp', tonerTile: true, tileType: 'humidity', name: 'Studio' }, acc);
    assert.equal(renamed.acc.getServiceById(S.HumiditySensor, 'tile-photoBlack')?.getCharacteristic(C.ConfiguredName).value, 'Photo Black Ink');
  });

  test('supplies shown before a restart: a failed supplies walk on the first poll is a failed poll', () => {
    const first = setup({});
    first.printer.apply(reading(50));
    assert.equal(first.acc.context.noLevels, false);
    const again = setup({}, first.acc);
    assert.equal(again.printer.options.state?.suppliesRead, true);
    const fresh = setup({});
    assert.equal(fresh.printer.options.state?.suppliesRead, false);
  });

  test('supplies that couldn\'t be read this time: online, last levels, drum and sensors kept', async () => {
    const { acc, printer } = setup({ lowTonerSensor: true, maintenanceSensor: true, tonerTile: true, tileType: 'humidity' });
    await pollWith(printer, { ...reading(8), drums: { black: { percent: 5 } }, drumPercent: 5 });
    assert.equal(battery(acc)?.getCharacteristic(C.BatteryLevel).value, 8);
    assert.equal(state(acc), OPEN);
    const maint = service(acc, S.ContactSensor, 'maintenance');
    assert.equal(maint?.getCharacteristic(C.ContactSensorState).value, OPEN);
    // The printer answers, but its supplies table doesn't
    await pollWith(printer, { ...reading(8), supplies: [], lowestSupply: null, drums: {}, drumPercent: null, suppliesUnread: true });
    assert.equal(printer.online, true);
    assert.equal(battery(acc)?.getCharacteristic(C.BatteryLevel).value, 8, 'the battery stays, with its level');
    assert.equal(state(acc), OPEN, 'still low');
    assert.equal(maint?.getCharacteristic(C.ContactSensorState).value, OPEN, 'the drum is still due');
    assert.ok(acc.getServiceById(S.HumiditySensor, 'tonerTile'), 'the tile stays');
    assert.equal(acc.context.noLevels, false, 'not taken for a printer without levels');
  });

  test('supplies that keep not reading: a warning after offlineAfter polls, the printer\'s own low flag still counts', async () => {
    const lines: string[] = [];
    const { acc, printer } = setup({ lowTonerSensor: true, offlineAfter: 2 }, null, lines);
    await pollWith(printer, reading(50));
    assert.equal(state(acc), CLOSED);
    const unread = { ...reading(50), supplies: [], lowestSupply: null, suppliesUnread: true };
    await pollWith(printer, unread);
    assert.equal(lines.filter((l) => /haven't been readable/.test(l)).length, 0);
    await pollWith(printer, { ...unread, errors: ['lowToner'] });
    assert.equal(lines.filter((l) => l.startsWith('warn') && /haven't been readable for 2 polls/.test(l)).length, 1);
    assert.equal(state(acc), OPEN, 'the printer says toner low');
    assert.equal(battery(acc)?.getCharacteristic(C.StatusLowBattery).value, C.StatusLowBattery.BATTERY_LEVEL_LOW);
    await pollWith(printer, unread);
    assert.equal(lines.filter((l) => /haven't been readable/.test(l)).length, 1, 'warned once');
    await pollWith(printer, reading(50));
    assert.ok(lines.some((l) => /Supply levels read again/.test(l)));
    assert.equal(state(acc), CLOSED);
  });

  test('the first poll after a restart: supplies unread, the Connected line still logged', async () => {
    const first = setup({});
    first.printer.apply(reading(50));
    const lines: string[] = [];
    const again = setup({}, first.acc, lines);
    await pollWith(again.printer, { ...reading(50), supplies: [], lowestSupply: null, suppliesUnread: true });
    assert.ok(lines.some((l) => /Connected to .*supply levels not readable this time/.test(l)));
    assert.equal(battery(first.acc)?.getCharacteristic(C.BatteryLevel).value, 50);
  });

  /* ------------------------------------------------------- paper trays */

  const tray = (name: string, state: 'empty' | 'ok' | 'low' | 'unknown', secondary = false, key = name.toLowerCase().replace(/ /g, '-')) =>
    ({ name, key, state, percent: null, capacity: null, secondary });

  test('paper trays: a sensor per main tray, opened when empty; bypass trays get none', async () => {
    const lines: string[] = [];
    const { acc, printer } = setup({ paperTraySensors: true }, null, lines);
    assert.equal(printer.options.trays, true, 'trays read on every poll');
    await pollWith(printer, { ...reading(50), trays: [tray('MP Tray', 'empty', true), tray('Tray 1', 'ok'), tray('Tray 2', 'empty')] });
    const t1 = acc.getServiceById(S.ContactSensor, 'tray-tray-1');
    const t2 = acc.getServiceById(S.ContactSensor, 'tray-tray-2');
    assert.equal(acc.getServiceById(S.ContactSensor, 'tray-mp-tray'), undefined);
    assert.equal(t1?.getCharacteristic(C.ConfiguredName).value, 'Tray 1');
    assert.equal(t1?.getCharacteristic(C.ContactSensorState).value, CLOSED);
    assert.equal(t2?.getCharacteristic(C.ContactSensorState).value, OPEN);
    assert.equal(lines.filter((l) => l.startsWith('warn') && /Tray 2 is out of paper/.test(l)).length, 1);
    assert.ok(!lines.some((l) => /MP Tray is out of paper/.test(l)));
    // Paper put in; a reading without trays changes nothing
    await pollWith(printer, { ...reading(50), trays: [tray('Tray 1', 'ok'), tray('Tray 2', 'ok')] });
    assert.equal(t2?.getCharacteristic(C.ContactSensorState).value, CLOSED);
    await pollWith(printer, reading(50));
    assert.ok(acc.getServiceById(S.ContactSensor, 'tray-tray-2'));
    // A drawer taken out: its sensor goes
    await pollWith(printer, { ...reading(50), trays: [tray('Tray 1', 'ok')] });
    assert.equal(acc.getServiceById(S.ContactSensor, 'tray-tray-2'), undefined);
    // Offline: No Response like the other sensors
    await pollWith(printer, new Error('timeout'));
    await pollWith(printer, new Error('timeout'));
    await pollWith(printer, new Error('timeout'));
    assert.equal(printer.online, false);
    assert.equal(t1?.getCharacteristic(C.StatusActive).value, false);
  });

  test('paper trays: kept across a restart and a rename; removed when turned off', async () => {
    const first = setup({ paperTraySensors: true });
    await pollWith(first.printer, { ...reading(50), trays: [tray('Tray 1', 'empty')] });
    const renamed = setup({ paperTraySensors: true, name: 'Office' }, first.acc);
    const svc = first.acc.getServiceById(S.ContactSensor, 'tray-tray-1');
    assert.equal(renamed.printer.trays['tray-1'], svc);
    assert.equal(svc?.getCharacteristic(C.ConfiguredName).value, 'Tray 1');
    setup({ name: 'Office' }, first.acc);
    assert.equal(first.acc.getServiceById(S.ContactSensor, 'tray-tray-1'), undefined);
  });

  test('paper trays: IPP standing in updates SNMP\'s sensors only, to a state it\'s sure of', async () => {
    const { acc, printer } = setup({ protocol: 'auto', paperTraySensors: true });
    await pollWith(printer, { ...reading(50), trays: [tray('Tray 1', 'empty'), tray('Tray 2', 'ok')] });
    const t1 = acc.getServiceById(S.ContactSensor, 'tray-tray-1')!;
    const ippReading = (trays: ReturnType<typeof tray>[]) => ({ ...reading(50), snmpVersion: null, via: 'ipp' as const, trays });
    // Other names (Canon: "main", "rear") and unknown levels: nothing added, removed or closed
    await pollWith(printer, ippReading([tray('Main', 'ok'), tray('Tray 1', 'unknown')]));
    assert.equal(acc.getServiceById(S.ContactSensor, 'tray-main'), undefined);
    assert.ok(acc.getServiceById(S.ContactSensor, 'tray-tray-2'), 'not removed');
    assert.equal(t1.getCharacteristic(C.ContactSensorState).value, OPEN, 'unknown doesn\'t close it');
    // A definite reading does count
    await pollWith(printer, ippReading([tray('Tray 1', 'ok')]));
    assert.equal(t1.getCharacteristic(C.ContactSensorState).value, CLOSED);
  });

  test('paper trays: a tray keeps its sensor when a reading takes it for a bypass tray', async () => {
    const { acc, printer } = setup({ paperTraySensors: true });
    await pollWith(printer, { ...reading(50), trays: [tray('Tray 2', 'ok')] });
    const svc = acc.getServiceById(S.ContactSensor, 'tray-tray-2');
    const lines: string[] = [];
    (printer.log as unknown as { warn: (m: string) => void }).warn = (m) => lines.push(m);
    await pollWith(printer, { ...reading(50), trays: [tray('Tray 2', 'empty', true)] });
    assert.equal(acc.getServiceById(S.ContactSensor, 'tray-tray-2'), svc, 'the same sensor');
    assert.equal(svc?.getCharacteristic(C.ContactSensorState).value, OPEN);
    assert.ok(lines.some((l) => /Tray 2 is out of paper/.test(l)), 'and the warning');
  });

  test('paper trays: with tray sensors, a failed tray read doesn\'t repeat the warning', async () => {
    const lines: string[] = [];
    const { printer } = setup({ paperTraySensors: true }, null, lines);
    await pollWith(printer, { ...reading(50), trays: [tray('Tray 1', 'empty')] });
    await pollWith(printer, reading(50)); // trays couldn't be read
    await pollWith(printer, { ...reading(50), trays: [tray('Tray 1', 'empty')] });
    assert.equal(lines.filter((l) => /Tray 1 is out of paper/.test(l)).length, 1);
  });

  test('paper trays: a tray whose level is never known gets no sensor', async () => {
    const { acc, printer } = setup({ paperTraySensors: true });
    await pollWith(printer, { ...reading(50), trays: [tray('Input Tray 1', 'unknown')] });
    assert.equal(acc.getServiceById(S.ContactSensor, 'tray-input-tray-1'), undefined);
  });

  test('paper trays: the warning comes again after the paper error clears (trays read only during one)', async () => {
    const lines: string[] = [];
    const { printer } = setup({}, null, lines);
    const out = { ...reading(50), errors: ['noPaper' as const], trays: [tray('Tray 1', 'empty')] };
    await pollWith(printer, out);
    await pollWith(printer, reading(50)); // refilled: no error, trays not read
    await pollWith(printer, out);
    assert.equal(lines.filter((l) => /Tray 1 is out of paper/.test(l)).length, 2);
  });

  test('paper trays: without sensors, still a warning naming the empty tray', async () => {
    const lines: string[] = [];
    const { acc, printer } = setup({}, null, lines);
    assert.equal(printer.options.trays, undefined);
    await pollWith(printer, { ...reading(50), trays: [tray('Tray 1', 'empty')] });
    assert.ok(lines.some((l) => /Tray 1 is out of paper/.test(l)));
    assert.equal(acc.getServiceById(S.ContactSensor, 'tray-tray-1'), undefined);
  });

  /* -------------------------------------------------------------- usage */

  test('usage: one reading a day in the cache, a weekly line in the log, time left with a low warning', async (t) => {
    const lines: string[] = [];
    const { acc, printer } = setup({}, null, lines);
    const DAY = 86400_000;
    let now = Date.UTC(2026, 0, 1);
    t.mock.method(Date, 'now', () => now);
    for (let day = 0; day <= 10; day++) {
      now = Date.UTC(2026, 0, 1) + day * DAY;
      await pollWith(printer, { ...reading(60 - day * 5), totalPages: 1000 + day * 20 });
      await pollWith(printer, { ...reading(60 - day * 5), totalPages: 1000 + day * 20 }); // same day: no new reading
    }
    assert.equal(acc.context.usage?.length, 11);
    assert.ok(lines.some((l) => l.startsWith('info') && /140 pages printed in the last 7 days\. Toner: about 5 days left\./.test(l)), lines.join('\n'));
    const low = lines.find((l) => /Toner is low: 10%/.test(l));
    assert.match(low ?? '', /At the rate it's been going down, about 2 days left\./);
    // IPP standing in and unread supplies record nothing
    const before = acc.context.usage!.length;
    now += 2 * DAY;
    await pollWith(printer, { ...reading(10), supplies: [], lowestSupply: null, suppliesUnread: true });
    assert.equal(acc.context.usage!.length, before);
  });

  test('a printer whose maker can\'t be named shows as "Printer", never Brother', () => {
    const { acc, printer } = setup({});
    printer.apply({ ...reading(50), model: null, manufacturer: null });
    assert.equal(acc.getService(S.AccessoryInformation)!.getCharacteristic(C.Manufacturer).value, 'Printer');
  });

  test('IPP only, toner as "some remaining": no battery or tiles, low flag on the sensor', () => {
    const { acc, printer } = setup({ protocol: 'ipp', lowTonerSensor: true, tonerTile: true, tileType: 'humidity' });
    printer.apply(viaIpp(reading(50)));
    assert.ok(acc.getServiceById(S.HumiditySensor, 'tonerTile'));
    printer.apply(noLevels());
    assert.equal(battery(acc), undefined);
    assert.equal(acc.getServiceById(S.HumiditySensor, 'tonerTile'), undefined, 'no stale tile');
    printer.apply(noLevels({ errors: ['lowToner'] }));
    assert.equal(state(acc), OPEN);
  });

  test('low toner sensor: kept across restarts, removed when turned off', () => {
    const first = setup({ lowTonerSensor: true });
    first.printer.apply(reading(5));
    const again = setup({ lowTonerSensor: true }, first.acc);
    assert.equal(again.printer.lowSensor, lowSensor(first.acc));
    setup({ lowTonerSensor: false }, first.acc);
    assert.equal(lowSensor(first.acc), undefined);
  });

  test('low toner sensor: No Response while the printer is offline', () => {
    const { acc, printer } = setup({ lowTonerSensor: true });
    printer.apply(reading(50));
    const sensor = lowSensor(acc);
    assert.ok(sensor);
    assert.ok(printer.guarded.includes(sensor.getCharacteristic(C.ContactSensorState)));
    printer.setOnline(false);
    assert.equal(sensor.getCharacteristic(C.StatusActive).value, false);
  });

  /* ---------------------------------------------------------------- battery */

  const battery = (acc: Acc) => service(acc, S.Battery, 'toner');
  const batteryName = (acc: Acc) => battery(acc)?.getCharacteristic(C.ConfiguredName).value;

  test('battery: named Ink on inkjets, Toner on lasers', () => {
    const ink = setup({});
    ink.printer.apply(fromModel('mfc-j680dw'));
    assert.equal(batteryName(ink.acc), 'Ink');
    const laser = setup({});
    laser.printer.apply(reading(50));
    assert.equal(batteryName(laser.acc), 'Toner');
  });

  test('battery: keeps a name the user set in Home', () => {
    const { acc, printer } = setup({});
    battery(acc)?.setCharacteristic(C.ConfiguredName, 'Office ink');
    printer.apply(fromModel('mfc-j680dw'));
    assert.equal(batteryName(acc), 'Office ink');
  });

  test('battery: an inkjet keeps the Ink name across restarts', () => {
    const first = setup({});
    first.printer.apply(fromModel('mfc-j680dw'));
    setup({}, first.acc);
    assert.equal(batteryName(first.acc), 'Ink');
  });

  test('battery: printers without levels get none, and it stays gone after a restart', () => {
    const lines: string[] = [];
    const first = setup({}, null, lines);
    first.printer.apply(fromModel('mfc-t910dw'));
    assert.equal(battery(first.acc), undefined);
    const again = setup({}, first.acc, lines);
    assert.equal(battery(first.acc), undefined, 'not re-added before the first poll');
    again.printer.apply(fromModel('mfc-t910dw'));
    assert.equal(lines.filter((l) => /leaving out the battery/.test(l)).length, 1);
  });

  test('battery: comes back if a printer later reports levels', () => {
    const { acc, printer } = setup({});
    printer.apply(fromModel('mfc-t910dw'));
    printer.apply(reading(40));
    assert.equal(battery(acc)?.getCharacteristic(C.BatteryLevel).value, 40);
  });

  /* --------------------------------------------------------------- settings */

  test('settings: values that aren\'t numbers fall back to the defaults', () => {
    const { acc, printer } = setup({
      lowTonerThreshold: 'ten', lowDrumThreshold: '', pollInterval: 'x', offlineAfter: null, port: 'abc',
    });
    assert.equal(printer.lowToner, 10);
    assert.equal(printer.lowDrum, 10);
    assert.equal(printer.interval, 60000);
    assert.equal(printer.offlineAfter, 3);
    assert.equal(printer.options.port, 161);
    printer.apply(reading(0));
    assert.equal(battery(acc)?.getCharacteristic(C.StatusLowBattery).value, C.StatusLowBattery.BATTERY_LEVEL_LOW);
  });

  test('settings: numbers outside the allowed range are clamped', () => {
    const { printer } = setup({ lowTonerThreshold: 150, pollInterval: 5, offlineAfter: 99, port: '9161' });
    assert.equal(printer.lowToner, 100);
    assert.equal(printer.interval, 10000);
    assert.equal(printer.offlineAfter, 20);
    assert.equal(printer.options.port, 9161);
  });

  /* ---------------------------------------------------------------- offline */

  test('offline: No Response only after offlineAfter failed polls, and recovers', async () => {
    const { acc, printer } = setup({ offlineAfter: 2 });
    await pollWith(printer, reading(50));
    const level = battery(acc)?.getCharacteristic(C.BatteryLevel);
    assert.ok(level);
    assert.equal(await read(level), 50);

    await pollWith(printer, new Error('Request timed out'));
    assert.equal(await read(level), 50, 'one failure is tolerated');
    await pollWith(printer, new Error('Request timed out'));
    assert.deepEqual(await read(level), { error: hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE });

    await pollWith(printer, reading(50));
    assert.equal(await read(level), 50);
  });

  /* ---------------------------------------------------------------- problem */

  const problem = (acc: Acc) => service(acc, S.ContactSensor, 'problem');

  test('problem sensor: opens on a jam and closes when it clears', () => {
    const { acc, printer, lines } = setup({});
    printer.apply(reading(50));
    assert.equal(problem(acc)?.getCharacteristic(C.ContactSensorState).value, CLOSED);
    printer.apply(reading(50, 50, { fault: true, faults: ['jammed'] }));
    assert.equal(problem(acc)?.getCharacteristic(C.ContactSensorState).value, OPEN);
    assert.ok(lines.some((l) => /warn: .*Problem: paper jam/.test(l)));
    printer.apply(reading(50));
    assert.equal(problem(acc)?.getCharacteristic(C.ContactSensorState).value, CLOSED);
  });

  test('problem sensor: left out when turned off', () => {
    const { acc } = setup({ faultSensor: false });
    assert.equal(problem(acc), undefined);
  });
  /* ------------------------------------------------------------------ SNMPv3 */

  test('SNMPv3: settings reach the query; defaults are SHA and AES', () => {
    const { printer } = setup({ snmpVersion: '3', v3User: ' hb ', v3AuthPassword: 'auth-pass', v3PrivPassword: 'priv-pass' });
    assert.equal(printer.options.version, '3');
    assert.deepEqual(printer.options.v3, {
      user: 'hb', authProtocol: 'sha', authPassword: 'auth-pass', privProtocol: 'aes', privPassword: 'priv-pass', context: '',
    });
  });

  test('SNMPv3: a missing user or short password stops setup with the reason', () => {
    assert.throws(() => setup({ snmpVersion: '3' }), /user name/);
    assert.throws(() => setup({ snmpVersion: '3', v3User: 'hb', v3AuthPassword: 'short', v3PrivProtocol: 'none' }), /at least 8/);
  });

  test('SNMPv3: unknown protocols and encryption without authentication stop setup', () => {
    const base = { snmpVersion: '3', v3User: 'hb', v3AuthPassword: 'auth-pass', v3PrivPassword: 'priv-pass' };
    assert.throws(() => setup({ ...base, v3AuthProtocol: 'sha-3' }), /authentication "sha-3" isn't supported/);
    assert.throws(() => setup({ ...base, v3AuthProtocol: 'none' }), /needs authentication/);
    const { printer } = setup({ ...base, v3AuthProtocol: 'SHA256', v3PrivProtocol: 'AES128', v3Context: ' ctx ' });
    assert.equal(printer.options.v3?.authProtocol, 'sha256');
    assert.equal(printer.options.v3?.privProtocol, 'aes');
    assert.equal(printer.options.v3?.context, 'ctx');
  });

  test('SNMPv3: v3 settings are ignored unless the version is 3', () => {
    const { printer } = setup({ v3User: 'hb' });
    assert.equal(printer.options.version, 'auto');
    assert.equal(printer.options.v3, undefined);
  });

  test('a serial number in the settings that isn\'t the printer\'s is logged once', () => {
    const { printer, lines } = setup({ serial: 'TYPO1' });
    printer.apply({ ...reading(50), serial: 'REAL1' });
    printer.apply({ ...reading(50), serial: 'REAL1' });
    assert.equal(lines.filter((l) => l.includes('serial number in the settings (TYPO1) isn\'t this printer\'s (REAL1)')).length, 1);
  });

  test('a different serial number at the same address is logged', () => {
    const { acc, printer, lines } = setup({});
    printer.apply({ ...reading(50), serial: 'E111' });
    assert.ok(!lines.some((l) => l.includes('looks like a different printer')));
    printer.apply({ ...reading(50), serial: 'E222' });
    assert.ok(lines.some((l) => l.startsWith('warn: ') && l.includes('serial number E222, not E111')), lines.join('\n'));
    assert.equal(acc.context.serial, 'E222');
  });

  /* ------------------------------------------------------------ Eve history */

  test('Eve history: off by default, and needs the toner tiles', () => {
    entries = []; started = 0;
    setup({ tonerTile: true, tileType: 'humidity' }).printer.apply(reading(50));
    assert.equal(started, 0);
    const { printer, lines } = setup({ eveHistory: true });
    printer.apply(reading(50));
    printer.apply(reading(40));
    assert.equal(started, 0);
    assert.equal(lines.filter((l) => l.includes('Eve history needs')).length, 1, 'warned once');
  });

  test('Eve history: the lowest level, on a change or every 10 minutes', (t) => {
    entries = []; started = 0;
    t.mock.timers.enable({ apis: ['Date'], now: 1_800_000_000_000 });
    const { printer } = setup({ eveHistory: true, tonerTile: true, tileType: 'humidity' });
    printer.apply(reading(70));
    assert.equal(started, 1, 'started once the tiles exist');
    printer.apply(reading(70));
    assert.equal(entries.length, 1, 'no new entry within 10 minutes when nothing changed');
    t.mock.timers.tick(10 * 60 * 1000);
    printer.apply(reading(70));
    assert.equal(entries.length, 2, 'repeated after 10 minutes');
    printer.apply(reading(60));
    assert.deepEqual(entries.map((e) => e.humidity), [70, 70, 60], 'a change is logged right away');
    assert.equal(entries[1].time - entries[0].time, 600);
    assert.equal(started, 1);
  });

  test('Eve history: the history service is removed when turned off', () => {
    const { acc } = setup({});
    acc.addService(new S('History', 'E863F007-079E-48FF-8F27-9C2605A29F52'));
    setup({}, acc);
    assert.equal(acc.services.find((svc) => svc.UUID === 'E863F007-079E-48FF-8F27-9C2605A29F52'), undefined);
  });

  test('Eve history: users who had it keep humidity tiles when tileType isn\'t set; no history service without them', () => {
    const { acc, printer } = setup({ eveHistory: true, tonerTile: true });
    assert.equal(printer.tileType, 'humidity');
    printer.apply(reading(55));
    assert.ok(acc.getServiceById(S.HumiditySensor, 'tonerTile'));
    acc.addService(new S('History', 'E863F007-079E-48FF-8F27-9C2605A29F52'));
    // Light tiles chosen: Eve can't draw on them, so the history service goes
    setup({ eveHistory: true, tonerTile: true, tileType: 'light' }, acc);
    assert.equal(acc.services.find((svc) => svc.UUID === 'E863F007-079E-48FF-8F27-9C2605A29F52'), undefined);
  });

  test('Eve history: works with the real fakegato-history', async (t) => {
    const { mkdtempSync, readdirSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    storageDir = mkdtempSync(`${tmpdir()}/bp-history-`);
    t.after(() => { rmSync(storageDir, { recursive: true, force: true }); historyStarter = recordHistory; });
    historyStarter = startHistory;
    const { acc, printer } = setup({ eveHistory: true, tonerTile: true, tileType: 'humidity' });
    printer.apply(reading(55));
    const history = acc.services.find((svc) => svc.UUID === 'E863F007-079E-48FF-8F27-9C2605A29F52');
    assert.ok(history, 'fakegato added Eve\'s history service');
    assert.ok(printer.history);
    // fakegato reads the saved history asynchronously; entries before that are
    // dropped, so the plugin waits for it rather than losing one
    const loaded = (): boolean => printer.history?.isHistoryLoaded?.() === true;
    for (let i = 0; i < 100 && !loaded(); i++) { await new Promise((r) => setTimeout(r, 100)); }
    assert.ok(loaded(), 'fakegato finished loading');
    assert.equal(printer.lastEntry, undefined, 'the reading before that is not counted as logged');
    printer.apply(reading(45));
    assert.equal((printer.lastEntry as HistoryEntry | undefined)?.humidity, 45);
    for (let i = 0; i < 50 && !readdirSync(storageDir).some((f) => f.endsWith('-history.json')); i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.deepEqual(readdirSync(storageDir), [`homebridge-brother-printer-${acc.UUID}-history.json`]);
  });

  /* ------------------------------------------------------ optional sensors */

  test('new sensors: all off by default', () => {
    const { acc } = setup({});
    assert.equal(service(acc, S.ContactSensor, 'maintenance'), undefined);
    assert.equal(service(acc, S.ContactSensor, 'noPaper'), undefined);
    assert.equal(acc.getServiceById(S.OccupancySensor, 'online'), undefined);
  });

  test('maintenance sensor: opens when the drum or another part is low', () => {
    const { acc, printer } = setup({ maintenanceSensor: true, lowDrumThreshold: 10 });
    const svc = service(acc, S.ContactSensor, 'maintenance');
    assert.equal(svc?.getCharacteristic(C.ConfiguredName).value, 'Maintenance');
    const ok = { drums: { black: { percent: 60 } }, parts: { fuser: { percent: 70 } } };
    printer.apply(reading(50, 50, ok));
    assert.equal(svc?.getCharacteristic(C.ContactSensorState).value, CLOSED);
    printer.apply(reading(50, 50, { ...ok, drums: { black: { percent: 8 } } }));
    assert.equal(svc?.getCharacteristic(C.ContactSensorState).value, OPEN, 'drum low');
    printer.apply(reading(50, 50, { ...ok, parts: { fuser: { percent: 10 } } }));
    assert.equal(svc?.getCharacteristic(C.ContactSensorState).value, OPEN, 'fuser low');
    printer.apply(reading(50, 50, ok));
    assert.equal(svc?.getCharacteristic(C.ContactSensorState).value, CLOSED);
    assert.ok(svc && printer.guarded.includes(svc.getCharacteristic(C.ContactSensorState)));
  });

  test('out of paper sensor: opens on an empty tray only', () => {
    const { acc, printer } = setup({ paperSensor: true });
    const svc = service(acc, S.ContactSensor, 'noPaper');
    assert.equal(svc?.getCharacteristic(C.ConfiguredName).value, 'Out of Paper');
    printer.apply(reading(50));
    assert.equal(svc?.getCharacteristic(C.ContactSensorState).value, CLOSED);
    printer.apply(reading(50, 50, { fault: true, faults: ['jammed'], errors: ['jammed'] }));
    assert.equal(svc?.getCharacteristic(C.ContactSensorState).value, CLOSED, 'a jam is not out of paper');
    printer.apply(reading(50, 50, { fault: true, faults: ['noPaper'], errors: ['noPaper'] }));
    assert.equal(svc?.getCharacteristic(C.ContactSensorState).value, OPEN);
    printer.apply(reading(50));
    assert.equal(svc?.getCharacteristic(C.ContactSensorState).value, CLOSED);
  });

  test('offline sensor (onlineSensor): a contact sensor that opens while the printer doesn\'t answer, readable then', async () => {
    const first = setup({});
    first.acc.addService(S.OccupancySensor, 'Printer Online', 'online'); // the occupancy sensor before 0.10
    const { acc, printer } = setup({ onlineSensor: true, offlineAfter: 1 }, first.acc);
    assert.equal(acc.getServiceById(S.OccupancySensor, 'online'), undefined, 'the old Online occupancy sensor goes');
    const svc = acc.getServiceById(S.ContactSensor, 'offline');
    assert.ok(svc);
    assert.equal(svc.getCharacteristic(C.ConfiguredName).value, 'Offline');
    assert.notEqual(printer.main, svc, 'the printing sensor is still the main one');
    const state = svc.getCharacteristic(C.ContactSensorState);
    await pollWith(printer, reading(50));
    assert.equal(await read(state), CLOSED);
    await pollWith(printer, new Error('Request timed out'));
    assert.equal(await read(state), OPEN, 'readable while offline');
    await pollWith(printer, reading(50));
    assert.equal(await read(state), CLOSED);
  });

  test('new sensors: kept across restarts, removed when turned off', () => {
    const on = { maintenanceSensor: true, paperSensor: true, onlineSensor: true };
    const first = setup(on);
    const again = setup(on, first.acc);
    assert.equal(again.printer.maintenance, service(first.acc, S.ContactSensor, 'maintenance'));
    assert.equal(again.printer.paper, service(first.acc, S.ContactSensor, 'noPaper'));
    assert.equal(again.printer.onlineSvc, first.acc.getServiceById(S.ContactSensor, 'offline'));
    assert.equal(again.printer.main, first.printer.main, 'the cached printing sensor is reused');
    setup({}, first.acc);
    assert.equal(service(first.acc, S.ContactSensor, 'maintenance'), undefined);
    assert.equal(service(first.acc, S.ContactSensor, 'noPaper'), undefined);
    assert.equal(first.acc.getServiceById(S.ContactSensor, 'offline'), undefined);
  });

  test('printing as a contact sensor (printingSensor): the main tile opens while a job prints', async () => {
    const first = setup({});
    const occupancy = first.printer.main;
    const { acc, printer } = setup({ printingSensor: 'contact' }, first.acc);
    assert.equal(acc.services.includes(occupancy), false, 'the occupancy sensor goes');
    assert.equal(printer.main, acc.getServiceById(S.ContactSensor, 'printing'));
    assert.equal(printer.main.isPrimaryService, true);
    assert.equal(printer.main.getCharacteristic(C.ConfiguredName).value, 'Printer');
    await pollWith(printer, { ...reading(50), printing: true });
    assert.equal(printer.main.getCharacteristic(C.ContactSensorState).value, OPEN);
    await pollWith(printer, reading(50));
    assert.equal(printer.main.getCharacteristic(C.ContactSensorState).value, CLOSED);
    // Back to occupancy (the default)
    const back = setup({}, acc);
    assert.equal(acc.getServiceById(S.ContactSensor, 'printing'), undefined);
    assert.equal(back.printer.main.UUID, S.OccupancySensor.UUID);
  });

  test('toner tiles: light sensors by default', () => {
    const { acc, printer } = setup({ tonerTile: true });
    printer.apply(reading(70));
    assert.equal(acc.getServiceById(S.LightSensor, 'tonerTile')?.getCharacteristic(C.CurrentAmbientLightLevel).value, 70);
    assert.equal(acc.getServiceById(S.HumiditySensor, 'tonerTile'), undefined);
  });

  test('toner tiles as light sensors (tileType light): the level in lux, not in the room\'s humidity', () => {
    const first = setup({ tonerTile: true, tileType: 'humidity' });
    first.printer.apply(reading(40));
    const { acc, printer, lines } = setup({ tonerTile: true, tileType: 'light', eveHistory: true }, first.acc);
    assert.equal(acc.getServiceById(S.HumiditySensor, 'tonerTile'), undefined, 'the humidity tile goes');
    printer.apply(reading(0));
    const tile = acc.getServiceById(S.LightSensor, 'tonerTile');
    assert.equal(tile?.getCharacteristic(C.CurrentAmbientLightLevel).value, 0.0001, 'lux can\'t be 0');
    printer.apply(reading(60));
    assert.equal(tile?.getCharacteristic(C.CurrentAmbientLightLevel).value, 60);
    assert.ok(lines.some((l) => /Eve history needs the toner \/ ink tiles shown as humidity/.test(l)));
  });

  test('toner tiles: a filter-life tile from 0.12.0-beta.3 becomes a light tile', () => {
    const first = setup({ tonerTile: true });
    first.acc.addService(S.FilterMaintenance, 'Toner', 'tonerTile');
    const lines: string[] = [];
    const { acc, printer } = setup({ tonerTile: true, tileType: 'filter' }, first.acc, lines);
    assert.equal(acc.getServiceById(S.FilterMaintenance, 'tonerTile'), undefined, 'the filter tile goes');
    assert.ok(lines.some((l) => l.includes('"Show the tiles as: Filter life" is no longer offered')), lines.join('\n'));
    printer.apply(reading(70));
    assert.equal(acc.getServiceById(S.LightSensor, 'tonerTile')?.getCharacteristic(C.CurrentAmbientLightLevel).value, 70);
  });

  test('sensor names: what they are; names from before 0.10 move over, names set in Home stay', () => {
    const first = setup({ lowTonerSensor: true, tonerTile: true, tileType: 'humidity' });
    first.printer.apply(reading(50));
    const low = service(first.acc, S.ContactSensor, 'lowToner')!;
    const problem = service(first.acc, S.ContactSensor, 'problem')!;
    // As 0.9 named them, one renamed in Home
    low.setCharacteristic(C.ConfiguredName, 'Printer Toner Low');
    problem.setCharacteristic(C.ConfiguredName, 'Printer jams');
    first.acc.getServiceById(S.HumiditySensor, 'tonerTile')!.setCharacteristic(C.ConfiguredName, 'Printer Toner');
    const again = setup({ lowTonerSensor: true, tonerTile: true, tileType: 'humidity' }, first.acc);
    again.printer.apply(reading(50));
    assert.equal(low.getCharacteristic(C.ConfiguredName).value, 'Toner Low');
    assert.equal(problem.getCharacteristic(C.ConfiguredName).value, 'Printer jams');
    assert.equal(first.acc.getServiceById(S.HumiditySensor, 'tonerTile')!.getCharacteristic(C.ConfiguredName).value, 'Toner');
    // Color tiles: "Cyan Toner"
    const color = setup({ tonerTile: true, tileType: 'humidity' });
    color.printer.apply(fromModel('dcp-l3550cdw'));
    assert.equal(color.acc.getServiceById(S.HumiditySensor, 'tile-cyan')!.getCharacteristic(C.ConfiguredName).value, 'Cyan Toner');
  });

  test('switching printingSensor keeps every sensor linked to the printer\'s tile', async () => {
    const first = setup({ lowTonerSensor: true, paperTraySensors: true });
    await pollWith(first.printer, { ...reading(5), trays: [tray('Tray 1', 'ok')] });
    const linked = (p: PrinterAccessory) => (p.main as unknown as { linkedServices: Service[] }).linkedServices.map((s) => s.subtype).sort();
    const contact = setup({ lowTonerSensor: true, paperTraySensors: true, printingSensor: 'contact' }, first.acc);
    assert.deepEqual(linked(contact.printer), ['lowToner', 'problem', 'toner', 'tray-tray-1']);
    const back = setup({ lowTonerSensor: true, paperTraySensors: true }, first.acc);
    assert.deepEqual(linked(back.printer), ['lowToner', 'problem', 'toner', 'tray-tray-1']);
  });

  test('renamed printer: its tile and sensors follow, even when its name is a sensor\'s', () => {
    // A printer named "Toner" (its battery is "Toner" too), renamed "Laser"
    const first = setup({ name: 'Toner', lowTonerSensor: true });
    first.printer.apply(reading(50));
    const again = setup({ name: 'Laser', lowTonerSensor: true }, first.acc);
    again.printer.apply(reading(50));
    assert.equal(again.printer.main.getCharacteristic(C.ConfiguredName).value, 'Laser');
    assert.equal(battery(first.acc)!.getCharacteristic(C.ConfiguredName).value, 'Toner', 'the battery isn\'t renamed after the printer');
    // 0.9's names after the old printer name move to today's
    low(first.acc).setCharacteristic(C.ConfiguredName, 'Laser Toner Low');
    const third = setup({ name: 'Office', lowTonerSensor: true }, first.acc);
    third.printer.apply(reading(50));
    assert.equal(low(first.acc).getCharacteristic(C.ConfiguredName).value, 'Toner Low');
  });

  test('renamed while offline: the sensors still get today\'s names once it answers, in a later run', async () => {
    const first = setup({ name: 'Old', tonerTile: true, lowTonerSensor: true });
    first.printer.apply(reading(50));
    // As 0.9 named them
    first.acc.getServiceById(S.LightSensor, 'tonerTile')!.setCharacteristic(C.ConfiguredName, 'Old Toner');
    low(first.acc).setCharacteristic(C.ConfiguredName, 'Old Toner Low');
    // Renamed; the printer doesn't answer in this run
    const renamed = setup({ name: 'New', tonerTile: true, lowTonerSensor: true }, first.acc);
    assert.equal(first.acc.getService(S.AccessoryInformation)!.getCharacteristic(C.Name).value, 'New');
    assert.equal(renamed.printer.main.getCharacteristic(C.ConfiguredName).value, 'New');
    assert.equal(first.acc.context.previousName, 'Old');
    // The next run, the printer answers
    const later = setup({ name: 'New', tonerTile: true, lowTonerSensor: true }, first.acc);
    later.printer.apply(reading(50));
    assert.equal(first.acc.getServiceById(S.LightSensor, 'tonerTile')!.getCharacteristic(C.ConfiguredName).value, 'Toner');
    assert.equal(low(first.acc).getCharacteristic(C.ConfiguredName).value, 'Toner Low');
    assert.equal(first.acc.context.previousName, undefined, 'not needed any more');
  });

  test('a printer read row by row is remembered across restarts', () => {
    const first = setup({});
    assert.equal(first.printer.options.state!.noBulk, undefined);
    first.printer.options.state!.noBulk = true; // learnt during a poll
    first.printer.apply(reading(50));
    assert.equal(first.acc.context.noBulk, true);
    const again = setup({}, first.acc);
    assert.equal(again.printer.options.state!.noBulk, true, 'no bulk try after the restart');
  });

  test('an inkjet\'s Toner Low sensor becomes Ink Low', () => {
    const { acc, printer } = setup({ lowTonerSensor: true });
    printer.apply(reading(50));
    assert.equal(low(acc).getCharacteristic(C.ConfiguredName).value, 'Toner Low');
    printer.apply({ ...reading(50), type: 'ink' });
    assert.equal(low(acc).getCharacteristic(C.ConfiguredName).value, 'Ink Low');
  });

  test('sensor names with several printers: the printer\'s name in front', () => {
    const lines: string[] = [];
    const acc = Object.assign(new hap.Accessory('Office', hap.uuid.generate('office')), { context: {} }) as unknown as Acc;
    const log = Object.fromEntries(['info', 'warn', 'error', 'debug'].map((l) => [l, (m: string) => lines.push(m)])) as unknown as Logging;
    const api = { hap, updatePlatformAccessories: () => {}, user: { storagePath: () => storageDir } } as unknown as API;
    const p = new PrinterAccessory({ log, api }, acc, { name: 'Office', host: '10.0.0.1', lowTonerSensor: true },
      { query: () => new Promise(() => {}), prefixNames: true });
    p.stop();
    p.apply(reading(50));
    assert.equal(service(acc, S.ContactSensor, 'lowToner')!.getCharacteristic(C.ConfiguredName).value, 'Office Toner Low');
    assert.equal(service(acc, S.ContactSensor, 'problem')!.getCharacteristic(C.ConfiguredName).value, 'Office Problem');
  });

  test('firmware: the printer\'s when it\'s a version Home shows, else the plugin\'s', () => {
    const { acc, printer } = setup({});
    const info = () => acc.getService(S.AccessoryInformation)!.getCharacteristic(C.FirmwareRevision).value;
    printer.apply({ ...reading(50), firmware: 'SWP1FN1514BR' });
    assert.match(String(info()), /^\d+\.\d+\.\d+/, 'the plugin\'s version');
    printer.apply({ ...reading(50), firmware: '1.14' });
    assert.equal(info(), '1.14');
    assert.equal(acc.context.firmware, '1.14');
    const again = setup({}, acc);
    assert.equal(again.acc.getService(S.AccessoryInformation)!.getCharacteristic(C.FirmwareRevision).value, '1.14', 'kept after a restart');
    // A firmware Home can't show (say, another printer at the address): the plugin's again
    again.printer.apply({ ...reading(50), firmware: 'SWP1FN1514BR' });
    assert.equal(acc.context.firmware, undefined);
    assert.match(String(again.acc.getService(S.AccessoryInformation)!.getCharacteristic(C.FirmwareRevision).value), /^\d+\.\d+\.\d+/);
  });

  test('toner tiles: kept across restarts when on, removed from the cache when turned off', () => {
    const first = setup({ tonerTile: true, tileType: 'humidity' });
    first.printer.apply(reading(40));
    const tile = first.acc.getServiceById(S.HumiditySensor, 'tonerTile');
    assert.ok(tile, 'a tile for the black toner');
    const again = setup({ tonerTile: true, tileType: 'humidity' }, first.acc);
    assert.equal(again.printer.tiles.black, tile, 'the cached tile is reused');
    setup({ tonerTile: false }, first.acc);
    assert.equal(first.acc.getServiceById(S.HumiditySensor, 'tonerTile'), undefined, 'removed when turned off');
  });

  test('an error while updating HomeKit is logged, and polling goes on', async () => {
    const lines: string[] = [];
    const { printer } = setup({}, null, lines);
    printer.apply = () => { throw new Error('bad reading'); };
    await pollWith(printer, fromModel(Object.keys(models)[0]));
    assert.ok(lines.some((l) => l.startsWith('error: [Printer] Couldn\'t update HomeKit: ') && l.includes('bad reading')), lines.join('\n'));
    assert.equal(printer.failures, 0, 'the poll itself counts as a success');
  });

  /* ------------------------------------------------------------ moved printer */

  test('moved printer: once offline, found by its serial number at a new address and read there', async () => {
    const lines: string[] = [];
    const serial = 'E78123A4N123456';
    const { acc, printer } = setup({ offlineAfter: 2, pollInterval: 60 }, null, lines);
    acc.context.host = '10.0.0.1';
    await pollWith(printer, reading(50, 50, { serial }));
    assert.equal(acc.context.serial, serial);
    const searches: [string, string][] = [];
    finder = (s, options, skip) => { searches.push([s, skip]); return Promise.resolve({ host: '10.0.0.9' }); };
    try {
      await pollWith(printer, new Error('Request timed out'));
      assert.equal(searches.length, 0, 'not on the first failure');
      // The poll fails at the old address; the search's own read answers at the new one
      printer.stopped = false;
      const read: string[] = [];
      respond = (o) => { read.push(o.host); return read.length === 1 ? Promise.reject(new Error('Request timed out')) : Promise.resolve(reading(40)); };
      await printer.poll();
      printer.stop();
      assert.deepEqual(searches, [[serial, '10.0.0.1']]);
      assert.deepEqual(read, ['10.0.0.1', '10.0.0.9']);
      assert.equal(printer.options.host, '10.0.0.9');
      assert.equal(printer.failures, 0, 'read at the new address: back online');
      assert.deepEqual(acc.context.moved, { from: '10.0.0.1', to: '10.0.0.9' });
      assert.ok(lines.some((l) => l.startsWith('warn: ') && l.includes('at 10.0.0.9 instead of 10.0.0.1')), lines.join('\n'));

      // After a restart with the same settings: read at the new address straight away
      const again = setup({}, acc, lines);
      assert.equal(again.printer.options.host, '10.0.0.9');
      // With the address changed in the settings: that one, and the note goes
      const changed = setup({ host: '10.0.0.20' }, acc, lines);
      assert.equal(changed.printer.options.host, '10.0.0.20');
      assert.equal(acc.context.moved, undefined);
    } finally {
      finder = findNothing;
    }
  });

  test('moved printer: no search without a serial number, and every 15 minutes while offline', async () => {
    let searches = 0;
    finder = () => { searches++; return Promise.resolve(null); };
    try {
      const { printer } = setup({ offlineAfter: 1, pollInterval: 300 });
      await pollWith(printer, new Error('Request timed out'));
      assert.equal(searches, 0, 'no serial number known');
      const withSerial = setup({ offlineAfter: 1, pollInterval: 300, serial: 'E78123A4N123456' });
      for (let i = 0; i < 7; i++) { await pollWith(withSerial.printer, new Error('Request timed out')); }
      // At the 1st failure, then every 3 polls of 5 minutes: 1st, 4th, 7th
      assert.equal(searches, 3);
      assert.equal(withSerial.printer.options.host, '10.0.0.1', 'not found: the same address');
    } finally {
      finder = findNothing;
    }
  });

  test('moved printer: another printer at its address starts a search; back at the set address clears the note', async () => {
    const serial = 'E78123A4N123456';
    const lines: string[] = [];
    const { acc, printer } = setup({ serial }, null, lines);
    acc.context.host = '10.0.0.1';
    await pollWith(printer, reading(50, 50, { serial }));
    let hosts: string[] = [];
    finder = () => Promise.resolve({ host: '10.0.0.9' });
    try {
      respond = (o) => { hosts.push(o.host); return Promise.resolve(reading(o.host === '10.0.0.9' ? 40 : 90, undefined, { serial: o.host === '10.0.0.9' ? serial : 'OTHER123' })); };
      printer.stopped = false;
      await printer.poll();
      printer.stop();
      assert.deepEqual(hosts, ['10.0.0.1', '10.0.0.9'], 'read where it was found');
      assert.equal(acc.context.serial, serial, 'the serial number stays');
      assert.equal(printer.lastReading?.supplies[0].level, 40);
      assert.deepEqual(acc.context.moved, { from: '10.0.0.1', to: '10.0.0.9' });

      // Found back at the address in the settings
      finder = () => Promise.resolve({ host: '10.0.0.1' });
      printer.stopped = false;
      const r = await printer.findMoved();
      printer.stop();
      assert.equal(r.found, true);
      assert.equal(printer.options.host, '10.0.0.1');
      assert.equal(acc.context.moved, undefined);
      assert.ok(lines.some((l) => l.includes('back at 10.0.0.1')));
      hosts = [];
    } finally {
      finder = findNothing;
      respond = never;
    }
  });

  test('another printer at the address: not taken as this one; offline while it\'s looked for; taken after a day', async () => {
    const lines: string[] = [];
    const { acc, printer } = setup({ offlineAfter: 1 }, null, lines);
    await pollWith(printer, reading(50, 50, { serial: 'MINE1' }));
    let searches = 0;
    finder = () => { searches++; return Promise.resolve(null); };
    try {
      await pollWith(printer, reading(90, 90, { serial: 'OTHER1' }));
      assert.equal(acc.context.serial, 'MINE1');
      assert.equal(printer.lastReading?.supplies[0].level, 50, 'the other printer\'s reading isn\'t used');
      assert.equal(printer.online, false);
      assert.equal(searches, 1);
      assert.equal(acc.context.otherSerial?.serial, 'OTHER1');
      assert.equal(lines.filter((l) => l.includes('Another printer (serial number OTHER1)')).length, 1);
      await pollWith(printer, reading(90, 90, { serial: 'OTHER1' }));
      assert.equal(searches, 1, 'searched again only after 15 minutes');
      assert.equal(acc.context.serial, 'MINE1');

      // A day later: a replaced printer, taken as this one
      acc.context.otherSerial!.since -= 25 * 3600 * 1000;
      await pollWith(printer, reading(90, 90, { serial: 'OTHER1' }));
      assert.equal(acc.context.serial, 'OTHER1');
      assert.equal(printer.online, true);
      assert.equal(acc.context.otherSerial, undefined);
    } finally {
      finder = findNothing;
    }
  });

  test('another printer at the address: never taken while the settings name this one\'s serial number', async () => {
    const { acc, printer } = setup({ serial: 'MINE1', offlineAfter: 1 });
    await pollWith(printer, reading(50, 50, { serial: 'MINE1' }));
    try {
      await pollWith(printer, reading(90, 90, { serial: 'OTHER1' }));
      acc.context.otherSerial!.since -= 48 * 3600 * 1000;
      await pollWith(printer, reading(90, 90, { serial: 'OTHER1' }));
      assert.equal(acc.context.serial, 'MINE1');
      assert.equal(printer.online, false);
      // Silent in between: the day starts again
      await pollWith(printer, new Error('Request timed out'));
      assert.equal(acc.context.otherSerial, undefined);
    } finally {
      finder = findNothing;
    }
  });

  test('another printer at the address: taken at once when its serial number is in the settings', async () => {
    const { acc, printer } = setup({ serial: 'NEW1' });
    acc.context.serial = 'OLD1';
    finder = () => { throw new Error('no search expected'); };
    try {
      await pollWith(printer, reading(60, 60, { serial: 'NEW1' }));
      assert.equal(acc.context.serial, 'NEW1');
    } finally {
      finder = findNothing;
    }
  });

  test('moved printer: no search for a host name', async () => {
    let searches = 0;
    finder = () => { searches++; return Promise.resolve(null); };
    try {
      const { printer } = setup({ host: 'printer.local', offlineAfter: 1, serial: 'E78123A4N123456' });
      await pollWith(printer, new Error('Request timed out'));
      assert.equal(searches, 0);
    } finally {
      finder = findNothing;
    }
  });

  test('page counts by kind: on the printer tile when the printer gives them', async () => {
    const byName = (acc: Acc, name: string) => acc.getService(S.OccupancySensor)?.characteristics.find((c) => c.displayName === name);
    const color = setup({});
    await pollWith(color.printer, fromModel('dcp-l3550cdw'));
    assert.equal(byName(color.acc, 'Color Pages')?.value, 902);
    assert.equal(byName(color.acc, 'Black-and-White Pages')?.value, 709);
    assert.equal(byName(color.acc, 'Two-Sided Pages')?.value, 538);
    assert.equal(byName(color.acc, 'Pages Printed')?.value, 1611);

    const mono = setup({});
    await pollWith(mono.printer, fromModel('hl-l2340dw'));
    assert.equal(byName(mono.acc, 'Color Pages'), undefined, 'none it doesn\'t give');
    assert.equal(byName(mono.acc, 'Black-and-White Pages'), undefined, 'the total says it');
  });

  test('output tray full sensor: opens on the error bit or the display, closes after; off by default', () => {
    const { acc, printer } = setup({ outputSensor: true });
    const output = () => service(acc, S.ContactSensor, 'outputFull');
    printer.apply(reading(50));
    assert.equal(output()?.getCharacteristic(C.ContactSensorState).value, CLOSED);
    printer.apply(reading(50, 50, { errors: ['outputFull'], fault: true, faults: ['outputFull'] }));
    assert.equal(output()?.getCharacteristic(C.ContactSensorState).value, OPEN);
    printer.apply(reading(50, 50, { statusText: 'Output Tray Full' }));
    assert.equal(output()?.getCharacteristic(C.ContactSensorState).value, OPEN, 'from the display');
    printer.apply(reading(50));
    assert.equal(output()?.getCharacteristic(C.ContactSensorState).value, CLOSED);
    assert.equal(service(setup({}).acc, S.ContactSensor, 'outputFull'), undefined);
  });

  test('dashboard: the latest reading and its time are kept', async () => {
    const { printer } = setup({});
    assert.equal(printer.lastReading, null);
    await pollWith(printer, reading(30));
    assert.equal((printer.lastReading as QueryResult | null)?.supplies[0].level, 30);
    assert.ok(Date.now() - printer.lastReadAt < 5000);
  });

}
