'use strict';

const { query } = require('./snmp');
const { version } = require('../package.json');

const PAGES_UUID = 'B0E5A1C2-7D3E-4F1A-9C6B-2E8D4F7A1B30';
let PagesPrinted;

function pagesCharacteristic(hap) {
  if (PagesPrinted) { return PagesPrinted; }
  const { Characteristic, Formats, Perms } = hap;
  PagesPrinted = class extends Characteristic {
    constructor() {
      super('Pages Printed', PAGES_UUID, {
        format: Formats.UINT32,
        perms: [Perms.PAIRED_READ, Perms.NOTIFY],
        minValue: 0,
        maxValue: 4294967295,
        minStep: 1,
      });
      this.value = this.getDefaultValue();
    }
  };
  PagesPrinted.UUID = PAGES_UUID;
  return PagesPrinted;
}

const clamp = (v) => Math.max(0, Math.min(100, Math.round(v)));
/** A whole number setting; anything that isn't a number gets the default */
const setting = (v, def, min, max) => {
  const n = typeof v === 'string' && v.trim() === '' ? NaN : Number(v ?? def);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.round(n))) : def;
};
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const TILE_SUBTYPE = { black: 'tonerTile', cyan: 'tile-cyan', magenta: 'tile-magenta', yellow: 'tile-yellow' };
const FAULT_NAMES = {
  noPaper: 'out of paper', noToner: 'toner or ink empty', doorOpen: 'cover open', jammed: 'paper jam',
  serviceRequested: 'service requested', inputTrayMissing: 'tray missing', outputTrayMissing: 'output tray missing',
  markerSupplyMissing: 'cartridge missing', outputFull: 'output tray full',
};
const PART_NAMES = {
  belt: 'Belt unit', fuser: 'Fuser unit', laser: 'Laser unit',
  paperFeed1: 'Paper feed kit (tray 1)', paperFeedMP: 'Paper feed kit (MP tray)', inkWasteBox: 'Ink waste box',
};

class PrinterAccessory {
  constructor(platform, accessory, config) {
    this.platform = platform;
    this.log = platform.log;
    this.api = platform.api;
    this.hap = platform.api.hap;
    this.accessory = accessory;
    this.name = config.name;

    this.options = {
      host: config.host,
      port: setting(config.port, 161, 1, 65535),
      community: config.community || 'public',
      timeout: 5000,
      retries: 1,
      version: ['1', '2c'].includes(String(config.snmpVersion)) ? String(config.snmpVersion) : 'auto',
      state: {},
    };
    this.interval = setting(config.pollInterval, 60, 10, 3600) * 1000;
    this.lowToner = setting(config.lowTonerThreshold, 10, 0, 100);
    this.lowDrum = setting(config.lowDrumThreshold, 10, 0, 100);
    this.showDrum = config.showDrum === true;
    this.tonerTile = config.tonerTile === true;
    this.faultSensor = config.faultSensor !== false;
    this.lowTonerSensor = config.lowTonerSensor === true;
    this.offlineAfter = setting(config.offlineAfter, 3, 1, 20);
    this.debug = config.debug === true;

    this.failures = 0;
    this.online = true;
    this.last = {};
    this.timer = null;
    this.stopped = false;
    this.tiles = {};
    this.guarded = [];

    this.buildServices();
    this.guardReads();
    this.poll();
  }

  /* ------------------------------------------------------------ services */

