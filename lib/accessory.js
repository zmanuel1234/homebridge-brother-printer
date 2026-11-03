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
      port: Number(config.port) || 161,
      community: config.community || 'public',
      timeout: 5000,
      retries: 1,
    };
    this.interval = Math.max(10, Number(config.pollInterval) || 60) * 1000;
    this.lowToner = clamp(config.lowTonerThreshold ?? 10);
    this.lowDrum = clamp(config.lowDrumThreshold ?? 10);
    this.showDrum = config.showDrum === true;
    this.tonerTile = config.tonerTile === true;
    this.faultSensor = config.faultSensor !== false;
    this.offlineAfter = Math.max(1, Number(config.offlineAfter) || 3);
    this.debug = config.debug === true;

    this.failures = 0;
    this.online = true;
    this.last = {};
    this.timer = null;
    this.stopped = false;

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

    // Toner and drum as batteries so Home raises native "low" alerts
    this.toner = this.battery('toner', `${this.name} Toner`);
    this.occupancy.addLinkedService(this.toner);

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

    if (this.tonerTile) {
      this.tile = acc.getServiceById(Service.HumiditySensor, 'tonerTile')
        || acc.addService(Service.HumiditySensor, `${this.name} Toner`, 'tonerTile');
      this.label(this.tile, `${this.name} Toner`);
      if (!this.tile.testCharacteristic(C.StatusActive)) { this.tile.addOptionalCharacteristic(C.StatusActive); }
      this.tile.getCharacteristic(C.StatusActive);
    } else {
      this.removeSubtype(Service.HumiditySensor, 'tonerTile');
    }
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
      [this.tile, C.CurrentRelativeHumidity],
    ];
    this.guarded = pairs.filter(([svc]) => svc).map(([svc, type]) => svc.getCharacteristic(type));
    for (const ch of this.guarded) {
      ch.onGet(() => {
        if (!this.online) { throw this.noResponse(); }
        return ch.value;
      });
    }
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
    if (this.tile) { this.tile.updateCharacteristic(C.StatusActive, online); }
    if (this.problem) { this.problem.updateCharacteristic(C.StatusActive, online); }
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
      this.log.warn(`[${this.name}] Problem: ${d.statusText || d.faults.join(', ')}`);
    } else if (!d.fault && this.last.fault) {
      this.log.info(`[${this.name}] Problem cleared.`);
    }
    this.last.fault = d.fault;

    if (d.statusText && d.statusText !== this.last.statusText) {
      this.log.info(`[${this.name}] Status: ${d.statusText}`);
    }

    // Toner
    if (d.tonerPercent !== null) {
      const level = clamp(d.tonerPercent);
      this.setBattery(this.toner, level, this.lowToner);
      if (this.tile) { this.tile.updateCharacteristic(C.CurrentRelativeHumidity, level); }
      if (level !== this.last.toner) {
        if (this.last.toner !== undefined || this.debug) {this.log.info(`[${this.name}] Toner ${level}%`);}
        if (level <= this.lowToner && (this.last.toner === undefined || this.last.toner > this.lowToner)) {
          this.log.warn(`[${this.name}] Toner is low (${level}%).`);
        }
      }
      this.last.toner = level;
    }

    // Drum
    if (d.drumPercent !== null) {
      const level = clamp(d.drumPercent);
      if (this.drum) { this.setBattery(this.drum, level, this.lowDrum); }
      if (level <= this.lowDrum && (this.last.drum === undefined || this.last.drum > this.lowDrum)) {
        this.log.warn(`[${this.name}] Drum is near end of life (${level}%, ${d.drumPagesRemaining ?? '?'} pages left).`);
      }
      this.last.drum = level;
    }

    if (d.totalPages !== null) { this.pages.updateValue(d.totalPages); }
    this.last.statusText = d.statusText;

    if (this.last.summary === undefined) {
      this.log.info(`[${this.name}] Connected to ${d.model || 'printer'}: toner ${d.tonerPercent ?? '?'}%, `
        + `drum ${d.drumPercent ?? '?'}%, ${d.totalPages ?? '?'} pages, status "${d.statusText || 'unknown'}".`);
      this.last.summary = true;
    }
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
