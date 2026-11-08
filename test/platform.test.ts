import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { API, Logging, PlatformAccessory, PlatformConfig } from 'homebridge';
import { BrotherPrinterPlatform } from '../src/platform';

interface FakeApi extends EventEmitter {
  hap: { uuid: { generate: (s: string) => string } };
  registered: PlatformAccessory[];
  registerPlatformAccessories: (plugin: string, platform: string, list: PlatformAccessory[]) => void;
  unregisterPlatformAccessories: () => void;
  updatePlatformAccessories: () => void;
}

function fakeHomebridge(): { api: FakeApi; log: Logging; lines: string[] } {
  const api = new EventEmitter() as FakeApi;
  api.hap = { uuid: { generate: (s) => s } };
  api.registered = [];
  api.registerPlatformAccessories = (_p, _n, list) => api.registered.push(...list);
  api.unregisterPlatformAccessories = () => {};
  api.updatePlatformAccessories = () => {};
  const lines: string[] = [];
  const log = Object.fromEntries(['info', 'warn', 'error', 'debug']
    .map((l) => [l, (m: string) => lines.push(`${l}: ${m}`)])) as unknown as Logging;
  return { api, log, lines };
}

const start = (log: Logging, config: Record<string, unknown>, api: FakeApi): BrotherPrinterPlatform =>
  new BrotherPrinterPlatform(log, config as PlatformConfig, api as unknown as API);

test('does nothing until a printer is configured', () => {
  const { api, log, lines } = fakeHomebridge();
  const platform = start(log, { platform: 'BrotherPrinter' }, api);
  api.emit('didFinishLaunching');
  assert.equal(platform.printers.length, 0);
  assert.equal(api.registered.length, 0);
  assert.deepEqual(lines, []);
});

test('skips the blank row the settings screen saves, without a warning', () => {
  const { api, log, lines } = fakeHomebridge();
  const blank = { name: 'Printer', pollInterval: 60, lowTonerThreshold: 10, faultSensor: true, offlineAfter: 3 };
  const platform = start(log, { printers: [blank] }, api);
  api.emit('didFinishLaunching');
  assert.equal(platform.printers.length, 0);
  assert.equal(lines.filter((l) => l.startsWith('warn')).length, 0);
});

test('warns about a filled-in row with no host', () => {
  const { api, log, lines } = fakeHomebridge();
  start(log, { printers: [{ name: 'Office', pollInterval: 30 }] }, api);
  api.emit('didFinishLaunching');
  assert.equal(lines.filter((l) => l.startsWith('warn')).length, 1);
});

test('a setup error is logged, not thrown', () => {
  const { api, log, lines } = fakeHomebridge();
  (api as unknown as { hap: object }).hap = {}; // broken HAP: uuid.generate is missing
  start(log, { printers: [{ name: 'P', host: '10.0.0.1' }] }, api);
  assert.doesNotThrow(() => api.emit('didFinishLaunching'));
  assert.ok(lines.some((l) => l.startsWith('error')));
});
