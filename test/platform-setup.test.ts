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

  /* ------------------------------------------------------------- renaming */

  const ctx = (a: PlatformAccessory) => a.context as { host?: string; serial?: string; name?: string };

  test('renamed in the config: the same accessory is kept (by address) and its sensors renamed', () => {
    const { calls, lines, start, cachedAccessory } = homebridge();
    const cached = cachedAccessory('Office', '10.0.0.9');
    const first = start([{ name: 'Office', host: '10.0.0.9' }], [cached]);
    const problem = first.printers[0].problem!;
    problem.setCharacteristic(hap!.Characteristic.ConfiguredName, 'Office Problem');
    const toner = first.printers[0].toner!;
    toner.setCharacteristic(hap!.Characteristic.ConfiguredName, 'My cartridge'); // renamed in Home

    const again = homebridge();
    const platform = again.start([{ name: 'Study', host: '10.0.0.9' }], [cached]);
    assert.deepEqual(again.calls.registered, [], 'no new accessory');
    assert.deepEqual(again.calls.unregistered, [], 'the old one is not removed');
    assert.equal(platform.printers[0].accessory, cached);
    assert.equal(ctx(cached).name, 'Study');
    assert.equal(problem.getCharacteristic(hap!.Characteristic.ConfiguredName).value, 'Study Problem');
    assert.equal(toner.getCharacteristic(hap!.Characteristic.ConfiguredName).value, 'My cartridge', 'a name set in Home is kept');
    assert.ok(again.lines.some((l) => l.includes('Renamed from "Office"')), again.lines.join('\n'));
    assert.equal(calls.registered.length + lines.filter((l) => l.startsWith('error')).length, 0);
  });

  test('renamed and moved to a new address: kept by serial number', () => {
    const { calls, start, cachedAccessory } = homebridge();
    const cached = cachedAccessory('Office', '10.0.0.9');
    ctx(cached).serial = 'E12345';
    const platform = start([{ name: 'Study', host: '10.0.0.20', serial: 'E12345' }], [cached]);
    assert.deepEqual(calls.registered, []);
    assert.equal(platform.printers[0].accessory, cached);
    assert.equal(ctx(cached).host, '10.0.0.20');
  });

  test('a different printer at an old address (serials differ) gets its own accessory', () => {
    const { calls, start, cachedAccessory } = homebridge();
    const cached = cachedAccessory('Office', '10.0.0.9');
    ctx(cached).serial = 'E12345';
    start([{ name: 'New one', host: '10.0.0.9', serial: 'F99999' }], [cached]);
    assert.equal(calls.registered.length, 1);
    assert.deepEqual(calls.unregistered, [cached]);
  });

  test('name and address point to different printers: the address wins, and a serial number settles it', () => {
    // Without serials, "Office moved and Study took its address" looks the same as
    // "Office was renamed Study and a new Office added"; printers keep fixed addresses.
    const { calls, start, cachedAccessory } = homebridge();
    const office = cachedAccessory('Office', '10.0.0.9');
    const platform = start([{ name: 'Study', host: '10.0.0.9' }, { name: 'Office', host: '10.0.0.10' }], [office]);
    assert.equal(platform.printers.find((p) => p.name === 'Study')?.accessory, office);
    assert.deepEqual(calls.registered.map((a) => a.displayName), ['Office']);

    const withSerial = homebridge();
    const office2 = withSerial.cachedAccessory('Office', '10.0.0.9');
    ctx(office2).serial = 'E1';
    const p2 = withSerial.start([{ name: 'Study', host: '10.0.0.9' }, { name: 'Office', host: '10.0.0.10', serial: 'E1' }], [office2]);
    assert.equal(p2.printers.find((p) => p.name === 'Office')?.accessory, office2);
  });

  test('two renamed printers don\'t both take the same cached accessory', () => {
    const { calls, start, cachedAccessory } = homebridge();
    const cached = cachedAccessory('Office', '10.0.0.9');
    start([{ name: 'A', host: '10.0.0.9' }, { name: 'B', host: '10.0.0.9' }], [cached]);
    assert.equal(calls.registered.length, 1, 'the second gets a new accessory');
  });

  test('after a rename, a new printer given the old name gets its own accessory', () => {
    const first = homebridge();
    const cached = first.cachedAccessory('Printer', '10.0.0.9');
    first.start([{ name: 'Office', host: '10.0.0.9' }], [cached]); // renamed "Printer" -> "Office"
    assert.equal(ctx(cached).name, 'Office');

    const later = homebridge();
    const platform = later.start([{ name: 'Office', host: '10.0.0.9' }, { name: 'Printer', host: '10.0.0.30' }], [cached]);
    assert.equal(platform.printers.find((p) => p.name === 'Office')?.accessory, cached, 'Office keeps its accessory');
    assert.equal(later.calls.registered.length, 1);
    const added = later.calls.registered[0];
    assert.notEqual(added.UUID, cached.UUID, 'a different UUID, though the name\'s UUID is the old one\'s');
    assert.equal(added.displayName, 'Printer');
    assert.deepEqual(later.calls.unregistered, []);
  });

  test('renamed and a new printer added under the old name at once: the accessory stays at its address', () => {
    const { calls, start, cachedAccessory } = homebridge();
    const cached = cachedAccessory('Printer', '10.0.0.9');
    const platform = start([{ name: 'Office', host: '10.0.0.9' }, { name: 'Printer', host: '10.0.0.30' }], [cached]);
    assert.equal(platform.printers.find((p) => p.name === 'Office')?.accessory, cached);
    assert.deepEqual(calls.registered.map((a) => a.displayName), ['Printer']);
    assert.deepEqual(calls.unregistered, []);
  });

  test('a printer that moved to a new address keeps its accessory by name', () => {
    const { calls, start, cachedAccessory } = homebridge();
    const cached = cachedAccessory('Office', '10.0.0.9');
    const platform = start([{ name: 'Office', host: '10.0.0.44' }], [cached]);
    assert.equal(platform.printers[0].accessory, cached);
    assert.deepEqual(calls.registered, []);
  });

  test('a printer that moved keeps its accessory when a different printer (by serial) takes its old address', () => {
    const { calls, start, cachedAccessory } = homebridge();
    const office = cachedAccessory('Office', '10.0.0.10');
    ctx(office).serial = 'S1';
    const platform = start([{ name: 'Office', host: '10.0.0.20' }, { name: 'Den', host: '10.0.0.10', serial: 'S2' }], [office]);
    assert.equal(platform.printers.find((p) => p.name === 'Office')?.accessory, office);
    assert.deepEqual(calls.unregistered, []);
    assert.deepEqual(calls.registered.map((a) => a.displayName), ['Den']);
  });

  test('a wrong serial number in the settings doesn\'t replace the accessory', () => {
    const { calls, start, cachedAccessory } = homebridge();
    const office = cachedAccessory('Office', '10.0.0.10');
    ctx(office).serial = 'REAL1';
    const platform = start([{ name: 'Office', host: '10.0.0.10', serial: 'TYPO1' }], [office]);
    assert.equal(platform.printers[0].accessory, office);
    assert.deepEqual(calls.registered, []);
    assert.deepEqual(calls.unregistered, []);
  });

  test('a printer Home already has that can\'t be set up shows No Response, and stays', async () => {
    const { calls, lines, start, cachedAccessory } = homebridge();
    const office = cachedAccessory('Office', '10.0.0.10');
    start([{ name: 'Office', host: '10.0.0.10' }], [office]); // set it up once, so it has sensors
    const again = homebridge();
    again.start([{ name: 'Office', host: '10.0.0.10', snmpVersion: '3' }], [office]); // no SNMPv3 user
    assert.ok(again.lines.some((l) => l.startsWith('error: [Office] Couldn\'t set up this printer: SNMPv3 needs a user name')));
    assert.deepEqual(again.calls.unregistered, []);
    const detected = office.getService(hap!.Service.OccupancySensor)!.getCharacteristic(hap!.Characteristic.OccupancyDetected);
    await assert.rejects(Promise.resolve().then(() => detected.handleGetRequest()));
    assert.equal(calls.registered.length + lines.filter((l) => l.startsWith('error')).length, 0);
  });

  test('swapping the names of two printers with serial numbers: each keeps its own accessory', () => {
    const { start, cachedAccessory } = homebridge();
    const a = cachedAccessory('Upstairs', '10.0.0.1');
    const b = cachedAccessory('Downstairs', '10.0.0.2');
    ctx(a).serial = 'SA';
    ctx(b).serial = 'SB';
    const platform = start([
      { name: 'Downstairs', host: '10.0.0.1', serial: 'SA' },
      { name: 'Upstairs', host: '10.0.0.2', serial: 'SB' },
    ], [a, b]);
    assert.equal(platform.printers.find((p) => p.name === 'Downstairs')?.accessory, a);
    assert.equal(platform.printers.find((p) => p.name === 'Upstairs')?.accessory, b);
  });

  test('a name set in the Home app survives a rename, even if it starts with the old name', () => {
    const { start, cachedAccessory } = homebridge();
    const cached = cachedAccessory('Office', '10.0.0.9');
    const first = start([{ name: 'Office', host: '10.0.0.9' }], [cached]);
    const problem = first.printers[0].problem!;
    problem.setCharacteristic(hap!.Characteristic.ConfiguredName, 'Office upstairs');
    homebridge().start([{ name: 'Study', host: '10.0.0.9' }], [cached]);
    assert.equal(problem.getCharacteristic(hap!.Characteristic.ConfiguredName).value, 'Office upstairs');
  });

  test('shutdown stops every printer\'s polling', () => {
    const { api, start } = homebridge();
    const platform = start([{ name: 'A', host: '10.0.0.1' }, { name: 'B', host: '10.0.0.2' }]);
    api.emit('shutdown');
    assert.ok(platform.printers.every((p) => p.stopped));
  });
}
