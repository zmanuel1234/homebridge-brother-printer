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
        this.log.error(`Setup failed: ${e?.stack || String(err)}`);
      }
    });
    this.api.on('shutdown', () => this.printers.forEach((p) => p.stop()));
  }

  configureAccessory(accessory: PlatformAccessory): void {
    this.cached.set(accessory.UUID, accessory as PlatformAccessory<PrinterContext>);
  }

  setup(): void {
    // Homebridge types the config as any: a list of entries, each checked below
    const printers: unknown = this.config.printers;
    const raw = Array.isArray(printers) ? (printers as (PrinterEntry | null | undefined)[]) : [];

    interface Entry { raw: PrinterEntry; name: string; host: string; serial: string }
    const entries: Entry[] = [];
    const names = new Set<string>();
    raw.forEach((rawEntry, idx) => {
      if (!rawEntry || !String(rawEntry.host || '').trim()) {
        // The settings screen can save a blank row; only warn when it was filled in
        const filled = !!rawEntry && Object.entries(rawEntry).some(([k, v]) => k !== 'host' && v !== DEFAULTS[k] && v !== '');
        const msg = `Printer #${idx + 1} has no host set, skipping it.`;
        if (filled) { this.log.warn(msg); } else { this.log.debug(msg); }
        return;
      }
      const name = String(rawEntry.name || 'Printer').trim();
      if (names.has(name)) {
        this.log.warn(`Two printers are named "${name}". Give each a unique name; skipping the second.`);
        return;
      }
      names.add(name);
      entries.push({ raw: rawEntry, name, host: String(rawEntry.host).trim(), serial: String(rawEntry.serial ?? '').trim() });
    });

    // Which cached accessory is which printer. An accessory keeps the UUID it was
    // made with, so after a rename its UUID no longer says its name; what it was
    // last set up as is in its context. In order of trust: the same serial
    // number, the same name, the same address. A name or address match doesn't
    // count when both serial numbers are known and differ.
    const ctxName = (a: PlatformAccessory<PrinterContext>): string => a.context.name ?? a.displayName;
    const agrees = (e: Entry, a: PlatformAccessory<PrinterContext>): boolean =>
      !(e.serial && a.context.serial && a.context.serial !== e.serial);
    const match = new Map<Entry, PlatformAccessory<PrinterContext>>();
    const taken = new Set<string>();
    const pass = (test: (e: Entry, a: PlatformAccessory<PrinterContext>) => boolean): void => {
      for (const e of entries) {
        if (match.has(e)) { continue; }
        const a = [...this.cached.values()].find((c) => !taken.has(c.UUID) && test(e, c));
        if (a) { match.set(e, a); taken.add(a.UUID); }
      }
    };
    pass((e, a) => !!e.serial && a.context.serial === e.serial);
    pass((e, a) => ctxName(a) === e.name && agrees(e, a));
    pass((e, a) => a.context.host === e.host && agrees(e, a));

    const active = new Set<string>();
    for (const e of entries) {
      let accessory = match.get(e);
      const isNew = !accessory;
      if (!accessory) {
        // The UUID from the name, unless a cached accessory (a renamed printer) already has it
        let uuid = this.api.hap.uuid.generate(`${PLUGIN_NAME}:${e.name}`);
        for (let n = 2; this.cached.has(uuid) || active.has(uuid); n++) {
          uuid = this.api.hap.uuid.generate(`${PLUGIN_NAME}:${e.name}:${n}`);
        }
        accessory = new this.api.platformAccessory<PrinterContext>(e.name, uuid, this.api.hap.Categories.SENSOR);
      }
      active.add(accessory.UUID);
      accessory.context.host = e.host;

      try {
        this.printers.push(new PrinterAccessory(this, accessory, { ...e.raw, host: e.host, name: e.name }));
      } catch (err) {
        const msg = (err as { message?: string } | null)?.message || String(err);
        this.log.error(`[${e.name}] Couldn't set up this printer: ${msg}`);
        continue;
      }

      if (isNew) {
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        this.log.info(`Added printer "${e.name}" (${e.host}).`);
      } else {
        this.api.updatePlatformAccessories([accessory]);
      }
    }

    const stale = [...this.cached.values()].filter((a) => !active.has(a.UUID));
    if (stale.length) {
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, stale);
      stale.forEach((a) => this.log.info(`Removed printer "${a.displayName}", no longer in config.`));
    }
  }
}
