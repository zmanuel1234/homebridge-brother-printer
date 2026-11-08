import test from 'node:test';
import assert from 'node:assert/strict';
import type { API, Characteristic, Logging, PlatformAccessory, Service } from 'homebridge';
import { PrinterAccessory } from '../src/accessory';
import type { PrinterConfig, PrinterContext, QueryFn } from '../src/accessory';
import * as snmp from '../src/snmp';
import type { QueryResult } from '../src/snmp';
import modelsJson from './fixtures/brother-models.json';

type Hap = typeof import('@homebridge/hap-nodejs');
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

  function setup(config: Partial<PrinterConfig> & Record<string, unknown>, accessory?: Acc | null, lines: string[] = []) {
    respond = never;
    const acc = accessory || Object.assign(
      new hap.Accessory('Printer', hap.uuid.generate(String(Math.random()))), { context: {} },
    ) as unknown as Acc;
    const log = Object.fromEntries(['info', 'warn', 'error', 'debug']
      .map((l) => [l, (m: string) => lines.push(`${l}: ${m}`)])) as unknown as Logging;
    const api = { hap, updatePlatformAccessories: () => {} } as unknown as API;
    const printer = new PrinterAccessory({ log, api }, acc, { name: 'Printer', host: '10.0.0.1', ...config },
      { query: (options) => respond(options) });
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

  test('low toner sensor: left out on printers that report no levels', () => {
    const { acc, printer } = setup({ lowTonerSensor: true });
    printer.apply(reading(50));
    assert.ok(lowSensor(acc));
    printer.apply({ ...reading(50), supplies: [], lowestSupply: null });
    assert.equal(lowSensor(acc), undefined);
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
}