  buildServices() {
    const { Service, Characteristic: C } = this.hap;
    const acc = this.accessory;

    acc.getService(Service.AccessoryInformation)
      .setCharacteristic(C.Manufacturer, 'Brother')
      .setCharacteristic(C.Model, acc.context.model || 'Brother printer')
      .setCharacteristic(C.SerialNumber, acc.context.serial || this.options.host)
      .setCharacteristic(C.FirmwareRevision, version);

    // Printing state: the tile people see in the Home app
    this.occupancy = acc.getService(Service.OccupancySensor)
      || acc.addService(Service.OccupancySensor, this.name);
    this.label(this.occupancy, this.name);
    this.occupancy.setPrimaryService(true);
    for (const ch of [C.StatusActive, C.StatusFault]) {
      if (!this.occupancy.testCharacteristic(ch)) { this.occupancy.addOptionalCharacteristic(ch); }
      this.occupancy.getCharacteristic(ch);
    }
    this.occupancy.getCharacteristic(C.StatusActive).updateValue(true);
    const Pages = pagesCharacteristic(this.hap);
    if (!this.occupancy.testCharacteristic(Pages)) { this.occupancy.addCharacteristic(Pages); }
    this.pages = this.occupancy.getCharacteristic(Pages);

    // Toner and drum as batteries so Home raises native "low" alerts. A printer
    // that reported no levels last time gets none until it reports some.
    if (acc.context.noLevels) {
      this.removeSubtype(Service.Battery, 'toner');
      this.toner = null;
    } else {
      this.toner = this.battery('toner', `${this.name} ${acc.context.kind || 'Toner'}`);
      this.occupancy.addLinkedService(this.toner);
    }

    if (this.showDrum) {
      this.drum = this.battery('drum', `${this.name} Drum`);
      this.occupancy.addLinkedService(this.drum);
    } else {
      this.removeSubtype(Service.Battery, 'drum');
    }

    // Home doesn't surface StatusFault on occupancy sensors, so problems
    // (jam, cover open, no paper...) also open a contact sensor.
    if (this.faultSensor) {
      this.problem = acc.getServiceById(Service.ContactSensor, 'problem')
        || acc.addService(Service.ContactSensor, `${this.name} Problem`, 'problem');
      this.label(this.problem, `${this.name} Problem`);
      if (!this.problem.testCharacteristic(C.StatusActive)) { this.problem.addOptionalCharacteristic(C.StatusActive); }
      this.problem.getCharacteristic(C.StatusActive).updateValue(true);
      this.occupancy.addLinkedService(this.problem);
    } else {
      this.removeSubtype(Service.ContactSensor, 'problem');
    }

    // The low toner sensor is created once the printer says toner or ink;
    // here only one restored from the cache is picked up.
    const lowSvc = acc.getServiceById(Service.ContactSensor, 'lowToner');
    if (lowSvc && this.lowTonerSensor) { this.lowSensor = lowSvc; } else if (lowSvc) { acc.removeService(lowSvc); }

    // Supply tiles are created once the printer says which colors it has;
    // here only the ones restored from the cache are picked up.
    for (const [color, subtype] of Object.entries(TILE_SUBTYPE)) {
      const svc = acc.getServiceById(Service.HumiditySensor, subtype);
      if (!svc) { continue; }
      if (this.tonerTile) { this.tiles[color] = svc; } else { acc.removeService(svc); }
    }
  }

  /** Make one tile per reported supply; remove tiles for colors not reported */
  ensureTiles(d) {
    if (!this.tonerTile) { return; }
    const { Service, Characteristic: C } = this.hap;
    const colors = new Set(d.supplies.map((s) => s.color));
    const mono = d.supplies.length === 1;
    const kind = d.type === 'ink' ? 'Ink' : 'Toner';

    for (const [color, subtype] of Object.entries(TILE_SUBTYPE)) {
      if (!colors.has(color)) {
        if (this.tiles[color]) {
          this.accessory.removeService(this.tiles[color]);
          delete this.tiles[color];
        }
        continue;
      }
      if (this.tiles[color]) { continue; }
      const name = mono ? `${this.name} ${kind}` : `${this.name} ${cap(color)}`;
      const svc = this.accessory.addService(Service.HumiditySensor, name, subtype);
      this.label(svc, name);
      if (!svc.testCharacteristic(C.StatusActive)) { svc.addOptionalCharacteristic(C.StatusActive); }
      svc.getCharacteristic(C.StatusActive).updateValue(true);
      this.guard(svc.getCharacteristic(C.CurrentRelativeHumidity));
      this.tiles[color] = svc;
    }
  }

  /**
   * Low toner as a contact sensor that opens when any supply is low. Home words
   * a low battery as "battery is low"; this gives a notification with its own
   * name, e.g. "Printer Toner Low opened".
   */
  ensureLowSensor(kind) {
    if (!this.lowTonerSensor || this.lowSensor) { return; }
    const { Service, Characteristic: C } = this.hap;
    const name = `${this.name} ${kind} Low`;
    const svc = this.accessory.addService(Service.ContactSensor, name, 'lowToner');
    this.label(svc, name);
    if (!svc.testCharacteristic(C.StatusActive)) { svc.addOptionalCharacteristic(C.StatusActive); }
    svc.getCharacteristic(C.StatusActive).updateValue(true);
    this.occupancy.addLinkedService(svc);
    this.guard(svc.getCharacteristic(C.ContactSensorState));
    this.lowSensor = svc;
  }

  removeLowSensor() {
    if (!this.lowSensor) { return; }
    this.guarded = this.guarded.filter((ch) => !this.lowSensor.characteristics.includes(ch));
    this.accessory.removeService(this.lowSensor);
    this.lowSensor = null;
  }

