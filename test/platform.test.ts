// Strict layer: tests for homebridge/homebridge-plugin-template's example, on Homebridge's own
// HAP library. The official template has none; replace them with the plugin's own as it grows.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import type { API, Logging, PlatformAccessory, PlatformConfig } from 'homebridge';
import type * as HapNodejs from '@homebridge/hap-nodejs';
import { ExampleHomebridgePlatform } from '../src/platform.js';
import { PLATFORM_NAME, PLUGIN_NAME } from '../src/settings.js';

type Hap = typeof HapNodejs;
const require = createRequire(import.meta.url);
let hap: Hap | null = null;
let loadError = '';
try {
  hap = require('@homebridge/hap-nodejs') as Hap;
} catch (err) {
  loadError = (err as Error).message.split('\n')[0];
}

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
    api.registerPlatformAccessories = (plugin: string, platform: string, list: PlatformAccessory[]) => {
      assert.equal(plugin, PLUGIN_NAME);
      assert.equal(platform, PLATFORM_NAME);
      calls.registered.push(...list);
    };
    api.updatePlatformAccessories = (list: PlatformAccessory[]) => calls.updated.push(...list);
    api.unregisterPlatformAccessories = (_p: string, _n: string, list: PlatformAccessory[]) => calls.unregistered.push(...list);
    const log = Object.fromEntries(['info', 'warn', 'error', 'debug'].map((l) => [l, () => {}])) as unknown as Logging;
    const start = (cached: PlatformAccessory[] = []) => {
      const platform = new ExampleHomebridgePlatform(log, { platform: PLATFORM_NAME, name: 'Test' } as PlatformConfig, api as unknown as API);
      cached.forEach((a) => platform.configureAccessory(a));
      api.emit('didFinishLaunching');
      return platform;
    };
    const cachedAccessory = (seed: string, name: string, context: Record<string, unknown> = {}): PlatformAccessory =>
      Object.assign(new hap.Accessory(name, hap.uuid.generate(seed)), { context }) as unknown as PlatformAccessory;
    return { api, calls, start, cachedAccessory };
  }

  test('the example devices are registered: two lights and an Eve air pressure sensor', (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    const { api, calls, start } = homebridge();
    start();
    assert.deepEqual(calls.registered.map((a) => a.displayName), ['Bedroom', 'Kitchen', 'Backyard']);
    const kitchen = calls.registered[1] as unknown as HapNodejs.Accessory;
    assert.ok(kitchen.getService(hap.Service.Lightbulb), 'a light');
    assert.equal(kitchen.getService(hap.Service.AccessoryInformation)?.getCharacteristic(hap.Characteristic.Manufacturer).value, 'Default-Manufacturer');
    const backyard = calls.registered[2] as unknown as HapNodejs.Accessory;
    assert.ok(!backyard.getService(hap.Service.Lightbulb), 'the custom service instead of a light');
    assert.ok(backyard.services.length > 1, 'the Eve service was added');
    api.emit('shutdown');
  });

  test('a cached accessory is restored with its context refreshed; one no longer found is removed', (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    const { api, calls, start, cachedAccessory } = homebridge();
    const bedroom = cachedAccessory('ABCD', 'Bedroom', { device: 'saved by an older version' });
    const gone = cachedAccessory('ZZZZ', 'Old device');
    start([bedroom, gone]);
    assert.deepEqual(calls.registered.map((a) => a.displayName), ['Kitchen', 'Backyard'], 'not registered twice');
    assert.deepEqual(calls.updated, [bedroom]);
    assert.deepEqual(bedroom.context, { device: { exampleUniqueId: 'ABCD', exampleDisplayName: 'Bedroom' } });
    assert.deepEqual(calls.unregistered, [gone]);
    api.emit('shutdown');
  });

  test('the light remembers On and Brightness', async (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    const { api, calls, start } = homebridge();
    start();
    const light = (calls.registered[0] as unknown as HapNodejs.Accessory).getService(hap.Service.Lightbulb)!;
    await light.getCharacteristic(hap.Characteristic.On).handleSetRequest(true);
    assert.equal(await light.getCharacteristic(hap.Characteristic.On).handleGetRequest(), true);
    await light.getCharacteristic(hap.Characteristic.Brightness).handleSetRequest(40);
    assert.equal(light.getCharacteristic(hap.Characteristic.Brightness).value, 40);
    api.emit('shutdown');
  });

  test('the motion sensors take turns every 10 s, and stop at shutdown', (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    const { api, calls, start } = homebridge();
    start();
    const bedroom = calls.registered[0] as unknown as HapNodejs.Accessory;
    const one = bedroom.getService('Motion Sensor One Name')!.getCharacteristic(hap.Characteristic.MotionDetected);
    const two = bedroom.getService('Motion Sensor Two Name')!.getCharacteristic(hap.Characteristic.MotionDetected);
    t.mock.timers.tick(10_000);
    assert.deepEqual([one.value, two.value], [true, false]);
    t.mock.timers.tick(10_000);
    assert.deepEqual([one.value, two.value], [false, true]);
    api.emit('shutdown');
    t.mock.timers.tick(30_000);
    assert.deepEqual([one.value, two.value], [false, true], 'no more updates after shutdown');
  });
}
