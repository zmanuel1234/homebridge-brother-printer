import type { API, DynamicPlatformPlugin, Logging, PlatformAccessory, PlatformConfig } from 'homebridge';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings';
import { PrinterAccessory } from './accessory';
import type { PrinterConfig, PrinterContext } from './accessory';

// Resolved from dist/ at runtime, like the published package
// eslint-disable-next-line @typescript-eslint/no-require-imports
const schema = require('../config.schema.json') as {
  schema: { properties: { printers: { items: { properties: Record<string, { default?: unknown }> } } } };
};

const DEFAULTS: Record<string, unknown> = Object.fromEntries(
  Object.entries(schema.schema.properties.printers.items.properties)
    .filter(([, v]) => 'default' in v)
    .map(([k, v]) => [k, v.default]),
);

type PrinterEntry = Partial<PrinterConfig> & Record<string, unknown>;

export class BrotherPrinterPlatform implements DynamicPlatformPlugin {
  readonly log: Logging;
  readonly config: PlatformConfig;
  readonly api: API;
  readonly cached = new Map<string, PlatformAccessory<PrinterContext>>();
  readonly printers: PrinterAccessory[] = [];

  constructor(log: Logging, config: PlatformConfig | undefined, api: API) {
    this.log = log;
    this.config = config || ({} as PlatformConfig);
    this.api = api;

    this.api.on('didFinishLaunching', () => {
      try {
        this.setup();
      } catch (err) {
        const e = err as { stack?: string } | null;
        this.log.error(`Setup failed: ${e?.stack || err}`);
      }
    });
    this.api.on('shutdown', () => this.printers.forEach((p) => p.stop()));
  }

  configureAccessory(accessory: PlatformAccessory): void {
    this.cached.set(accessory.UUID, accessory as PlatformAccessory<PrinterContext>);
  }

  setup(): void {
    const entries: (PrinterEntry | null | undefined)[] = Array.isArray(this.config.printers) ? this.config.printers : [];
    const active = new Set<string>();

    entries.forEach((rawEntry, idx) => {
      if (!rawEntry || !String(rawEntry.host || '').trim()) {
        // The settings screen can save a blank row; only warn when it was filled in
        const filled = !!rawEntry && Object.entries(rawEntry).some(([k, v]) => k !== 'host' && v !== DEFAULTS[k] && v !== '');
        const msg = `Printer #${idx + 1} has no host set, skipping it.`;
        if (filled) { this.log.warn(msg); } else { this.log.debug(msg); }
        return;
      }
      const host = String(rawEntry.host).trim();
      const name = String(rawEntry.name || 'Printer').trim();
      const uuid = this.api.hap.uuid.generate(`${PLUGIN_NAME}:${name}`);
      if (active.has(uuid)) {
        this.log.warn(`Two printers are named "${name}". Give each a unique name; skipping the second.`);
        return;
      }
      active.add(uuid);

      let accessory = this.cached.get(uuid);
      const isNew = !accessory;
      if (!accessory) {
        accessory = new this.api.platformAccessory<PrinterContext>(name, uuid, this.api.hap.Categories.SENSOR);
      }
      accessory.context.host = host;

      try {
        this.printers.push(new PrinterAccessory(this, accessory, { ...rawEntry, host, name }));
      } catch (err) {
        const e = err as { message?: string } | null;
        this.log.error(`[${name}] Couldn't set up this printer: ${e?.message || err}`);
        return;
      }

      if (isNew) {
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        this.log.info(`Added printer "${name}" (${host}).`);
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