  /**
   * Home ignores StatusActive on sensors. It shows "No Response" only when a
   * read fails, so while the printer is offline the state reads fail too.
   */
  guardReads() {
    const C = this.hap.Characteristic;
    const pairs = [
      [this.occupancy, C.OccupancyDetected],
      [this.occupancy, C.StatusFault],
      [this.toner, C.BatteryLevel],
      [this.toner, C.StatusLowBattery],
      [this.drum, C.BatteryLevel],
      [this.drum, C.StatusLowBattery],
      [this.problem, C.ContactSensorState],
      [this.lowSensor, C.ContactSensorState],
      ...Object.values(this.tiles).map((svc) => [svc, C.CurrentRelativeHumidity]),
    ];
    for (const [svc, type] of pairs) {
      if (svc) { this.guard(svc.getCharacteristic(type)); }
    }
  }

  guard(ch) {
    if (this.guarded.includes(ch)) { return; }
    this.guarded.push(ch);
    ch.onGet(() => {
      if (!this.online) { throw this.noResponse(); }
      return ch.value;
    });
  }

  noResponse() {
    const { HapStatusError, HAPStatus } = this.hap;
    return new HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
  }

  battery(subtype, name) {
    const { Service, Characteristic: C } = this.hap;
    const svc = this.accessory.getServiceById(Service.Battery, subtype)
      || this.accessory.addService(Service.Battery, name, subtype);
    this.label(svc, name);
    svc.setCharacteristic(C.ChargingState, C.ChargingState.NOT_CHARGEABLE);
    return svc;
  }

  label(svc, name) {
    const C = this.hap.Characteristic;
    svc.setCharacteristic(C.Name, name);
    if (!svc.testCharacteristic(C.ConfiguredName)) { svc.addOptionalCharacteristic(C.ConfiguredName); }
    // Only seed the name; don't overwrite a name the user set in the Home app
    const current = svc.getCharacteristic(C.ConfiguredName).value;
    if (!current) { svc.setCharacteristic(C.ConfiguredName, name); }
  }

  removeSubtype(type, subtype) {
    const svc = this.accessory.getServiceById(type, subtype);
    if (svc) { this.accessory.removeService(svc); }
  }

  /* ------------------------------------------------------------- polling */

  async poll() {
    if (this.stopped) { return; }
    let data;
    try {
      data = await query(this.options);
    } catch (err) {
      this.failures += 1;
      const msg = err && err.message ? err.message : String(err);
      if (this.failures === this.offlineAfter) {
        this.log.warn(`[${this.name}] Can't reach ${this.options.host} (${msg}). Showing it as offline.`);
        this.setOnline(false);
      } else if (this.debug || this.failures < this.offlineAfter) {
        this.log.debug(`[${this.name}] Poll failed (${this.failures}/${this.offlineAfter}): ${msg}`);
      }
    }
    if (data) {
      this.failures = 0;
      try {
        this.apply(data);
      } catch (err) {
        this.log.error(`[${this.name}] Couldn't update HomeKit: ${err && err.stack ? err.stack : err}`);
      }
    }
    if (!this.stopped) { this.timer = setTimeout(() => this.poll(), this.interval); }
  }

  stop() {
    this.stopped = true;
    if (this.timer) { clearTimeout(this.timer); }
  }

  setOnline(online) {
    const C = this.hap.Characteristic;
    const wasOnline = this.online;
    if (online && !wasOnline) {this.log.info(`[${this.name}] Back online.`);}
    this.online = online;
    if (online && !wasOnline) {
      for (const ch of this.guarded) { ch.updateValue(ch.value); }
    }
    this.occupancy.updateCharacteristic(C.StatusActive, online);
    for (const svc of Object.values(this.tiles)) { svc.updateCharacteristic(C.StatusActive, online); }
    if (this.problem) { this.problem.updateCharacteristic(C.StatusActive, online); }
    if (this.lowSensor) { this.lowSensor.updateCharacteristic(C.StatusActive, online); }
    if (!online) {
      this.occupancy.updateCharacteristic(C.OccupancyDetected, 0);
      // Push the failure so Home shows "No Response" without waiting for a read
      for (const ch of this.guarded) { ch.updateValue(this.noResponse()); }
    }
  }

