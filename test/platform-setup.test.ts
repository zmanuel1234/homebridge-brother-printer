// The platform setting up real printer accessories (on Homebridge's HAP library): registering,
// reusing cached ones, duplicate names, removing printers taken out of the config, a printer
// that fails to set up, and shutdown. Polling is stubbed: no SNMP traffic.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { API, Logging, PlatformAccessory, PlatformConfig } from 'homebridge';
import { BrotherPrinterPlatform } from '../src/platform';
import { PrinterAccessory } from '../src/accessory';
import type * as HapNodejs from '@homebridge/hap-nodejs';

type Hap = typeof HapNodejs;
let hap: Hap | null = null;
let loadError = '';
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  hap = require('@homebridge/hap-nodejs') as Hap;
} catch (err) {
  loadError = (err as Error).message.split('\n')[0];
}

if (!hap) {
  test('platform setup tests', { skip: `HAP library doesn't load on Node ${process.version}: ${loadError}` }, () => {});
} else {
  defineTests(hap);
}

function defineTests(hap: Hap): void {
  // No SNMP: the platform's wiring is what's tested here (accessory.test.ts covers polling).
  const realPoll = PrinterAccessory.prototype.poll;
  test.before(() => { PrinterAccessory.prototype.poll = async () => {}; });
  test.after(() => { PrinterAccessory.prototype.poll = realPoll; });

  function homebridge() {
    const api = new EventEmitter() as EventEmitter & Record<string, unknown>;
    const calls = { registered: [] as PlatformAccessory[], updated: [] as PlatformAccessory[], unregistered: [] as PlatformAccessory[] };
    api.hap = hap;
    api.platformAccessory = function (name: string, uuid: string): PlatformAccessory {
      return Object.assign(new hap!.Accessory(name, uuid), { context: {} }) as unknown as PlatformAccessory;
    };
    api.registerPlatformAccessories = (_p: string, _n: string, list: PlatformAccessory[]) => calls.registered.push(...list);
    api.updatePlatformAccessories = (list: PlatformAccessory[]) => calls.updated.push(...list);
    api.unregisterPlatformAccessories = (_p: string, _n: string, list: PlatformAccessory[]) => calls.unregistered.push(...list);
    const lines: string[] = [];
    const log = Object.fromEntries(['info', 'warn', 'error', 'debug']
      .map((l) => [l, (m: string) => lines.push(`${l}: ${m}`)])) as unknown as Logging;
    const start = (printers: Record<string, unknown>[], cached: PlatformAccessory[] = []) => {
      const platform = new BrotherPrinterPlatform(log, { platform: 'BrotherPrinter', printers } as PlatformConfig, api as unknown as API);
      cached.forEach((a) => platform.configureAccessory(a));
      api.emit('didFinishLaunching');
      return platform;
    };
    const cachedAccessory = (name: string, host: string): PlatformAccessory => {
      const uuid = hap!.uuid.generate(`homebridge-brother-printer:${name}`);
      return Object.assign(new hap!.Accessory(name, uuid), { context: { host } }) as unknown as PlatformAccessory;
    };
    return { api, calls, lines, start, cachedAccessory };
  }

  test('a new printer is registered once, with its host saved', () => {
    const { calls, lines, start } = homebridge();
    const platform = start([{ name: 'Office', host: ' 10.0.4.150 ' }]);
    assert.equal(platform.printers.length, 1);
    assert.equal(calls.registered.length, 1);
    assert.equal(calls.registered[0].displayName, 'Office');
    assert.equal((calls.registered[0].context as { host: string }).host, '10.0.4.150', 'trimmed');
    assert.ok(lines.includes('info: Added printer "Office" (10.0.4.150).'));
    assert.ok(!lines.some((l) => l.startsWith('warn') || l.startsWith('error')), lines.join('\n'));
  });

  test('a printer Homebridge already had is reused and updated, not registered again', () => {
    const { calls, start, cachedAccessory } = homebridge();
    const cached = cachedAccessory('Office', '10.0.0.9');
    start([{ name: 'Office', host: '10.0.4.150' }], [cached]);
    assert.deepEqual(calls.registered, []);
    assert.deepEqual(calls.updated, [cached]);
    assert.equal((cached.context as { host: string }).host, '10.0.4.150', 'the new address is saved');
  });

  test('two printers with the same name: the second is skipped with a warning', () => {
    const { calls, lines, start } = homebridge();
    const platform = start([{ name: 'Office', host: '10.0.0.1' }, { name: 'Office', host: '10.0.0.2' }]);
    assert.equal(platform.printers.length, 1);
    assert.equal(calls.registered.length, 1);
    assert.ok(lines.includes('warn: Two printers are named "Office". Give each a unique name; skipping the second.'));
  });

  test('a printer taken out of the config is removed from HomeKit', () => {
    const { calls, lines, start, cachedAccessory } = homebridge();
    const old = cachedAccessory('Basement', '10.0.0.7');
    const kept = cachedAccessory('Office', '10.0.0.9');
    start([{ name: 'Office', host: '10.0.0.9' }], [old, kept]);
    assert.deepEqual(calls.unregistered, [old]);
    assert.ok(lines.includes('info: Removed printer "Basement", no longer in config.'));
  });

  test('a printer that fails to set up is logged and left out; the others still work', () => {
    const { calls, lines, start } = homebridge();
    const realBuild = PrinterAccessory.prototype.buildServices;
    PrinterAccessory.prototype.buildServices = function (this: PrinterAccessory) {
      if (this.name === 'Broken') { throw new Error('boom'); }
      realBuild.call(this);
    };
    try {
      const platform = start([{ name: 'Broken', host: '10.0.0.1' }, { name: 'Office', host: '10.0.0.2' }]);
      assert.ok(lines.includes('error: [Broken] Couldn\'t set up this printer: boom'));
      assert.deepEqual(calls.registered.map((a) => a.displayName), ['Office']);
      assert.equal(platform.printers.length, 1);
    } finally {
      PrinterAccessory.prototype.buildServices = realBuild;
    }
  });

  test('shutdown stops every printer\'s polling', () => {
    const { api, start } = homebridge();
    const platform = start([{ name: 'A', host: '10.0.0.1' }, { name: 'B', host: '10.0.0.2' }]);
    api.emit('shutdown');
    assert.ok(platform.printers.every((p) => p.stopped));
  });
}
