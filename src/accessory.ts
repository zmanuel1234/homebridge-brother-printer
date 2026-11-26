import type {
  API, Characteristic, CharacteristicValue, HAP, HapStatusError, Logging, PlatformAccessory, Service, WithUUID,
} from 'homebridge';
import { format } from 'node:util';
import { AUTH_PROTOCOLS, PRIV_PROTOCOLS, protocolSetting, readVia, v3User } from './snmp';
import { readPrinter } from './read';
import { ippEndpoint } from './ipp';
import type { PrinterData, QueryOptions, QueryResult } from './snmp';
import { ALL_COLORS, COLOR_NAMES } from './decode';
import type { Color, PartKey, PrinterError, Supply } from './decode';
import { entryDue, startHistory } from './history';
import type { HistoryEntry, HistoryLog } from './history';
import { addSample, daysLeft, describeDays, describeLeft, pagesInLast } from './usage';
import type { UsageSample } from './usage';
import type { Tray } from './trays';

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
  /** The name in the config when the accessory was last set up */
  name?: string;
  /** As the printer gives it over IPP; Brother otherwise */
  manufacturer?: string;
  /** The printer has answered SNMP (with protocol auto, IPP then only fills in) */
  snmpAnswered?: boolean;
  /** One reading a day: pages and levels, for usage and "toner left" estimates */
  usage?: UsageSample[];
  /** When the weekly usage line was last logged (Unix seconds) */
  usageLogged?: number;
}

