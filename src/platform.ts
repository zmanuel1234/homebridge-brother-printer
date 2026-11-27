import type { API, DynamicPlatformPlugin, Logging, PlatformAccessory, PlatformConfig } from 'homebridge';
import { ExampleSwitch } from './accessory';
import { PLATFORM_NAME, PLUGIN_NAME, readSettings, type Settings } from './settings';

/**
 * A dynamic platform: Homebridge hands back the accessories it cached at the last start
 * (configureAccessory), then the platform adds what's new and removes what's gone once
 * Homebridge has finished launching.
 */
export class ExamplePlatform implements DynamicPlatformPlugin {
  readonly settings: Settings;
  /** The accessories Homebridge restored from its cache, by UUID. */
  private readonly cached = new Map<string, PlatformAccessory>();
  readonly switches: ExampleSwitch[] = [];

  constructor(
    readonly log: Logging,
    config: PlatformConfig,
    readonly api: API,
  ) {
    this.settings = readSettings(config);
    api.on('didFinishLaunching', () => this.setUp());
    api.on('shutdown', () => this.switches.forEach((s) => s.stop()));
  }

  configureAccessory(accessory: PlatformAccessory): void {
    this.cached.set(accessory.UUID, accessory);
  }

  setUp(): void {
    const uuid = this.api.hap.uuid.generate(`${PLUGIN_NAME}:switch`);
    let accessory = this.cached.get(uuid);
    if (accessory) {
      accessory.displayName = this.settings.switchName;
      this.api.updatePlatformAccessories([accessory]);
    } else {
      accessory = new this.api.platformAccessory(this.settings.switchName, uuid);
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      this.log.info(`Added "${this.settings.switchName}".`);
    }
    this.switches.push(new ExampleSwitch(this, accessory));

    // Accessories from an earlier version or setup that this one no longer has.
    const stale = [...this.cached.values()].filter((a) => a.UUID !== uuid);
    if (stale.length > 0) {
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, stale);
      this.log.info(`Removed ${stale.length} accessory(ies) no longer in use.`);
    }
  }
}
