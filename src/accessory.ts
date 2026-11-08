import type {
  API, Characteristic, CharacteristicValue, HAP, HapStatusError, Logging, PlatformAccessory, Service, WithUUID,
} from 'homebridge';
import { query } from './snmp';
import type { PrinterData, QueryOptions, QueryResult } from './snmp';
import type { Color, PartKey, PrinterError, Supply } from './decode';

// Resolved from dist/ at runtime, like the published package
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { version } = require('../package.json') as { version: string };

/** What the plugin keeps in Homebridge's accessory cache */
export interface PrinterContext {
  host?: string;
  model?: string;
  serial?: string;
  /** 'Toner' or 'Ink', once the printer has said */
  kind?: Kind;
  /** The printer reported no supply levels last time */
  noLevels?: boolean;
}

/** A printer's entry in config.json; values may be anything a user typed */
export interface PrinterConfig {
  name: string;
  host: string;
  community?: string;
  port?: unknown;
  snmpVersion?: unknown;
  pollInterval?: unknown;
  lowTonerThreshold?: unknown;
  lowTonerSensor?: unknown;
  lowDrumThreshold?: unknown;
  showDrum?: unknown;
  tonerTile?: unknown;
  faultSensor?: unknown;
  offlineAfter?: unknown;
  debug?: unknown;
}

/** The parts of the platform an accessory uses */
export interface PrinterHost {
  log: Logging;
  api: API;
}

/** Reads the printer; tests pass their own */
export type QueryFn = (options: QueryOptions) => Promise<QueryResult>;

type Kind = 'Toner' | 'Ink';
type ServiceType = WithUUID<typeof Service>;

const PAGES_UUID = 'B0E5A1C2-7D3E-4F1A-9C6B-2E8D4F7A1B30';
type CharacteristicType = WithUUID<new () => Characteristic>;
let PagesPrinted: CharacteristicType | undefined;

function pagesCharacteristic(hap: HAP): CharacteristicType {
  if (PagesPrinted) { return PagesPrinted; }
  const { Characteristic: Base, Formats, Perms } = hap;
  class Pages extends Base {
    static readonly UUID = PAGES_UUID;
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
  }
  PagesPrinted = Pages;
  return Pages;
}

const clamp = (v: number): number => Math.max(0, Math.min(100, Math.round(v)));
/** A whole number setting; anything that isn't a number gets the default */
const setting = (v: unknown, def: number, min: number, max: number): number => {
  const n = typeof v === 'string' && v.trim() === '' ? NaN : Number(v ?? def);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.round(n))) : def;
};
const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);
const errorText = (err: unknown, stack = false): string => {
  const e = err as { message?: string; stack?: string } | null;
  return (stack && e?.stack) || e?.message || String(err);
};

const TILE_SUBTYPE: Record<Color, string> = {
  black: 'tonerTile', cyan: 'tile-cyan', magenta: 'tile-magenta', yellow: 'tile-yellow',
};
const FAULT_NAMES: Partial<Record<PrinterError, string>> = {
  noPaper: 'out of paper', noToner: 'toner or ink empty', doorOpen: 'cover open', jammed: 'paper jam',
  serviceRequested: 'service requested', inputTrayMissing: 'tray missing', outputTrayMissing: 'output tray missing',
  markerSupplyMissing: 'cartridge missing', outputFull: 'output tray full',
};
const PART_NAMES: Record<PartKey, string> = {
  belt: 'Belt unit', fuser: 'Fuser unit', laser: 'Laser unit',
  paperFeed1: 'Paper feed kit (tray 1)', paperFeedMP: 'Paper feed kit (MP tray)', inkWasteBox: 'Ink waste box',
};

interface LastSeen {
  fault?: boolean;
  statusText?: string;
  summary?: boolean;
  supplies?: Partial<Record<Color, { level: number; low: boolean }>>;
  warned?: Record<string, boolean>;
}

export class PrinterAccessory {
  readonly platform: PrinterHost;
  readonly log: Logging;
  readonly api: API;
  readonly hap: HAP;
  readonly accessory: PlatformAccessory<PrinterContext>;
  readonly name: string;