  apply(d) {
    const C = this.hap.Characteristic;
    const log = (m) => (this.debug ? this.log.info(m) : this.log.debug(m));

    log(`[${this.name}] ${JSON.stringify(d)}`);
    this.setOnline(true);
    this.updateInfo(d);

    // Printing / fault
    this.occupancy.updateCharacteristic(C.OccupancyDetected, d.printing
      ? C.OccupancyDetected.OCCUPANCY_DETECTED
      : C.OccupancyDetected.OCCUPANCY_NOT_DETECTED);
    this.occupancy.updateCharacteristic(C.StatusFault, d.fault
      ? C.StatusFault.GENERAL_FAULT
      : C.StatusFault.NO_FAULT);

    if (this.problem) {
      this.problem.updateCharacteristic(C.ContactSensorState, d.fault
        ? C.ContactSensorState.CONTACT_NOT_DETECTED
        : C.ContactSensorState.CONTACT_DETECTED);
    }
    if (d.fault && !this.last.fault) {
      const what = d.faults.map((f) => FAULT_NAMES[f] || f).join(', ');
      const shown = d.statusText ? `display: "${d.statusText}"` : '';
      this.log.warn(`[${this.name}] Problem: ${[what, shown].filter(Boolean).join('; ')}`);
    } else if (!d.fault && this.last.fault) {
      this.log.info(`[${this.name}] Problem cleared.`);
    }
    this.last.fault = d.fault;

    if (d.statusText && d.statusText !== this.last.statusText) {
      this.log.info(`[${this.name}] Status: ${d.statusText}`);
    }

    this.applySupplies(d);
    this.applyDrumAndParts(d);

    if (d.totalPages !== null) { this.pages.updateValue(d.totalPages); }
    this.last.statusText = d.statusText;

    if (this.last.summary === undefined) {
      const kind = d.type === 'ink' ? 'ink' : 'toner';
      const levels = d.supplies.length
        ? d.supplies.map((s) => (d.supplies.length === 1 ? `${kind} ${s.level}%` : `${s.color} ${s.level}%`)).join(', ')
        : `no ${kind} levels reported`;
      const drum = d.drumPercent !== null ? `, drum ${d.drumPercent}%` : '';
      this.log.info(`[${this.name}] Connected to ${d.model || 'printer'} (SNMP v${d.snmpVersion}): ${levels}${drum}, `
        + `${d.totalPages ?? '?'} pages, status "${d.statusText || 'unknown'}".`);
      this.last.summary = true;
    }
  }

  /**
   * Toner/ink battery: the lowest supply, so Home alerts when any color runs
   * low. A supply counts as low when its level or its finer reading is at or
   * below the threshold, or the printer itself flags low/no toner.
   */
  applySupplies(d) {
    const C = this.hap.Characteristic;
    const kind = d.type === 'ink' ? 'Ink' : 'Toner';

    if (!d.supplies.length) {
      // Some models (e.g. ink tank printers) report no levels at all
      this.remember({ noLevels: true });
      if (this.toner) {
        this.log.info(`[${this.name}] This printer doesn't report ${kind.toLowerCase()} levels; `
          + 'leaving out the battery.');
        this.accessory.removeService(this.toner);
        this.guarded = this.guarded.filter((ch) => !this.toner.characteristics.includes(ch));
        this.toner = null;
      }
      this.removeLowSensor();
      return;
    }
    if (!this.toner) {
      this.toner = this.battery('toner', `${this.name} ${kind}`);
      this.occupancy.addLinkedService(this.toner);
      this.guard(this.toner.getCharacteristic(C.BatteryLevel));
      this.guard(this.toner.getCharacteristic(C.StatusLowBattery));
    }
    this.renameBattery(kind);
    this.remember({ noLevels: false, kind });

    const flagged = d.errors.includes('lowToner') || d.errors.includes('noToner');
    const isLow = (s) => s.level <= this.lowToner || (s.fine !== null && s.fine <= this.lowToner);
    const low = d.supplies.filter(isLow);
    const lowest = d.lowestSupply;
    const level = clamp(lowest.level);

    this.toner.updateCharacteristic(C.BatteryLevel, level);
    this.toner.updateCharacteristic(C.StatusLowBattery, low.length || flagged
      ? C.StatusLowBattery.BATTERY_LEVEL_LOW
      : C.StatusLowBattery.BATTERY_LEVEL_NORMAL);

    this.ensureLowSensor(kind);
    if (this.lowSensor) {
      this.lowSensor.updateCharacteristic(C.ContactSensorState, low.length || flagged
        ? C.ContactSensorState.CONTACT_NOT_DETECTED
        : C.ContactSensorState.CONTACT_DETECTED);
    }

    this.ensureTiles(d);
    for (const s of d.supplies) {
      if (this.tiles[s.color]) { this.tiles[s.color].updateCharacteristic(C.CurrentRelativeHumidity, clamp(s.level)); }
    }

    const mono = d.supplies.length === 1;
    const label = (s) => (mono ? kind : `${cap(s.color)} ${kind.toLowerCase()}`);
    const prev = this.last.supplies || {};
    for (const s of d.supplies) {
      const was = prev[s.color];
      if (was && was.level !== s.level) { this.log.info(`[${this.name}] ${label(s)} ${s.level}%`); }
      if (isLow(s) && !(was && was.low)) {
        const fine = s.fine !== null && s.fine !== s.level ? ` (${s.fine}% by the finer reading)` : '';
        this.log.warn(`[${this.name}] ${label(s)} is low: ${s.level}%${fine}.`);
      }
    }
    this.last.supplies = Object.fromEntries(d.supplies.map((s) => [s.color, { level: s.level, low: isLow(s) }]));
  }

