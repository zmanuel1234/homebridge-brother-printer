// The platform on Homebridge's own HAP library: registering the switch, reusing the cached one,
// removing stale accessories, the switch's state and its reset timer.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { API, Logging, PlatformAccessory, PlatformConfig } from 'homebridge';
import type * as HapNodejs from '@homebridge/hap-nodejs';
import { ExamplePlatform } from '../src/platform';
import { DEFAULT_SWITCH_NAME, PLUGIN_NAME, readSettings } from '../src/settings';

type Hap = typeof HapNodejs;
let hap: Hap | null = null;
let loadError = '';
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  hap = require('@homebridge/hap-nodejs') as Hap;
} catch (err) {
  loadError = (err as Error).message.split('\n')[0];
}

test('settings: defaults, trimming and limits', () => {
  assert.deepEqual(readSettings({}), { switchName: DEFAULT_SWITCH_NAME, resetSeconds: 0 });
  assert.deepEqual(readSettings({ switchName: '  Porch  ', resetSeconds: 30 }), { switchName: 'Porch', resetSeconds: 30 });
  assert.equal(readSettings({ switchName: '   ' }).switchName, DEFAULT_SWITCH_NAME);
  assert.equal(readSettings({ switchName: ['not', 'text'] }).switchName, DEFAULT_SWITCH_NAME, 'a hand-edited list is ignored');
  assert.equal(readSettings({ resetSeconds: -1 }).resetSeconds, 0);
  assert.equal(readSettings({ resetSeconds: 3601 }).resetSeconds, 0);
  assert.equal(readSettings({ resetSeconds: '30' }).resetSeconds, 0, 'only a number counts');
  assert.equal(readSettings({ resetSeconds: 2.6 }).resetSeconds, 3);
});

if (!hap) {
  test('platform tests', { skip: `HAP library doesn't load on Node ${process.version}: ${loadError}` }, () => {});
} else {
  defineTests(hap);
}

function defineTests(hap: Hap): void {
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
    const log = Object.fromEntries(['info', 'warn', 'error', 'debug'].map((l) => [l, (m: string) => lines.push(`${l}: ${m}`)])) as unknown as Logging;
    const start = (config: Record<string, unknown> = {}, cached: PlatformAccessory[] = []) => {
      const platform = new ExamplePlatform(log, { platform: 'ExamplePlatform', ...config } as PlatformConfig, api as unknown as API);
      cached.forEach((a) => platform.configureAccessory(a));
      api.emit('didFinishLaunching');
      return platform;
    };
    const cachedAccessory = (seed: string, name: string): PlatformAccessory =>
      Object.assign(new hap!.Accessory(name, hap!.uuid.generate(seed)), { context: {} }) as unknown as PlatformAccessory;
    return { api, calls, lines, start, cachedAccessory };
  }

  test('a new switch is registered once, with its name', () => {
    const { calls, lines, start } = homebridge();
    const platform = start({ switchName: 'Porch' });
    assert.equal(calls.registered.length, 1);
    assert.equal(calls.registered[0].displayName, 'Porch');
    assert.equal(platform.switches.length, 1);
    assert.ok(lines.includes('info: Added "Porch".'));
  });

  test('a cached switch is reused and renamed, and stale accessories are removed', () => {
    const { calls, start, cachedAccessory } = homebridge();
    const mine = cachedAccessory(`${PLUGIN_NAME}:switch`, 'Old name');
    const stale = cachedAccessory(`${PLUGIN_NAME}:something-else`, 'Gone');
    start({ switchName: 'New name' }, [mine, stale]);
    assert.equal(calls.registered.length, 0);
    assert.deepEqual(calls.updated, [mine]);
    assert.equal(mine.displayName, 'New name');
    assert.deepEqual(calls.unregistered, [stale]);
  });

  test('the switch keeps its state, and resets itself when set to', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { api, start } = homebridge();
    const sw = start({ resetSeconds: 5 }).switches[0];
    const on = sw.service.getCharacteristic(hap.Characteristic.On);
    sw.set(true);
    assert.equal(sw.isOn, true);
    t.mock.timers.tick(4999);
    assert.equal(sw.isOn, true);
    t.mock.timers.tick(1);
    assert.equal(sw.isOn, false);
    assert.equal(on.value, false, 'HomeKit is told it turned off');
    sw.set(true);
    api.emit('shutdown');
    t.mock.timers.tick(10_000);
    assert.equal(sw.isOn, true, 'the timer stops at shutdown');
  });

  test('without a reset time the switch stays on', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const sw = homebridge().start().switches[0];
    sw.set(true);
    t.mock.timers.tick(3_600_000);
    assert.equal(sw.isOn, true);
  });
}