  readonly options: QueryOptions & { host: string };
  readonly interval: number;
  readonly lowToner: number;
  readonly lowDrum: number;
  readonly showDrum: boolean;
  readonly tonerTile: boolean;
  readonly faultSensor: boolean;
  readonly lowTonerSensor: boolean;
  readonly offlineAfter: number;
  readonly debug: boolean;

  failures = 0;
  online = true;
  last: LastSeen = {};
  timer: NodeJS.Timeout | null = null;
  stopped = false;
  tiles: Partial<Record<Color, Service>> = {};
  guarded: Characteristic[] = [];

  occupancy!: Service;
  pages!: Characteristic;
  toner: Service | null = null;
  drum: Service | null = null;
  problem: Service | null = null;
  lowSensor: Service | null = null;

  private readonly query: QueryFn;

  constructor(platform: PrinterHost, accessory: PlatformAccessory<PrinterContext>, config: PrinterConfig,
    deps: { query?: QueryFn } = {}) {
    this.query = deps.query || query;
    this.platform = platform;
    this.log = platform.log;
    this.api = platform.api;
    this.hap = platform.api.hap;
    this.accessory = accessory;
    this.name = config.name;

    const snmpVersion = String(config.snmpVersion);
    this.options = {
      host: config.host,
      port: setting(config.port, 161, 1, 65535),
      community: config.community || 'public',
      timeout: 5000,
      retries: 1,
      version: snmpVersion === '1' || snmpVersion === '2c' ? snmpVersion : 'auto',
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

    this.buildServices();
    this.guardReads();
    void this.poll();
  }

  /* ------------------------------------------------------------ services */

  buildServices(): void {
    const { Service: S, Characteristic: C } = this.hap;
    const acc = this.accessory;

    acc.getService(S.AccessoryInformation)!
      .setCharacteristic(C.Manufacturer, 'Brother')
      .setCharacteristic(C.Model, acc.context.model || 'Brother printer')
      .setCharacteristic(C.SerialNumber, acc.context.serial || this.options.host)
      .setCharacteristic(C.FirmwareRevision, version);

    // Printing state: the tile people see in the Home app
    this.occupancy = acc.getService(S.OccupancySensor)
      || acc.addService(S.OccupancySensor, this.name);
    this.label(this.occupancy, this.name);
    this.occupancy.setPrimaryService(true);
    for (const ch of [C.StatusActive, C.StatusFault]) {
      if (!this.occupancy.testCharacteristic(ch)) { this.occupancy.addOptionalCharacteristic(ch); }
      this.occupancy.getCharacteristic(ch);
    }
    this.occupancy.getCharacteristic(C.StatusActive).updateValue(true);
    const Pages = pagesCharacteristic(this.hap);
    // testCharacteristic/addCharacteristic are typed for HAP's base class; a subclass works the same
    const PagesClass = Pages as unknown as WithUUID<typeof Characteristic>;
    if (!this.occupancy.testCharacteristic(PagesClass)) { this.occupancy.addCharacteristic(PagesClass); }
    this.pages = this.occupancy.getCharacteristic(Pages);

    // Toner and drum as batteries so Home raises native "low" alerts. A printer
    // that reported no levels last time gets none until it reports some.
    if (acc.context.noLevels) {
      this.removeSubtype(S.Battery, 'toner');
      this.toner = null;
    } else {
      this.toner = this.battery('toner', `${this.name} ${acc.context.kind || 'Toner'}`);
      this.occupancy.addLinkedService(this.toner);
    }

    if (this.showDrum) {
      this.drum = this.battery('drum', `${this.name} Drum`);
      this.occupancy.addLinkedService(this.drum);
    } else {
      this.removeSubtype(S.Battery, 'drum');
    }

    // Home doesn't surface StatusFault on occupancy sensors, so problems
    // (jam, cover open, no paper...) also open a contact sensor.
    if (this.faultSensor) {
      const problem = acc.getServiceById(S.ContactSensor, 'problem')
        || acc.addService(S.ContactSensor, `${this.name} Problem`, 'problem');
      this.label(problem, `${this.name} Problem`);
      if (!problem.testCharacteristic(C.StatusActive)) { problem.addOptionalCharacteristic(C.StatusActive); }
      problem.getCharacteristic(C.StatusActive).updateValue(true);
      this.occupancy.addLinkedService(problem);
      this.problem = problem;
    } else {
      this.removeSubtype(S.ContactSensor, 'problem');
    }

    // The low toner sensor is created once the printer says toner or ink;
    // here only one restored from the cache is picked up.
    const lowSvc = acc.getServiceById(S.ContactSensor, 'lowToner');
    if (lowSvc && this.lowTonerSensor) { this.lowSensor = lowSvc; } else if (lowSvc) { acc.removeService(lowSvc); }

    // Supply tiles are created once the printer says which colors it has;
    // here only the ones restored from the cache are picked up.
    for (const [color, subtype] of Object.entries(TILE_SUBTYPE) as [Color, string][]) {
      const svc = acc.getServiceById(S.HumiditySensor, subtype);
      if (!svc) { continue; }
      if (this.tonerTile) { this.tiles[color] = svc; } else { acc.removeService(svc); }
    }
  }

  /** Make one tile per reported supply; remove tiles for colors not reported */
  ensureTiles(d: PrinterData): void {
    if (!this.tonerTile) { return; }
    const { Service: S, Characteristic: C } = this.hap;
    const colors = new Set(d.supplies.map((s) => s.color));
    const mono = d.supplies.length === 1;
    const kind = d.type === 'ink' ? 'Ink' : 'Toner';

    for (const [color, subtype] of Object.entries(TILE_SUBTYPE) as [Color, string][]) {
      const existing = this.tiles[color];
      if (!colors.has(color)) {
        if (existing) {
          this.accessory.removeService(existing);
          delete this.tiles[color];
        }
        continue;
      }
      if (existing) { continue; }
      const name = mono ? `${this.name} ${kind}` : `${this.name} ${cap(color)}`;
      const svc = this.accessory.addService(S.HumiditySensor, name, subtype);
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
   * name.
   */
  ensureLowSensor(kind: Kind): void {
    if (!this.lowTonerSensor || this.lowSensor) { return; }
    const { Service: S, Characteristic: C } = this.hap;
    const name = `${this.name} ${kind} Low`;
    const svc = this.accessory.addService(S.ContactSensor, name, 'lowToner');
    this.label(svc, name);
    if (!svc.testCharacteristic(C.StatusActive)) { svc.addOptionalCharacteristic(C.StatusActive); }
    svc.getCharacteristic(C.StatusActive).updateValue(true);
    this.occupancy.addLinkedService(svc);
    this.guard(svc.getCharacteristic(C.ContactSensorState));
    this.lowSensor = svc;
  }

  removeLowSensor(): void {
    const svc = this.lowSensor;
    if (!svc) { return; }
    this.guarded = this.guarded.filter((ch) => !svc.characteristics.includes(ch));
    this.accessory.removeService(svc);
    this.lowSensor = null;
  }

  /**
   * Home ignores StatusActive on sensors. It shows "No Response" only when a
   * read fails, so while the printer is offline the state reads fail too.
   */
  guardReads(): void {
    const C = this.hap.Characteristic;
    const pairs: [Service | null | undefined, CharacteristicType][] = [
      [this.occupancy, C.OccupancyDetected],
      [this.occupancy, C.StatusFault],
      [this.toner, C.BatteryLevel],
      [this.toner, C.StatusLowBattery],
      [this.drum, C.BatteryLevel],
      [this.drum, C.StatusLowBattery],
      [this.problem, C.ContactSensorState],
      [this.lowSensor, C.ContactSensorState],
      ...Object.values(this.tiles).map((svc): [Service, CharacteristicType] => [svc, C.CurrentRelativeHumidity]),
    ];
    for (const [svc, type] of pairs) {
      if (svc) { this.guard(svc.getCharacteristic(type)); }
    }
  }

  guard(ch: Characteristic): void {
    if (this.guarded.includes(ch)) { return; }
    this.guarded.push(ch);
    ch.onGet(() => {
      if (!this.online) { throw this.noResponse(); }
      return ch.value as CharacteristicValue;
    });
  }

  noResponse(): HapStatusError {
    const { HapStatusError: StatusError, HAPStatus } = this.hap;
    return new StatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
  }

  battery(subtype: string, name: string): Service {
    const { Service: S, Characteristic: C } = this.hap;
    const svc = this.accessory.getServiceById(S.Battery, subtype)
      || this.accessory.addService(S.Battery, name, subtype);
    this.label(svc, name);
    svc.setCharacteristic(C.ChargingState, C.ChargingState.NOT_CHARGEABLE);
    return svc;
  }

  label(svc: Service, name: string): void {
    const C = this.hap.Characteristic;
    svc.setCharacteristic(C.Name, name);
    if (!svc.testCharacteristic(C.ConfiguredName)) { svc.addOptionalCharacteristic(C.ConfiguredName); }
    // Only seed the name; don't overwrite a name the user set in the Home app
    const current = svc.getCharacteristic(C.ConfiguredName).value;
    if (!current) { svc.setCharacteristic(C.ConfiguredName, name); }
  }

  removeSubtype(type: ServiceType, subtype: string): void {
    const svc = this.accessory.getServiceById(type, subtype);
    if (svc) { this.accessory.removeService(svc); }
  }

  /* ------------------------------------------------------------- polling */

  async poll(): Promise<void> {
    if (this.stopped) { return; }
    let data: QueryResult | undefined;
    try {
      data = await this.query(this.options);
    } catch (err) {
      this.failures += 1;
      const msg = errorText(err);
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
        this.log.error(`[${this.name}] Couldn't update HomeKit: ${errorText(err, true)}`);
      }
    }
    if (!this.stopped) { this.timer = setTimeout(() => void this.poll(), this.interval); }
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) { clearTimeout(this.timer); }
  }

  setOnline(online: boolean): void {
    const C = this.hap.Characteristic;
    const wasOnline = this.online;
    if (online && !wasOnline) { this.log.info(`[${this.name}] Back online.`); }
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

  apply(d: QueryResult): void {
    const C = this.hap.Characteristic;
    const log = (m: string): void => (this.debug ? this.log.info(m) : this.log.debug(m));

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
  applySupplies(d: PrinterData): void {
    const C = this.hap.Characteristic;
    const kind: Kind = d.type === 'ink' ? 'Ink' : 'Toner';

    if (!d.supplies.length || !d.lowestSupply) {
      // Some models (e.g. ink tank printers) report no levels at all
      this.remember({ noLevels: true });
      const toner = this.toner;
      if (toner) {
        this.log.info(`[${this.name}] This printer doesn't report ${kind.toLowerCase()} levels; `
          + 'leaving out the battery.');
        this.accessory.removeService(toner);
        this.guarded = this.guarded.filter((ch) => !toner.characteristics.includes(ch));
        this.toner = null;
      }
      this.removeLowSensor();
      return;
    }
    let toner = this.toner;
    if (!toner) {
      toner = this.battery('toner', `${this.name} ${kind}`);
      this.occupancy.addLinkedService(toner);
      this.guard(toner.getCharacteristic(C.BatteryLevel));
      this.guard(toner.getCharacteristic(C.StatusLowBattery));
      this.toner = toner;
    }
    this.renameBattery(toner, kind);
    this.remember({ noLevels: false, kind });

    const flagged = d.errors.includes('lowToner') || d.errors.includes('noToner');
    const isLow = (s: Supply): boolean => s.level <= this.lowToner || (s.fine !== null && s.fine <= this.lowToner);
    const low = d.supplies.filter(isLow);
    const level = clamp(d.lowestSupply.level);

    toner.updateCharacteristic(C.BatteryLevel, level);
    toner.updateCharacteristic(C.StatusLowBattery, low.length || flagged
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
      this.tiles[s.color]?.updateCharacteristic(C.CurrentRelativeHumidity, clamp(s.level));
    }

    const mono = d.supplies.length === 1;
    const label = (s: Supply): string => (mono ? kind : `${cap(s.color)} ${kind.toLowerCase()}`);
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
  applyDrumAndParts(d: PrinterData): void {
    const drums = (Object.entries(d.drums) as [Color, { percent?: number; pagesRemaining?: number }][])
      .filter((e): e is [Color, { percent: number; pagesRemaining?: number }] => typeof e[1].percent === 'number');
    if (drums.length) {
      const [color, lowest] = drums.reduce((a, b) => (b[1].percent < a[1].percent ? b : a));
      const level = clamp(lowest.percent);
      if (this.drum) { this.setBattery(this.drum, level, this.lowDrum); }
      const name = drums.length > 1 ? `${cap(color)} drum` : 'Drum';
      this.warnOnce('drum', level <= this.lowDrum,
        `${name} is near end of life (${level}%, ${lowest.pagesRemaining ?? '?'} pages left).`);
    }
    for (const [key, part] of Object.entries(d.parts) as [PartKey, { percent?: number; pagesRemaining?: number }][]) {
      if (typeof part.percent !== 'number' || !PART_NAMES[key]) { continue; }
      const left = part.pagesRemaining !== undefined ? `, ${part.pagesRemaining} pages left` : '';
      this.warnOnce(`part-${key}`, part.percent <= this.lowDrum,
        `${PART_NAMES[key]} is near end of life (${part.percent}%${left}).`);
    }
  }

  warnOnce(key: string, condition: boolean, message: string): void {
    this.last.warned = this.last.warned || {};
    if (condition && !this.last.warned[key]) { this.log.warn(`[${this.name}] ${message}`); }
    this.last.warned[key] = condition;
  }

  /**
   * The battery is made before the first poll says toner or ink, so on an
   * inkjet it starts as "Toner". Rename it, unless the user renamed it in Home.
   */
  renameBattery(toner: Service, kind: Kind): void {
    const C = this.hap.Characteristic;
    const was = this.accessory.context.kind || 'Toner';
    if (was === kind) { return; }
    const name = `${this.name} ${kind}`;
    toner.setCharacteristic(C.Name, name);
    const current = toner.getCharacteristic(C.ConfiguredName).value;
    if (!current || current === `${this.name} ${was}`) { toner.setCharacteristic(C.ConfiguredName, name); }
  }

  /** Store values in the accessory cache, saving only when something changed */
  remember(values: Partial<PrinterContext>): void {
    const ctx = this.accessory.context as Record<string, unknown>;
    const changed = Object.entries(values).filter(([k, v]) => ctx[k] !== v);
    if (!changed.length) { return; }
    for (const [k, v] of changed) { ctx[k] = v; }
    this.api.updatePlatformAccessories([this.accessory]);
  }

  setBattery(svc: Service, level: number, threshold: number): void {
    const C = this.hap.Characteristic;
    svc.updateCharacteristic(C.BatteryLevel, level);
    svc.updateCharacteristic(C.StatusLowBattery, level <= threshold
      ? C.StatusLowBattery.BATTERY_LEVEL_LOW
      : C.StatusLowBattery.BATTERY_LEVEL_NORMAL);
  }

  updateInfo(d: PrinterData): void {
    const { Service: S, Characteristic: C } = this.hap;
    const ctx = this.accessory.context;
    let changed = false;
    const model = d.model ? d.model.replace(/^Brother\s+/i, '') : null;
    if (model && model !== ctx.model) { ctx.model = model; changed = true; }
    if (d.serial && d.serial !== ctx.serial) { ctx.serial = d.serial; changed = true; }
    if (!changed) { return; }
    this.accessory.getService(S.AccessoryInformation)!
      .updateCharacteristic(C.Model, ctx.model || 'Brother printer')
      .updateCharacteristic(C.SerialNumber, ctx.serial || this.options.host);
    this.api.updatePlatformAccessories([this.accessory]);
  }
}
