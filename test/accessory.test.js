'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const hap = require('@homebridge/hap-nodejs');
const snmp = require('../lib/snmp');
const models = require('./fixtures/brother-models.json');

// Polls are driven by hand: the accessory's own first poll never resolves
snmp.query = () => new Promise(() => {});
const { PrinterAccessory } = require('../lib/accessory');

const { Service, Characteristic: C } = hap;
const OPEN = C.ContactSensorState.CONTACT_NOT_DETECTED;
const CLOSED = C.ContactSensorState.CONTACT_DETECTED;

function setup(config, accessory) {
  const acc = accessory || Object.assign(new hap.Accessory('Printer', hap.uuid.generate(String(Math.random()))), { context: {} });
  const log = ['info', 'warn', 'error', 'debug'].reduce((o, l) => ({ ...o, [l]: () => {} }), {});
  const api = { hap, updatePlatformAccessories: () => {} };
  const printer = new PrinterAccessory({ log, api }, acc, { name: 'Printer', host: '10.0.0.1', ...config });
  printer.stop();
  return { acc, printer };
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
