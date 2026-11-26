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

  function setup(config: Partial<PrinterConfig> & Record<string, unknown>, accessory?: Acc | null, lines: string[] = []) {
    respond = never;
    const acc = accessory || Object.assign(
      new hap.Accessory('Printer', hap.uuid.generate(String(Math.random()))), { context: {} },
    ) as unknown as Acc;
    const log = Object.fromEntries(['info', 'warn', 'error', 'debug']
      .map((l) => [l, (m: string) => lines.push(`${l}: ${m}`)])) as unknown as Logging;
    const api = { hap, updatePlatformAccessories: () => {}, user: { storagePath: () => storageDir } } as unknown as API;
    const printer = new PrinterAccessory({ log, api }, acc, { name: 'Printer', host: '10.0.0.1', ...config },
      { query: (options) => respond(options), startHistory: (...args) => historyStarter(...args) });
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
    assert.equal(lowSensor(acc)?.getCharacteristic(C.ConfiguredName).value, 'Printer Toner Low');
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
    assert.equal(lowSensor(acc)?.getCharacteristic(C.ConfiguredName).value, 'Printer Ink Low');
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
    const { acc, printer } = setup({ protocol: 'auto', tonerTile: true });
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
    const first = setup({ protocol: 'auto', tonerTile: true });
    first.printer.apply({ ...reading(60), serial: 'E1' });
    assert.equal(first.acc.context.snmpAnswered, true);
    const again = setup({ protocol: 'auto', tonerTile: true }, first.acc);
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

  test('IPP in auto: a drum reading only lowers the drum, and warns once', () => {
    const { acc, printer, lines } = setup({ protocol: 'auto', showDrum: true });
    printer.apply({ ...reading(50), drums: { black: { percent: 5 } } });
    const drum = acc.getServiceById(S.Battery, 'drum');
    printer.apply(viaIpp({ ...reading(50), drums: { black: { percent: 40 } }, parts: {} }));
    assert.equal(drum?.getCharacteristic(C.BatteryLevel).value, 5);
    assert.equal(drum?.getCharacteristic(C.StatusLowBattery).value, C.StatusLowBattery.BATTERY_LEVEL_LOW);
    printer.apply({ ...reading(50), drums: { black: { percent: 5 } } });
    assert.equal(lines.filter((l) => l.includes('Drum is near end of life')).length, 1);
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
    const { acc, printer } = setup({ protocol: 'ipp', tonerTile: true });
    printer.apply(viaIpp({ ...epson, snmpVersion: null }));
    const photo = acc.getServiceById(S.HumiditySensor, 'tile-photoBlack');
    assert.equal(photo?.getCharacteristic(C.ConfiguredName).value, 'Printer Photo Black');
    assert.equal(photo?.getCharacteristic(C.CurrentRelativeHumidity).value, 27);
    assert.equal(acc.getServiceById(S.HumiditySensor, 'tonerTile')?.getCharacteristic(C.CurrentRelativeHumidity).value, 64);
    assert.equal(battery(acc)?.getCharacteristic(C.BatteryLevel).value, 6, 'the lowest: yellow');
    const info = acc.getService(S.AccessoryInformation)!;
    assert.equal(info.getCharacteristic(C.Manufacturer).value, 'Epson');
    assert.equal(info.getCharacteristic(C.Model).value, 'XP-6000 Series');
    // Renaming the printer renames the extra tiles too
    const renamed = setup({ protocol: 'ipp', tonerTile: true, name: 'Studio' }, acc);
    assert.equal(renamed.acc.getServiceById(S.HumiditySensor, 'tile-photoBlack')?.getCharacteristic(C.ConfiguredName).value, 'Studio Photo Black');
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
    const { acc, printer } = setup({ lowTonerSensor: true, maintenanceSensor: true, tonerTile: true });
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

  test('a printer whose maker can\'t be named shows as "Printer", never Brother', () => {
    const { acc, printer } = setup({});
    printer.apply({ ...reading(50), model: null, manufacturer: null });
    assert.equal(acc.getService(S.AccessoryInformation)!.getCharacteristic(C.Manufacturer).value, 'Printer');
  });

  test('IPP only, toner as "some remaining": no battery or tiles, low flag on the sensor', () => {
    const { acc, printer } = setup({ protocol: 'ipp', lowTonerSensor: true, tonerTile: true });
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
    assert.equal(batteryName(ink.acc), 'Printer Ink');
    const laser = setup({});
    laser.printer.apply(reading(50));
    assert.equal(batteryName(laser.acc), 'Printer Toner');
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
    assert.equal(batteryName(first.acc), 'Printer Ink');
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
    setup({ tonerTile: true }).printer.apply(reading(50));
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
    const { printer } = setup({ eveHistory: true, tonerTile: true });
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

  test('Eve history: works with the real fakegato-history', async (t) => {
    const { mkdtempSync, readdirSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    storageDir = mkdtempSync(`${tmpdir()}/bp-history-`);
    t.after(() => { rmSync(storageDir, { recursive: true, force: true }); historyStarter = recordHistory; });
    historyStarter = startHistory;
    const { acc, printer } = setup({ eveHistory: true, tonerTile: true });
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
    assert.equal(svc?.getCharacteristic(C.ConfiguredName).value, 'Printer Maintenance');
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
    assert.equal(svc?.getCharacteristic(C.ConfiguredName).value, 'Printer Out of Paper');
    printer.apply(reading(50));
    assert.equal(svc?.getCharacteristic(C.ContactSensorState).value, CLOSED);
    printer.apply(reading(50, 50, { fault: true, faults: ['jammed'], errors: ['jammed'] }));
    assert.equal(svc?.getCharacteristic(C.ContactSensorState).value, CLOSED, 'a jam is not out of paper');
    printer.apply(reading(50, 50, { fault: true, faults: ['noPaper'], errors: ['noPaper'] }));
    assert.equal(svc?.getCharacteristic(C.ContactSensorState).value, OPEN);
    printer.apply(reading(50));
    assert.equal(svc?.getCharacteristic(C.ContactSensorState).value, CLOSED);
  });

  test('online sensor: follows reachability and stays readable while offline', async () => {
    const { acc, printer } = setup({ onlineSensor: true, offlineAfter: 1 });
    const svc = acc.getServiceById(S.OccupancySensor, 'online');
    assert.ok(svc);
    assert.notEqual(printer.occupancy, svc, 'the printing sensor is still the main one');
    const detected = svc.getCharacteristic(C.OccupancyDetected);
    await pollWith(printer, reading(50));
    assert.equal(await read(detected), C.OccupancyDetected.OCCUPANCY_DETECTED);
    await pollWith(printer, new Error('Request timed out'));
    assert.equal(await read(detected), C.OccupancyDetected.OCCUPANCY_NOT_DETECTED);
    await pollWith(printer, reading(50));
    assert.equal(await read(detected), C.OccupancyDetected.OCCUPANCY_DETECTED);
  });

  test('new sensors: kept across restarts, removed when turned off', () => {
    const on = { maintenanceSensor: true, paperSensor: true, onlineSensor: true };
    const first = setup(on);
    const again = setup(on, first.acc);
    assert.equal(again.printer.maintenance, service(first.acc, S.ContactSensor, 'maintenance'));
    assert.equal(again.printer.paper, service(first.acc, S.ContactSensor, 'noPaper'));
    assert.equal(again.printer.onlineSvc, first.acc.getServiceById(S.OccupancySensor, 'online'));
    assert.equal(again.printer.occupancy, first.printer.occupancy, 'the cached printing sensor is reused');
    setup({}, first.acc);
    assert.equal(service(first.acc, S.ContactSensor, 'maintenance'), undefined);
    assert.equal(service(first.acc, S.ContactSensor, 'noPaper'), undefined);
    assert.equal(first.acc.getServiceById(S.OccupancySensor, 'online'), undefined);
  });

  test('toner tiles: kept across restarts when on, removed from the cache when turned off', () => {
    const first = setup({ tonerTile: true });
    first.printer.apply(reading(40));
    const tile = first.acc.getServiceById(S.HumiditySensor, 'tonerTile');
    assert.ok(tile, 'a tile for the black toner');
    const again = setup({ tonerTile: true }, first.acc);
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
}