  /** Drum battery (optional) and log warnings for drums and other parts */
  applyDrumAndParts(d) {
    const drums = Object.entries(d.drums).filter(([, v]) => typeof v.percent === 'number');
    if (drums.length) {
      const [color, lowest] = drums.reduce((a, b) => (b[1].percent < a[1].percent ? b : a));
      const level = clamp(lowest.percent);
      if (this.drum) { this.setBattery(this.drum, level, this.lowDrum); }
      const name = drums.length > 1 ? `${cap(color)} drum` : 'Drum';
      this.warnOnce('drum', level <= this.lowDrum,
        `${name} is near end of life (${level}%, ${lowest.pagesRemaining ?? '?'} pages left).`);
    }
    for (const [key, part] of Object.entries(d.parts)) {
      if (typeof part.percent !== 'number' || !PART_NAMES[key]) { continue; }
      const left = part.pagesRemaining !== undefined ? `, ${part.pagesRemaining} pages left` : '';
      this.warnOnce(`part-${key}`, part.percent <= this.lowDrum,
        `${PART_NAMES[key]} is near end of life (${part.percent}%${left}).`);
    }
  }

  warnOnce(key, condition, message) {
    this.last.warned = this.last.warned || {};
    if (condition && !this.last.warned[key]) { this.log.warn(`[${this.name}] ${message}`); }
    this.last.warned[key] = condition;
  }

  /**
   * The battery is made before the first poll says toner or ink, so on an
   * inkjet it starts as "Toner". Rename it, unless the user renamed it in Home.
   */
  renameBattery(kind) {
    const C = this.hap.Characteristic;
    const was = this.accessory.context.kind || 'Toner';
    if (was === kind) { return; }
    const name = `${this.name} ${kind}`;
    this.toner.setCharacteristic(C.Name, name);
    const current = this.toner.getCharacteristic(C.ConfiguredName).value;
    if (!current || current === `${this.name} ${was}`) { this.toner.setCharacteristic(C.ConfiguredName, name); }
  }

  /** Store values in the accessory cache, saving only when something changed */
  remember(values) {
    const ctx = this.accessory.context;
    const changed = Object.entries(values).filter(([k, v]) => ctx[k] !== v);
    if (!changed.length) { return; }
    for (const [k, v] of changed) { ctx[k] = v; }
    this.api.updatePlatformAccessories([this.accessory]);
  }

  setBattery(svc, level, threshold) {
    const C = this.hap.Characteristic;
    svc.updateCharacteristic(C.BatteryLevel, level);
    svc.updateCharacteristic(C.StatusLowBattery, level <= threshold
      ? C.StatusLowBattery.BATTERY_LEVEL_LOW
      : C.StatusLowBattery.BATTERY_LEVEL_NORMAL);
  }

  updateInfo(d) {
    const { Service, Characteristic: C } = this.hap;
    const ctx = this.accessory.context;
    let changed = false;
    const model = d.model ? d.model.replace(/^Brother\s+/i, '') : null;
    if (model && model !== ctx.model) { ctx.model = model; changed = true; }
    if (d.serial && d.serial !== ctx.serial) { ctx.serial = d.serial; changed = true; }
    if (!changed) { return; }
    this.accessory.getService(Service.AccessoryInformation)
      .updateCharacteristic(C.Model, ctx.model || 'Brother printer')
      .updateCharacteristic(C.SerialNumber, ctx.serial || this.options.host);
    this.api.updatePlatformAccessories([this.accessory]);
  }
}

module.exports = { PrinterAccessory };
