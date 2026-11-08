'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// These tests use Homebridge's HAP library, whose current release needs a newer
// Node than the plugin supports. At runtime Homebridge brings its own copy, so
// on an older Node only these tests are skipped; the decoder and SNMP tests run.
let hap;
try {
  hap = require('@homebridge/hap-nodejs');
} catch (err) {
  test('accessory tests', { skip: `HAP library doesn't load on Node ${process.version}: ${err.message.split('\n')[0]}` }, () => {});
  return;
}

const snmp = require('../dist/snmp');
const models = require('./fixtures/brother-models.json');

// Polls are driven by hand: by default the accessory's own first poll never
// resolves; a test can set respond to answer or fail a poll.
const never = () => new Promise(() => {});
let respond = never;
snmp.query = (options) => respond(options);
const { PrinterAccessory } = require('../dist/accessory');

const { Service, Characteristic: C } = hap;
const OPEN = C.ContactSensorState.CONTACT_NOT_DETECTED;
const CLOSED = C.ContactSensorState.CONTACT_DETECTED;

function setup(config, accessory, lines = []) {
  respond = never;
  const acc = accessory || Object.assign(new hap.Accessory('Printer', hap.uuid.generate(String(Math.random()))), { context: {} });
  const log = ['info', 'warn', 'error', 'debug'].reduce((o, l) => ({ ...o, [l]: (m) => lines.push(`${l}: ${m}`) }), {});
  const api = { hap, updatePlatformAccessories: () => {} };
  const printer = new PrinterAccessory({ log, api }, acc, { name: 'Printer', host: '10.0.0.1', ...config });
  printer.stop();
  return { acc, printer, lines };
}

/** Run one poll by hand with the given answer (data) or failure (Error) */
async function pollWith(printer, answer) {
  respond = () => (answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer));
  printer.stopped = false;
  await printer.poll();
  printer.stop();
  respond = never;
}

/** What Home gets when it reads a characteristic: its value, or the HAP error status */
async function read(ch) {
  try {
    return await ch.handleGetRequest();
  } catch (status) {
    return { error: status };
  }
}

const reading = (level, fine = level, extra = {}) => {
  const d = snmp.parse(models['hl-l2340dw'].raw);
  const s = { color: 'black', level, fine };
  return { ...d, supplies: [s], lowestSupply: s, ...extra };
};
const lowSensor = (acc) => acc.getServiceById(Service.ContactSensor, 'lowToner');
const state = (acc) => lowSensor(acc).getCharacteristic(C.ContactSensorState).value;

test('low toner sensor: off by default', () => {
  const { acc, printer } = setup({});
  printer.apply(reading(5));
  assert.equal(lowSensor(acc), undefined);
});

test('low toner sensor: closed while toner is fine, opens at the threshold', () => {
  const { acc, printer } = setup({ lowTonerSensor: true, lowTonerThreshold: 10 });
  printer.apply(reading(80));
  assert.equal(lowSensor(acc).getCharacteristic(C.ConfiguredName).value, 'Printer Toner Low');
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
  assert.equal(lowSensor(acc).getCharacteristic(C.ConfiguredName).value, 'Printer Ink Low');
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
  assert.ok(printer.guarded.includes(lowSensor(acc).getCharacteristic(C.ContactSensorState)));
  printer.setOnline(false);
  assert.equal(lowSensor(acc).getCharacteristic(C.StatusActive).value, false);
});

/* ------------------------------------------------------------ battery */

const battery = (acc) => acc.getServiceById(Service.Battery, 'toner');
const batteryName = (acc) => battery(acc).getCharacteristic(C.ConfiguredName).value;

test('battery: named Ink on inkjets, Toner on lasers', () => {
  const ink = setup({});
  ink.printer.apply(snmp.parse(models['mfc-j680dw'].raw));
  assert.equal(batteryName(ink.acc), 'Printer Ink');
  const laser = setup({});
  laser.printer.apply(reading(50));
  assert.equal(batteryName(laser.acc), 'Printer Toner');
});

test('battery: keeps a name the user set in Home', () => {
  const { acc, printer } = setup({});
  battery(acc).setCharacteristic(C.ConfiguredName, 'Office ink');
  printer.apply(snmp.parse(models['mfc-j680dw'].raw));
  assert.equal(batteryName(acc), 'Office ink');
});

test('battery: an inkjet keeps the Ink name across restarts', () => {
  const first = setup({});
  first.printer.apply(snmp.parse(models['mfc-j680dw'].raw));
  setup({}, first.acc);
  assert.equal(batteryName(first.acc), 'Printer Ink');
});

test('battery: printers without levels get none, and it stays gone after a restart', () => {
  const lines = [];
  const first = setup({}, null, lines);
  first.printer.apply(snmp.parse(models['mfc-t910dw'].raw));
  assert.equal(battery(first.acc), undefined);
  const again = setup({}, first.acc, lines);
  assert.equal(battery(first.acc), undefined, 'not re-added before the first poll');
  again.printer.apply(snmp.parse(models['mfc-t910dw'].raw));
  assert.equal(lines.filter((l) => /leaving out the battery/.test(l)).length, 1);
});

test('battery: comes back if a printer later reports levels', () => {
  const { acc, printer } = setup({});
  printer.apply(snmp.parse(models['mfc-t910dw'].raw));
  printer.apply(reading(40));
  assert.equal(battery(acc).getCharacteristic(C.BatteryLevel).value, 40);
});

/* ----------------------------------------------------------- settings */

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
  assert.equal(battery(acc).getCharacteristic(C.StatusLowBattery).value, C.StatusLowBattery.BATTERY_LEVEL_LOW);
});

test('settings: numbers outside the allowed range are clamped', () => {
  const { printer } = setup({ lowTonerThreshold: 150, pollInterval: 5, offlineAfter: 99, port: '9161' });
  assert.equal(printer.lowToner, 100);
  assert.equal(printer.interval, 10000);
  assert.equal(printer.offlineAfter, 20);
  assert.equal(printer.options.port, 9161);
});

/* ------------------------------------------------------------ offline */

test('offline: No Response only after offlineAfter failed polls, and recovers', async () => {
  const { acc, printer } = setup({ offlineAfter: 2 });
  await pollWith(printer, reading(50));
  const level = battery(acc).getCharacteristic(C.BatteryLevel);
  assert.equal(await read(level), 50);

  await pollWith(printer, new Error('Request timed out'));
  assert.equal(await read(level), 50, 'one failure is tolerated');
  await pollWith(printer, new Error('Request timed out'));
  assert.deepEqual(await read(level), { error: hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE });

  await pollWith(printer, reading(50));
  assert.equal(await read(level), 50);
});

/* ------------------------------------------------------------ problem */

const problem = (acc) => acc.getServiceById(Service.ContactSensor, 'problem');

test('problem sensor: opens on a jam and closes when it clears', () => {
  const { acc, printer, lines } = setup({});
  printer.apply(reading(50));
  assert.equal(problem(acc).getCharacteristic(C.ContactSensorState).value, CLOSED);
  printer.apply(reading(50, 50, { fault: true, faults: ['jammed'] }));
  assert.equal(problem(acc).getCharacteristic(C.ContactSensorState).value, OPEN);
  assert.ok(lines.some((l) => /warn: .*Problem: paper jam/.test(l)));
  printer.apply(reading(50));
  assert.equal(problem(acc).getCharacteristic(C.ContactSensorState).value, CLOSED);
});

test('problem sensor: left out when turned off', () => {
  const { acc } = setup({ faultSensor: false });
  assert.equal(problem(acc), undefined);
});