/** A printer's entry in config.json; values may be anything a user typed */
export interface PrinterConfig {
  name: string;
  host: string;
  /** Printer serial number, filled in by the settings screen's search */
  serial?: unknown;
  community?: string;
  port?: unknown;
  snmpVersion?: unknown;
  /** 'snmp' (default), 'ipp' or 'auto' */
  protocol?: unknown;
  ippUrl?: unknown;
  ippAllowSelfSigned?: unknown;
  v3User?: unknown;
  v3AuthProtocol?: unknown;
  v3AuthPassword?: unknown;
  v3PrivProtocol?: unknown;
  v3PrivPassword?: unknown;
  v3Context?: unknown;
  pollInterval?: unknown;
  lowTonerThreshold?: unknown;
  lowTonerSensor?: unknown;
  lowDrumThreshold?: unknown;
  showDrum?: unknown;
  tonerTile?: unknown;
  faultSensor?: unknown;
  maintenanceSensor?: unknown;
  paperSensor?: unknown;
  paperTraySensors?: unknown;
  onlineSensor?: unknown;
  eveHistory?: unknown;
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
const errorText = (err: unknown, stack = false): string => {
  const e = err as { message?: string; stack?: string } | null;
  return (stack && e?.stack) || e?.message || String(err);
};

// Black keeps the subtype it had when there was only one tile
const TILE_SUBTYPE: Record<Color, string> = Object.fromEntries(
  ALL_COLORS.map((c) => [c, c === 'black' ? 'tonerTile' : `tile-${c}`])) as Record<Color, string>;
const FAULT_NAMES: Partial<Record<PrinterError, string>> = {
  noPaper: 'out of paper', noToner: 'toner or ink empty', doorOpen: 'cover open', jammed: 'paper jam',
  serviceRequested: 'service requested', inputTrayMissing: 'tray missing', outputTrayMissing: 'output tray missing',
  markerSupplyMissing: 'cartridge missing', outputFull: 'output tray full',
};
/** fakegato-history's service (Eve's history service) */
const EVE_HISTORY_SERVICE = 'E863F007-079E-48FF-8F27-9C2605A29F52';

/** What the plugin adds after the printer's name when it names a sensor */
const OWN_SUFFIXES = new Set(['', ' Problem', ' Toner', ' Ink', ' Drum', ' Toner Low', ' Ink Low', ' Maintenance',
  ' Out of Paper', ' Online', ...Object.values(COLOR_NAMES).map((n) => ` ${n}`)]);
/** Paper tray sensors' subtypes: "tray-" and the tray's key */
const TRAY_PREFIX = 'tray-';

const PART_NAMES: Record<PartKey, string> = {
  belt: 'Belt unit', fuser: 'Fuser unit', laser: 'Laser unit',
  paperFeed1: 'Paper feed kit (tray 1)', paperFeedMP: 'Paper feed kit (MP tray)', inkWasteBox: 'Ink waste box',
  maintenanceKit: 'Maintenance kit', wasteToner: 'Waste toner box', developer: 'Developer unit',
};

interface LastSeen {
  fault?: boolean;
  statusText?: string;
  summary?: boolean;
  supplies?: Partial<Record<Color, { level: number; low: boolean }>>;
  warned?: Record<string, boolean>;
}

/**
 * How to reach a printer, from its config entry. Throws on SNMPv3 settings that
 * can't work, so they're reported at startup rather than as "can't reach".
 * The settings screen's connection test uses this too.
 */
export function queryOptions(config: PrinterConfig): QueryOptions & { host: string } {
  const snmpVersion = String(config.snmpVersion);
  const options: QueryOptions & { host: string } = {
    host: String(config.host).trim(),
    port: setting(config.port, 161, 1, 65535),
    community: config.community || 'public',
    timeout: 5000,
    retries: 1,
    version: snmpVersion === '1' || snmpVersion === '2c' || snmpVersion === '3' ? snmpVersion : 'auto',
    state: {},
  };
  const protocol = String(config.protocol ?? '').trim().toLowerCase();
  options.protocol = protocol === 'ipp' || protocol === 'auto' ? protocol : 'snmp';
  const ippUrl = String(config.ippUrl ?? '').trim();
  if (ippUrl && options.protocol !== 'snmp') {
    try {
      ippEndpoint(ippUrl);
    } catch {
      throw new Error(`IPP address "${ippUrl}" isn't valid; use the form ipp://<printer>:631/ipp/print`);
    }
    options.ippUrl = ippUrl;
  }
  if (options.protocol !== 'snmp' && config.ippAllowSelfSigned === true) { options.ippAllowSelfSigned = true; }
  // SNMPv3 settings only matter when SNMP is used
  if (options.version === '3' && options.protocol !== 'ipp') {
    options.v3 = {
      user: String(config.v3User ?? '').trim(),
      authProtocol: protocolSetting(config.v3AuthProtocol, AUTH_PROTOCOLS, 'sha', 'authentication'),
      authPassword: String(config.v3AuthPassword ?? ''),
      privProtocol: protocolSetting(config.v3PrivProtocol, PRIV_PROTOCOLS, 'aes', 'encryption'),
      privPassword: String(config.v3PrivPassword ?? ''),
      context: String(config.v3Context ?? '').trim(),
    };
    v3User(options.v3);
  }
  return options;
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
  readonly maintenanceSensor: boolean;
  readonly paperSensor: boolean;
  readonly paperTraySensors: boolean;
  readonly onlineSensor: boolean;
  readonly eveHistory: boolean;
  /** The serial number from the settings, if any */
  readonly configSerial: string;
  readonly offlineAfter: number;
  readonly debug: boolean;

  failures = 0;
  /** Polls in a row whose supplies couldn't be read */
  unreadPolls = 0;
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
  maintenance: Service | null = null;
  paper: Service | null = null;
  /** Paper tray sensors by tray key */
  trays: Record<string, Service> = {};
  onlineSvc: Service | null = null;
  history: HistoryLog | null = null;
  /** With protocol auto: SNMP has answered since Homebridge started, so IPP only stands in */
  snmpAnswered = false;
  lastEntry: HistoryEntry | undefined;
  /** Starts the Eve history; tests pass their own */
  private readonly startHistory: typeof startHistory;

  private readonly query: QueryFn;

  constructor(platform: PrinterHost, accessory: PlatformAccessory<PrinterContext>, config: PrinterConfig,
    deps: { query?: QueryFn; startHistory?: typeof startHistory } = {}) {
    this.query = deps.query || readPrinter;
    this.startHistory = deps.startHistory || startHistory;
    this.platform = platform;
    this.log = platform.log;
    this.api = platform.api;
    this.hap = platform.api.hap;
    this.accessory = accessory;
    this.name = config.name;

    this.options = queryOptions(config);
    // Supplies shown before a restart: a supplies walk that fails on the first poll is a
    // failed poll, not "no supplies" (which would take the battery and tiles away)
    this.options.state!.suppliesRead = accessory.context.noLevels === false;
    this.interval = setting(config.pollInterval, 60, 10, 3600) * 1000;
    this.lowToner = setting(config.lowTonerThreshold, 10, 0, 100);
    this.lowDrum = setting(config.lowDrumThreshold, 10, 0, 100);
    this.showDrum = config.showDrum === true;
    this.tonerTile = config.tonerTile === true;
    this.faultSensor = config.faultSensor !== false;
    this.lowTonerSensor = config.lowTonerSensor === true;
    this.maintenanceSensor = config.maintenanceSensor === true;
    this.paperSensor = config.paperSensor === true;
    this.paperTraySensors = config.paperTraySensors === true;
    // Tray sensors need the trays on every poll
    if (this.paperTraySensors) { this.options.trays = true; }
    this.onlineSensor = config.onlineSensor === true;
    this.eveHistory = config.eveHistory === true;
    this.configSerial = String(config.serial ?? '').trim();
    this.offlineAfter = setting(config.offlineAfter, 3, 1, 20);
    this.debug = config.debug === true;

    // Kept across restarts, so a first poll that falls back to IPP after a
    // restart doesn't count in full against what SNMP set up
    this.snmpAnswered = accessory.context.snmpAnswered === true;
    this.renameFrom(accessory.context.name ?? accessory.displayName);
    this.buildServices();
    this.guardReads();
    void this.poll();
  }

  /* ------------------------------------------------------------ services */

  /**
   * After the printer is renamed in the config, rename its sensors in Home to
   * match, except ones the user renamed in the Home app.
   */
  renameFrom(old: string | undefined): void {
    const acc = this.accessory;
    if (old && old !== this.name) {
      const C = this.hap.Characteristic;
      for (const svc of acc.services) {
        for (const type of [C.Name, C.ConfiguredName]) {
          if (!svc.testCharacteristic(type)) { continue; }
          const value = svc.getCharacteristic(type).value;
          // Only names the plugin gave; a name set in the Home app stays
          const own = OWN_SUFFIXES.has(value?.toString().slice(old.length) ?? '')
            || (svc.subtype?.startsWith(TRAY_PREFIX) === true && value?.toString().startsWith(`${old} `) === true);
          if (typeof value === 'string' && value.startsWith(old) && own) {
            svc.updateCharacteristic(type, this.name + value.slice(old.length));
          }
        }
      }
      const named = acc as unknown as { updateDisplayName?: (name: string) => void };
      if (typeof named.updateDisplayName === 'function') { named.updateDisplayName(this.name); }
      this.log.info(`[${this.name}] Renamed from "${old}"; it keeps its room, automations and notifications in Home.`);
    }
    acc.context.name = this.name;
  }

  buildServices(): void {
    const { Service: S, Characteristic: C } = this.hap;
    const acc = this.accessory;

    acc.getService(S.AccessoryInformation)!
      .setCharacteristic(C.Manufacturer, acc.context.manufacturer || 'Brother')
      .setCharacteristic(C.Model, acc.context.model || (acc.context.manufacturer ? 'Printer' : 'Brother printer'))
      .setCharacteristic(C.SerialNumber, acc.context.serial || this.options.host)
      .setCharacteristic(C.FirmwareRevision, version);

    // Printing state: the tile people see in the Home app
    this.occupancy = acc.services.find((svc) => svc.UUID === S.OccupancySensor.UUID && !svc.subtype)
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

    // Drum and parts (belt, fuser, ...) as one contact sensor, since Home shows
    // only one battery per accessory
    this.maintenance = this.optionalContact(this.maintenanceSensor, 'maintenance', `${this.name} Maintenance`);
    // Out of paper on its own, the problem people most often fix themselves
    this.paper = this.optionalContact(this.paperSensor, 'noPaper', `${this.name} Out of Paper`);

    // One sensor per paper tray, made once the printer lists its trays; here only the
    // ones restored from the cache are picked up
    for (const svc of acc.services.filter((s) => s.UUID === S.ContactSensor.UUID && s.subtype?.startsWith(TRAY_PREFIX))) {
      if (this.paperTraySensors) { this.trays[svc.subtype!.slice(TRAY_PREFIX.length)] = svc; } else { acc.removeService(svc); }
    }

    // Reachable or not, as a sensor automations can use. Home can't trigger on
    // No Response, so this one stays readable while the printer is offline.
    if (this.onlineSensor) {
      const svc = acc.getServiceById(S.OccupancySensor, 'online')
        || acc.addService(S.OccupancySensor, `${this.name} Online`, 'online');
      this.label(svc, `${this.name} Online`);
      this.occupancy.addLinkedService(svc);
      this.onlineSvc = svc;
    } else {
      this.removeSubtype(S.OccupancySensor, 'online');
    }

    // Eve history (fakegato's service) is added when the history starts; take
    // it away when the history is turned off
    if (!this.eveHistory) {
      const historySvc = acc.services.find((svc) => svc.UUID === EVE_HISTORY_SERVICE);
      if (historySvc) { acc.removeService(historySvc); }
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

  /** A contact sensor that's on or off by a setting, kept or removed from the cache */
  optionalContact(enabled: boolean, subtype: string, name: string): Service | null {
    const { Service: S, Characteristic: C } = this.hap;
    if (!enabled) {
      this.removeSubtype(S.ContactSensor, subtype);
      return null;
    }
    const svc = this.accessory.getServiceById(S.ContactSensor, subtype)
      || this.accessory.addService(S.ContactSensor, name, subtype);
    this.label(svc, name);
    if (!svc.testCharacteristic(C.StatusActive)) { svc.addOptionalCharacteristic(C.StatusActive); }
    svc.getCharacteristic(C.StatusActive).updateValue(true);
    this.occupancy.addLinkedService(svc);
    return svc;
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
      const name = mono ? `${this.name} ${kind}` : `${this.name} ${COLOR_NAMES[color]}`;
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
      [this.maintenance, C.ContactSensorState],
      [this.paper, C.ContactSensorState],
      ...Object.values(this.tiles).map((svc): [Service, CharacteristicType] => [svc, C.CurrentRelativeHumidity]),
      ...Object.values(this.trays).map((svc): [Service, CharacteristicType] => [svc, C.ContactSensorState]),
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
    for (const svc of [this.lowSensor, this.maintenance, this.paper, ...Object.values(this.trays)]) {
      if (svc) { svc.updateCharacteristic(C.StatusActive, online); }
    }
    if (this.onlineSvc) {
      this.onlineSvc.updateCharacteristic(C.OccupancyDetected, online
        ? C.OccupancyDetected.OCCUPANCY_DETECTED
        : C.OccupancyDetected.OCCUPANCY_NOT_DETECTED);
    }
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
    if (d.via !== 'ipp' && !this.snmpAnswered) {
      this.snmpAnswered = true;
      this.remember({ snmpAnswered: true });
    }
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
    if (this.paper) {
      const out = d.errors.includes('noPaper') || d.errors.includes('inputTrayEmpty');
      this.paper.updateCharacteristic(C.ContactSensorState, out
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

    // The supplies table didn't read this time (it did before): keep the last levels,
    // drums and parts rather than take them away
    if (d.suppliesUnread) {
      this.unreadPolls += 1;
      log(`[${this.name}] Supplies couldn't be read this time; keeping the last levels.`);
      this.warnOnce('supplies-unread', this.unreadPolls >= this.offlineAfter, `The printer answers, but its supply levels `
        + `haven't been readable for ${this.unreadPolls} polls; showing the last ones.`);
      this.applyLowFlag(d);
    } else {
      if (this.last.warned?.['supplies-unread']) { this.log.info(`[${this.name}] Supply levels read again.`); }
      this.unreadPolls = 0;
      this.warnOnce('supplies-unread', false, '');
      this.applySupplies(d);
      this.applyDrumAndParts(d);
      if (!this.standIn(d)) { this.recordUsage(d); }
    }
    if (d.trays) { this.applyTrays(d.trays); }

    if (d.totalPages !== null) { this.pages.updateValue(d.totalPages); }
    this.last.statusText = d.statusText;

    if (this.last.summary === undefined) {
      const kind = d.type === 'ink' ? 'ink' : 'toner';
      const levels = d.suppliesUnread ? 'supply levels not readable this time' : d.supplies.length
        ? d.supplies.map((s) => (d.supplies.length === 1 ? `${kind} ${s.level}%` : `${s.color} ${s.level}%`)).join(', ')
        : `no ${kind} levels reported`;
      const drum = d.drumPercent !== null ? `, drum ${d.drumPercent}%` : '';
      this.log.info(`[${this.name}] Connected to ${d.model || 'printer'} (${readVia(d)}): ${levels}${drum}, `
        + `${d.totalPages ?? '?'} pages, status "${d.statusText || 'unknown'}".`);
      this.last.summary = true;
    }
  }

  /**
   * Without a reading of the levels, the printer's own low / empty flag can still
   * mark the toner low (but not clear it)
   */
  applyLowFlag(d: PrinterData): void {
    if (!d.errors.includes('lowToner') && !d.errors.includes('noToner')) { return; }
    const C = this.hap.Characteristic;
    this.toner?.updateCharacteristic(C.StatusLowBattery, C.StatusLowBattery.BATTERY_LEVEL_LOW);
    this.lowSensor?.updateCharacteristic(C.ContactSensorState, C.ContactSensorState.CONTACT_NOT_DETECTED);
  }

  /**
   * Toner/ink battery: the lowest supply, so Home alerts when any color runs
   * low. A supply counts as low when its level or its finer reading is at or
   * below the threshold, or the printer itself flags low/no toner.
   */
  applySupplies(d: PrinterData): void {
    const C = this.hap.Characteristic;
    const kind: Kind = d.type === 'ink' ? 'Ink' : 'Toner';
    const flagged = d.errors.includes('lowToner') || d.errors.includes('noToner');

    if (this.standIn(d)) {
      // IPP standing in for SNMP: its levels update the sensors SNMP set up,
      // combined with SNMP's last levels for colors IPP doesn't report. It adds,
      // removes and stores nothing, and clears a low warning only when it
      // reports every color SNMP did.
      const known = this.last.supplies || {};
      // Levels SNMP doesn't report (no-levels printers) aren't taken from IPP either
      const ipp = this.accessory.context.noLevels ? []
        // Once SNMP has reported, only its colors (a color only IPP lists has no sensor)
        : d.supplies.filter((s) => !Object.keys(known).length || known[s.color]);
      const levels: Partial<Record<Color, number>> = Object.fromEntries(
        Object.entries(known).map(([color, v]) => [color, v.level]));
      for (const s of ipp) { levels[s.color] = s.level; }
      const values = Object.values(levels) as number[];
      // Without SNMP's levels since the restart, IPP's alone could show too high a level
      const haveSnmp = Object.keys(known).length > 0;
      const covers = haveSnmp && Object.keys(known).every((c) => ipp.some((s) => s.color === c));
      // SNMP also judges low by its finer reading, which IPP doesn't have, and
      // counts in 10% steps: a color SNMP found low stays low unless IPP shows a
      // clear rise above the threshold (a new cartridge)
      const stillLow = (Object.entries(known) as [Color, { level: number; low: boolean }][]).some(([c, v]) => {
        const now = ipp.find((s) => s.color === c);
        return v.low && !(now && now.level >= v.level + 10 && now.level > this.lowToner);
      });
      const low = flagged || stillLow || ipp.some((s) => s.level <= this.lowToner);
      if (this.toner && haveSnmp && values.length) { this.toner.updateCharacteristic(C.BatteryLevel, clamp(Math.min(...values))); }
      for (const s of ipp) { this.tiles[s.color]?.updateCharacteristic(C.CurrentRelativeHumidity, clamp(s.level)); }
      if (low || covers) {
        this.toner?.updateCharacteristic(C.StatusLowBattery, low
          ? C.StatusLowBattery.BATTERY_LEVEL_LOW : C.StatusLowBattery.BATTERY_LEVEL_NORMAL);
        this.lowSensor?.updateCharacteristic(C.ContactSensorState, low
          ? C.ContactSensorState.CONTACT_NOT_DETECTED : C.ContactSensorState.CONTACT_DETECTED);
      }
      if (ipp.length && haveSnmp) { this.logHistory(clamp(Math.min(...values))); }
      return;
    }
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
      this.ensureTiles(d); // tiles for levels no longer reported go too
      // The printer's own low flag still works without levels
      this.ensureLowSensor(kind);
      this.lowSensor?.updateCharacteristic(C.ContactSensorState, flagged
        ? C.ContactSensorState.CONTACT_NOT_DETECTED
        : C.ContactSensorState.CONTACT_DETECTED);
      this.warnOnce('flagged-no-levels', flagged, `The printer reports ${kind.toLowerCase()} low.`);
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
    this.logHistory(level);

    const mono = d.supplies.length === 1;
    const label = (s: Supply): string => (mono ? kind : `${COLOR_NAMES[s.color]} ${kind.toLowerCase()}`);
    const prev = this.last.supplies || {};
    for (const s of d.supplies) {
      const was = prev[s.color];
      if (was && was.level !== s.level) { this.log.info(`[${this.name}] ${label(s)} ${s.level}%`); }
      if (isLow(s) && !(was && was.low)) {
        const fine = s.fine !== null && s.fine !== s.level ? ` (${s.fine}% by the finer reading)` : '';
        const days = daysLeft(this.accessory.context.usage, s.color, Math.round(Date.now() / 1000), s.level);
        const left = days !== null ? ` At the rate it's been going down, ${describeDays(days)} left.` : '';
        this.log.warn(`[${this.name}] ${label(s)} is low: ${s.level}%${fine}.${left}`);
      }
    }
    this.last.supplies = Object.fromEntries(d.supplies.map((s) => [s.color, { level: s.level, low: isLow(s) }]));
  }

  /**
   * Eve history of the toner or ink level (the lowest color), shown on the
   * toner tiles. Started once the tiles exist, since fakegato looks for them
   * only when it starts.
   */
  logHistory(level: number): void {
    if (!this.eveHistory) { return; }
    if (!this.tonerTile) {
      this.warnOnce('history-tiles', true, 'Eve history needs "Show toner / ink % on tiles" (tonerTile) turned on; '
        + 'Eve draws it on those tiles.');
      return;
    }
    if (!this.history) {
      try {
        this.history = this.startHistory(this.api, this.accessory, { debug: (...args: unknown[]) => this.log.debug(format(...args)) });
      } catch (err) {
        this.warnOnce('history-start', true, `Couldn't start the Eve history: ${errorText(err)}`);
        return;
      }
    }
    const now = Math.round(Date.now() / 1000);
    if (!entryDue(this.lastEntry, now, level)) { return; }
    // Until fakegato has read the saved history it drops entries; try again next poll
    if (this.history.isHistoryLoaded && !this.history.isHistoryLoaded()) { return; }
    this.lastEntry = { time: now, humidity: level };
    this.history.addEntry(this.lastEntry);
  }

  /** Drum battery and maintenance sensor (optional), and log warnings for drums and other parts */
  applyDrumAndParts(d: PrinterData): void {
    const standIn = this.standIn(d);
    let due = false;
    const drums = (Object.entries(d.drums) as [Color, { percent?: number; pagesRemaining?: number }][])
      .filter((e): e is [Color, { percent: number; pagesRemaining?: number }] => typeof e[1].percent === 'number');
    if (drums.length) {
      const [color, lowest] = drums.reduce((a, b) => (b[1].percent < a[1].percent ? b : a));
      const level = clamp(lowest.percent);
      due = level <= this.lowDrum;
      // A stand-in reading only lowers the drum or marks it low, never clears it
      if (this.drum && (!standIn || due)) { this.setBattery(this.drum, level, this.lowDrum); }
      const name = drums.length > 1 ? `${COLOR_NAMES[color]} drum` : 'Drum';
      if (!standIn || due) {
        this.warnOnce('drum', due, `${name} is near end of life (${level}%, ${lowest.pagesRemaining ?? '?'} pages left).`);
      }
    }
    for (const [key, part] of Object.entries(d.parts) as [PartKey, { percent?: number; pagesRemaining?: number }][]) {
      if (typeof part.percent !== 'number' || !PART_NAMES[key]) { continue; }
      if (part.percent <= this.lowDrum) { due = true; }
      const left = part.pagesRemaining !== undefined ? `, ${part.pagesRemaining} pages left` : '';
      if (standIn && part.percent > this.lowDrum) { continue; }
      this.warnOnce(`part-${key}`, part.percent <= this.lowDrum,
        `${PART_NAMES[key]} is near end of life (${part.percent}%${left}).`);
    }
    // IPP standing in for SNMP may not report every part, so it can open the
    // sensor but not close it
    if (this.maintenance && !(standIn && !due)) {
      const C = this.hap.Characteristic;
      this.maintenance.updateCharacteristic(C.ContactSensorState, due
        ? C.ContactSensorState.CONTACT_NOT_DETECTED
        : C.ContactSensorState.CONTACT_DETECTED);
    }
  }

  /**
   * One reading a day of the pages and levels, kept in the cache for the usage
   * figures; and once a week a line in the log with pages printed and how long the
   * toner or ink should last.
   */
  recordUsage(d: PrinterData): void {
    const now = Math.round(Date.now() / 1000);
    const levels: Partial<Record<Color, number>> = Object.fromEntries(d.supplies.map((s) => [s.color, s.level]));
    if (d.totalPages === null && !d.supplies.length) { return; }
    const ctx = this.accessory.context;
    const next = addSample(ctx.usage, now, d.totalPages, levels);
    if (!next) { return; }
    ctx.usage = next;
    const since = ctx.usageLogged ?? next[0].t;
    if (now - since >= 7 * 86400) {
      const week = pagesInLast(next, now, d.totalPages, 7);
      const kind = d.type === 'ink' ? 'Ink' : 'Toner';
      const left = describeLeft(next, now, levels, kind);
      const parts = [week !== null ? `${week} page${week === 1 ? '' : 's'} printed in the last 7 days` : '', left ?? ''].filter(Boolean);
      if (parts.length) { this.log.info(`[${this.name}] ${parts.join('. ')}.`); }
      ctx.usageLogged = now;
    }
    this.api.updatePlatformAccessories([this.accessory]);
  }

  /**
   * Paper trays: a warning when one runs out, and with paperTraySensors one contact
   * sensor per tray that opens when it's empty. Bypass and manual trays, often empty
   * on purpose, get neither.
   */
  applyTrays(trays: Tray[]): void {
    const { Service: S, Characteristic: C } = this.hap;
    const main = trays.filter((t) => !t.secondary);
    for (const t of main) {
      this.warnOnce(`tray-${t.key}`, t.state === 'empty', `${t.name} is out of paper.`);
    }
    if (!this.paperTraySensors) { return; }
    for (const t of main) {
      let svc = this.trays[t.key];
      if (!svc) {
        const name = `${this.name} ${t.name}`;
        svc = this.accessory.getServiceById(S.ContactSensor, TRAY_PREFIX + t.key)
          || this.accessory.addService(S.ContactSensor, name, TRAY_PREFIX + t.key);
        this.label(svc, name);
        if (!svc.testCharacteristic(C.StatusActive)) { svc.addOptionalCharacteristic(C.StatusActive); }
        svc.getCharacteristic(C.StatusActive).updateValue(true);
        this.occupancy.addLinkedService(svc);
        this.guard(svc.getCharacteristic(C.ContactSensorState));
        this.trays[t.key] = svc;
      }
      // Only a tray that says it's empty opens; "some paper" and unknown stay closed
      svc.updateCharacteristic(C.ContactSensorState, t.state === 'empty'
        ? C.ContactSensorState.CONTACT_NOT_DETECTED
        : C.ContactSensorState.CONTACT_DETECTED);
    }
    // Trays the printer no longer lists (a removed paper drawer); not when it listed none
    if (main.length) {
      for (const [key, svc] of Object.entries(this.trays)) {
        if (main.some((t) => t.key === key)) { continue; }
        this.accessory.removeService(svc);
        this.guarded = this.guarded.filter((ch) => !svc.characteristics.includes(ch));
        delete this.trays[key];
      }
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

  /**
   * A reading over IPP while the plugin is set to auto: IPP stands in for SNMP
   * until SNMP answers again, so it only adds to what SNMP showed and doesn't
   * remove sensors, reset readings or change the serial number.
   */
  standIn(d: PrinterData): boolean {
    return this.options.protocol === 'auto' && (d as QueryResult).via === 'ipp' && this.snmpAnswered;
  }

  updateInfo(d: PrinterData): void {
    const { Service: S, Characteristic: C } = this.hap;
    // IPP may format the model and serial number differently; SNMP's stay
    if (this.standIn(d)) { return; }
    const ctx = this.accessory.context;
    let changed = false;
    // A make the plugin can't name shows as "Printer", never as Brother
    const maker = d.manufacturer === null ? 'Printer' : d.manufacturer || 'Brother';
    // The model without the maker's name in front ("EPSON XP-6000 Series" → "XP-6000 Series")
    const model = d.model ? d.model.replace(new RegExp(`^(?:Brother|${maker.replace(/[^\w-]/g, '\\$&')})\\s+`, 'i'), '') : null;
    if (model && model !== ctx.model) { ctx.model = model; changed = true; }
    if (d.manufacturer !== undefined && maker !== (ctx.manufacturer || 'Brother')) { ctx.manufacturer = maker; changed = true; }
    if (this.configSerial && d.serial && d.serial !== this.configSerial) {
      this.warnOnce('config-serial', true, `The serial number in the settings (${this.configSerial}) isn't this `
        + `printer's (${d.serial}). Correct it, or use Test connection in the settings to fill it in.`);
    }
    if (d.serial && d.serial !== ctx.serial) {
      if (ctx.serial) {
        this.log.warn(`[${this.name}] The printer at ${this.options.host} has serial number ${d.serial}, not ${ctx.serial} `
          + 'as before: it looks like a different printer, now shown with this one\'s room and automations in Home. '
          + 'If that\'s not what you want, remove it and add it again (or use Search in the settings).');
      }
      ctx.serial = d.serial;
      changed = true;
    }
    if (!changed) { return; }
    this.accessory.getService(S.AccessoryInformation)!
      .updateCharacteristic(C.Manufacturer, ctx.manufacturer || 'Brother')
      .updateCharacteristic(C.Model, ctx.model || (ctx.manufacturer && ctx.manufacturer !== 'Brother' ? 'Printer' : 'Brother printer'))
      .updateCharacteristic(C.SerialNumber, ctx.serial || this.options.host);
    this.api.updatePlatformAccessories([this.accessory]);
  }
}
