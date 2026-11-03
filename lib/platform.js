'use strict';

const { PLATFORM_NAME, PLUGIN_NAME } = require('./settings');
const { PrinterAccessory } = require('./accessory');
const schema = require('../config.schema.json');

const DEFAULTS = Object.fromEntries(
  Object.entries(schema.schema.properties.printers.items.properties)
    .filter(([, v]) => 'default' in v)
    .map(([k, v]) => [k, v.default]),
);

class BrotherPrinterPlatform {
  constructor(log, config, api) {
    this.log = log;
    this.config = config || {};
    this.api = api;
    this.cached = new Map();
    this.printers = [];

    this.api.on('didFinishLaunching', () => {
      try {
        this.setup();
      } catch (err) {
        this.log.error(`Setup failed: ${err && err.stack ? err.stack : err}`);
      }
    });
    this.api.on('shutdown', () => this.printers.forEach((p) => p.stop()));
  }

  configureAccessory(accessory) {
    this.cached.set(accessory.UUID, accessory);
  }

  setup() {
    const entries = Array.isArray(this.config.printers) ? this.config.printers : [];
    const active = new Set();

    entries.forEach((rawEntry, idx) => {
      let entry = rawEntry;
      if (!entry || !String(entry.host || '').trim()) {
        // The settings screen can save a blank row; only warn when it was filled in
        const filled = entry && Object.entries(entry).some(([k, v]) => k !== 'host' && v !== DEFAULTS[k] && v !== '');
        const msg = `Printer #${idx + 1} has no host set, skipping it.`;
        if (filled) { this.log.warn(msg); } else { this.log.debug(msg); }
        return;
      }
      entry = { ...entry, host: String(entry.host).trim() };
      const name = String(entry.name || 'Printer').trim();
      const uuid = this.api.hap.uuid.generate(`${PLUGIN_NAME}:${name}`);
      if (active.has(uuid)) {
        this.log.warn(`Two printers are named "${name}". Give each a unique name; skipping the second.`);
        return;
      }
      active.add(uuid);

      let accessory = this.cached.get(uuid);
      const isNew = !accessory;
      if (isNew) {
        accessory = new this.api.platformAccessory(name, uuid, this.api.hap.Categories.SENSOR);
      }
      accessory.context.host = entry.host;

      try {
        this.printers.push(new PrinterAccessory(this, accessory, { ...entry, name }));
      } catch (err) {
        this.log.error(`[${name}] Couldn't set up this printer: ${err && err.message ? err.message : err}`);
        return;
      }

      if (isNew) {
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        this.log.info(`Added printer "${name}" (${entry.host}).`);
      } else {
        this.api.updatePlatformAccessories([accessory]);
      }
    });

    const stale = [...this.cached.values()].filter((a) => !active.has(a.UUID));
    if (stale.length) {
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, stale);
      stale.forEach((a) => this.log.info(`Removed printer "${a.displayName}", no longer in config.`));
    }
  }
}

module.exports = { BrotherPrinterPlatform };
