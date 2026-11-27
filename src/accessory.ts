import type { CharacteristicValue, PlatformAccessory, Service } from 'homebridge';
import type { ExamplePlatform } from './platform';

/** A switch in the Home app that remembers its state and, if set, turns itself off again. */
export class ExampleSwitch {
  private on = false;
  private timer: NodeJS.Timeout | undefined;
  readonly service: Service;

  constructor(
    private readonly platform: ExamplePlatform,
    accessory: PlatformAccessory,
  ) {
    const { Service, Characteristic } = platform.api.hap;
    accessory
      .getService(Service.AccessoryInformation)
      ?.setCharacteristic(Characteristic.Manufacturer, 'Example')
      .setCharacteristic(Characteristic.Model, 'Example Switch');
    this.service = accessory.getService(Service.Switch) ?? accessory.addService(Service.Switch, platform.settings.switchName);
    this.service.setCharacteristic(Characteristic.Name, platform.settings.switchName);
    this.service
      .getCharacteristic(Characteristic.On)
      .onGet(() => this.on)
      .onSet((value: CharacteristicValue) => this.set(value === true));
  }

  get isOn(): boolean {
    return this.on;
  }

  set(on: boolean): void {
    this.on = on;
    this.platform.log.info(`"${this.platform.settings.switchName}" turned ${on ? 'on' : 'off'}.`);
    clearTimeout(this.timer);
    this.timer = undefined;
    const seconds = this.platform.settings.resetSeconds;
    if (on && seconds > 0) {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        this.on = false;
        this.service.updateCharacteristic(this.platform.api.hap.Characteristic.On, false);
        this.platform.log.info(`"${this.platform.settings.switchName}" turned off after ${seconds} s.`);
      }, seconds * 1000);
    }
  }

  /** Stops the reset timer, so Homebridge can shut down. */
  stop(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
  }
}
