'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { BrotherPrinterPlatform } = require('../dist/platform');

function fakeHomebridge() {
  const api = new EventEmitter();
  api.hap = { uuid: { generate: (s) => s } };
  api.registered = [];
  api.registerPlatformAccessories = (_p, _n, list) => api.registered.push(...list);
  api.unregisterPlatformAccessories = () => {};
  api.updatePlatformAccessories = () => {};
  const lines = [];
  const log = ['info', 'warn', 'error', 'debug'].reduce((o, l) => ({ ...o, [l]: (m) => lines.push(`${l}: ${m}`) }), {});
  return { api, log, lines };
}

test('does nothing until a printer is configured', () => {
  const { api, log, lines } = fakeHomebridge();
  const platform = new BrotherPrinterPlatform(log, { platform: 'BrotherPrinter' }, api);
  api.emit('didFinishLaunching');
  assert.equal(platform.printers.length, 0);
  assert.equal(api.registered.length, 0);
  assert.deepEqual(lines, []);
});

test('skips the blank row the settings screen saves, without a warning', () => {
  const { api, log, lines } = fakeHomebridge();
  const blank = { name: 'Printer', pollInterval: 60, lowTonerThreshold: 10, faultSensor: true, offlineAfter: 3 };
  const platform = new BrotherPrinterPlatform(log, { printers: [blank] }, api);
  api.emit('didFinishLaunching');
  assert.equal(platform.printers.length, 0);
  assert.equal(lines.filter((l) => l.startsWith('warn')).length, 0);
});

test('warns about a filled-in row with no host', () => {
  const { api, log, lines } = fakeHomebridge();
  new BrotherPrinterPlatform(log, { printers: [{ name: 'Office', pollInterval: 30 }] }, api);
  api.emit('didFinishLaunching');
  assert.equal(lines.filter((l) => l.startsWith('warn')).length, 1);
});

test('a setup error is logged, not thrown', () => {
  const { api, log, lines } = fakeHomebridge();
  api.hap = {}; // broken HAP: uuid.generate is missing
  new BrotherPrinterPlatform(log, { printers: [{ name: 'P', host: '10.0.0.1' }] }, api);
  assert.doesNotThrow(() => api.emit('didFinishLaunching'));
  assert.ok(lines.some((l) => l.startsWith('error')));
});
