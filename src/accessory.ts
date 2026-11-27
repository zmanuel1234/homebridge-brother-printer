import type {
  API, Characteristic, CharacteristicValue, HAP, HapStatusError, Logging, PlatformAccessory, Service, WithUUID,
} from 'homebridge';
import { format } from 'node:util';
import { isIP } from 'node:net';
import { AUTH_PROTOCOLS, PRIV_PROTOCOLS, protocolSetting, readVia, v3User } from './snmp';
import { readPrinter } from './read';
import { findBySerial } from './discover';
import { ippEndpoint } from './ipp';
import type { PrinterData, QueryOptions, QueryResult } from './snmp';
import { ALL_COLORS, COLOR_NAMES } from './decode';
import type { Color, PartKey, PrinterError, Supply } from './decode';
import { entryDue, startHistory } from './history';
import type { HistoryEntry, HistoryLog } from './history';
import { addSample, daysLeft, describeDays, describeLeft, pagesInLast } from './usage';
import type { UsageSample } from './usage';
import type { Tray } from './trays';
import { monoPages, pageDetail } from './summary';

// Resolved from dist/ at runtime, like the published package
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { version } = require('../package.json') as { version: string };

/** What the plugin keeps in Homebridge's accessory cache */
/** While the printer is offline, how often to look for it at another address (ms) */
const SEARCH_EVERY = 15 * 60 * 1000;
/** How long another printer answers at the address before it's taken as this one (ms) */
const ADOPT_AFTER = 24 * 60 * 60 * 1000;

export interface PrinterContext {
  host?: string;
  model?: string;
  serial?: string;
  /** 'Toner' or 'Ink', once the printer has said */
  kind?: Kind;
  /** The printer reported no supply levels last time */
  noLevels?: boolean;
  /** The printer never answers bulk SNMP requests: its tables are read row by row */
  noBulk?: boolean;
  /** The name in the config when the accessory was last set up */
  name?: string;
  /** As the printer gives it over IPP; Brother otherwise */
  manufacturer?: string;
  /** The printer has answered SNMP (with protocol auto, IPP then only fills in) */
  snmpAnswered?: boolean;
  /** The printer's name before a rename in the config, until its sensors have been relabelled */
  previousName?: string;
  /** One reading a day: pages and levels, for usage and "toner left" estimates */
  usage?: UsageSample[];
  /** When the weekly usage line was last logged (Unix seconds) */
  usageLogged?: number;
  /** The printer's firmware version, when it gives one in a form Home shows (1.14) */
  firmware?: string;
  /**
   * The printer was found at another address by its serial number while the
   * settings still say `from`: it's read at `to` until the settings change
   */
  moved?: { from: string; to: string; ippUrl?: string };
  /** Another printer has answered at the address since then (ms), not this one */
  otherSerial?: { serial: string; since: number };
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
  /** 'light' (default) or 'humidity': the kind of sensor the toner / ink tiles are */
  tileType?: unknown;
  /** 'occupancy' (default) or 'contact': how the printer's own tile shows printing */
  printingSensor?: unknown;
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
/** Page counts beside the total, for apps that show custom characteristics (Eve, Controller) */
const COUNTER_UUIDS = {
  color: 'B0E5A1C2-7D3E-4F1A-9C6B-2E8D4F7A1B31',
  mono: 'B0E5A1C2-7D3E-4F1A-9C6B-2E8D4F7A1B32',
  duplex: 'B0E5A1C2-7D3E-4F1A-9C6B-2E8D4F7A1B33',
} as const;
const COUNTER_NAMES = { color: 'Color Pages', mono: 'Black-and-White Pages', duplex: 'Two-Sided Pages' } as const;
type CounterKey = keyof typeof COUNTER_UUIDS;
type CharacteristicType = WithUUID<new () => Characteristic>;
const counterTypes = new Map<string, CharacteristicType>();

/** A read-only page count characteristic (one class per UUID, made once) */
function counterCharacteristic(hap: HAP, name: string, uuid: string): CharacteristicType {
  const have = counterTypes.get(uuid);
  if (have) { return have; }
  const { Characteristic: Base, Formats, Perms } = hap;
  class Counter extends Base {
    static readonly UUID = uuid;
    constructor() {
      super(name, uuid, {
        format: Formats.UINT32,
        perms: [Perms.PAIRED_READ, Perms.NOTIFY],
        minValue: 0,
        maxValue: 4294967295,
        minStep: 1,
      });
      this.value = this.getDefaultValue();
    }
  }
  counterTypes.set(uuid, Counter);
  return Counter;
}

function pagesCharacteristic(hap: HAP): CharacteristicType {
  return counterCharacteristic(hap, 'Pages Printed', PAGES_UUID);
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
  readonly tonerTile: boolean;
  readonly tileType: 'humidity' | 'light';
  readonly printingSensor: 'occupancy' | 'contact';
  /** Sensor names start with the printer's name (several printers), or are just what they are */
  readonly prefixNames: boolean;
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
  /** The printer's name before a rename in the config, so sensors named after it follow */
  previousName: string | undefined;
  /** Trays whose sensor has been labelled since the start (restored ones get today's names once) */
  labelledTrays = new Set<string>();
  online = true;
  last: LastSeen = {};
  timer: NodeJS.Timeout | null = null;
  stopped = false;
  tiles: Partial<Record<Color, Service>> = {};
  guarded: Characteristic[] = [];

  /** The printer's own tile: printing state, page count, and the other services linked to it */
  main!: Service;
  pages!: Characteristic;
  toner: Service | null = null;
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
  /** The latest reading and when it came (ms), for the dashboard */
  lastReading: QueryResult | null = null;
  lastReadAt = 0;
  /** A search for the printer at another address is running */
  searching = false;
  /** When another printer's serial number last started a search (ms) */
  swapSearchAt = 0;
  /** The address (and IPP address) in the settings */
  readonly configured: { host: string; ippUrl?: string };
  /** Looks for the printer at another address; tests pass their own */
  private readonly find: typeof findBySerial;
  /** Starts the Eve history; tests pass their own */
  private readonly startHistory: typeof startHistory;

  private readonly query: QueryFn;

  constructor(platform: PrinterHost, accessory: PlatformAccessory<PrinterContext>, config: PrinterConfig,
    deps: { query?: QueryFn; startHistory?: typeof startHistory; prefixNames?: boolean; find?: typeof findBySerial } = {}) {
    this.query = deps.query || readPrinter;
    this.find = deps.find || findBySerial;
    this.startHistory = deps.startHistory || startHistory;
    this.platform = platform;
    this.log = platform.log;
    this.api = platform.api;
    this.hap = platform.api.hap;
    this.accessory = accessory;
    this.name = config.name;

    this.options = queryOptions(config);
    this.configured = { host: this.options.host, ippUrl: this.options.ippUrl };
    // Found at another address before a restart, and the settings still have the old one
    const moved = accessory.context.moved;
    if (moved && moved.from === this.options.host) {
      platform.log.info(`[${config.name}] Using ${moved.to}, where the printer was found by its serial number; `
        + `the settings still say ${moved.from}.`);
      this.options.host = moved.to;
      if (moved.ippUrl) { this.options.ippUrl = moved.ippUrl; }
    } else if (moved) {
      delete accessory.context.moved; // the settings have a new address
    }
    // Supplies shown before a restart: a supplies walk that fails on the first poll is a
    // failed poll, not "no supplies" (which would take the battery and tiles away)
    this.options.state!.suppliesRead = accessory.context.noLevels === false;
    // Known from an earlier run: skip the bulk try (and its timeout) after a restart
    if (accessory.context.noBulk) { this.options.state!.noBulk = true; }
    this.interval = setting(config.pollInterval, 60, 10, 3600) * 1000;
    this.lowToner = setting(config.lowTonerThreshold, 10, 0, 100);
    this.lowDrum = setting(config.lowDrumThreshold, 10, 0, 100);
    if (config.showDrum === true) {
      platform.log.info(`[${config.name}] "Drum as a battery" (showDrum) is no longer used: Home shows only one battery `
        + 'per accessory, so the drum battery never showed. The drum is in the Maintenance sensor, the log and Test connection.');
    }
    this.tonerTile = config.tonerTile === true;
    // Light by default: Home counts humidity tiles as the room's humidity. Eve history needs
    // humidity, so with it on and no tileType set, the tiles stay humidity sensors.
    const tileType = String(config.tileType ?? '').trim().toLowerCase();
    this.tileType = tileType === 'humidity' || (!tileType && config.eveHistory === true) ? 'humidity' : 'light';
    this.printingSensor = String(config.printingSensor ?? '').trim().toLowerCase() === 'contact' ? 'contact' : 'occupancy';
    this.prefixNames = deps.prefixNames === true;
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
      const { Service: S, Characteristic: C } = this.hap;
      // The printer's own tile here; its sensors when they're labelled (label() knows
      // the old name). Only names the plugin gave: a name set in the Home app stays.
      // Kept until the sensors are relabelled after a reading, which may be in a later run
      // when the printer is offline now
      acc.context.previousName ??= old;
      for (const svc of acc.services) {
        const own = (svc.UUID === S.OccupancySensor.UUID && !svc.subtype) || (svc.UUID === S.ContactSensor.UUID && svc.subtype === 'printing')
          || svc.UUID === S.AccessoryInformation.UUID;
        if (!own) { continue; }
        for (const type of [C.Name, C.ConfiguredName]) {
          if (svc.testCharacteristic(type) && svc.getCharacteristic(type).value === old) { svc.updateCharacteristic(type, this.name); }
        }
      }
      const named = acc as unknown as { updateDisplayName?: (name: string) => void };
      if (typeof named.updateDisplayName === 'function') { named.updateDisplayName(this.name); }
      this.log.info(`[${this.name}] Renamed from "${old}"; it keeps its room, automations and notifications in Home.`);
    }
    acc.context.name = this.name;
    this.previousName = acc.context.previousName;
  }

  buildServices(): void {
    const { Service: S, Characteristic: C } = this.hap;
    const acc = this.accessory;

    acc.getService(S.AccessoryInformation)!
      .setCharacteristic(C.Manufacturer, acc.context.manufacturer || 'Brother')
      .setCharacteristic(C.Model, acc.context.model || (acc.context.manufacturer ? 'Printer' : 'Brother printer'))
      .setCharacteristic(C.SerialNumber, acc.context.serial || this.options.host)
      .setCharacteristic(C.FirmwareRevision, acc.context.firmware || version);

    // The printer's own tile, showing printing: an occupancy sensor (Detected while a job
    // prints) or a contact sensor (open while a job prints). The other one goes.
    const contact = this.printingSensor === 'contact';
    const occupancy = acc.services.find((svc) => svc.UUID === S.OccupancySensor.UUID && !svc.subtype);
    const printing = acc.getServiceById(S.ContactSensor, 'printing');
    const old = contact ? occupancy : printing;
    if (old) { acc.removeService(old); }
    this.main = (contact ? printing : occupancy)
      || (contact ? acc.addService(S.ContactSensor, this.name, 'printing') : acc.addService(S.OccupancySensor, this.name));
    this.label(this.main, '');
    this.main.setPrimaryService(true);
    for (const ch of [C.StatusActive, C.StatusFault]) {
      if (!this.main.testCharacteristic(ch)) { this.main.addOptionalCharacteristic(ch); }
      this.main.getCharacteristic(ch);
    }
    this.main.getCharacteristic(C.StatusActive).updateValue(true);
    const Pages = pagesCharacteristic(this.hap);
    // testCharacteristic/addCharacteristic are typed for HAP's base class; a subclass works the same
    const PagesClass = Pages as unknown as WithUUID<typeof Characteristic>;
    if (!this.main.testCharacteristic(PagesClass)) { this.main.addCharacteristic(PagesClass); }
    this.pages = this.main.getCharacteristic(Pages);

    // Toner (or ink) as a battery so Home raises its native "low" alert. A printer
    // that reported no levels last time gets none until it reports some.
    if (acc.context.noLevels) {
      this.removeSubtype(S.Battery, 'toner');
      this.toner = null;
    } else {
      this.toner = this.battery('toner', acc.context.kind || 'Toner');
      this.main.addLinkedService(this.toner);
    }

    // Home shows one battery per accessory, so a drum battery never showed: the drum is in
    // the Maintenance sensor, the log and Test connection instead (and showDrum is retired)
    this.removeSubtype(S.Battery, 'drum');

    // Home doesn't surface StatusFault on occupancy sensors, so problems
    // (jam, cover open, no paper...) also open a contact sensor.
    if (this.faultSensor) {
      const problem = acc.getServiceById(S.ContactSensor, 'problem')
        || acc.addService(S.ContactSensor, this.sensorName('Problem'), 'problem');
      this.label(problem, 'Problem');
      if (!problem.testCharacteristic(C.StatusActive)) { problem.addOptionalCharacteristic(C.StatusActive); }
      problem.getCharacteristic(C.StatusActive).updateValue(true);
      this.main.addLinkedService(problem);
      this.problem = problem;
    } else {
      this.removeSubtype(S.ContactSensor, 'problem');
    }

    // Drum and parts (belt, fuser, ...) as one contact sensor, since Home shows
    // only one battery per accessory
    this.maintenance = this.optionalContact(this.maintenanceSensor, 'maintenance', 'Maintenance');
    // Out of paper on its own, the problem people most often fix themselves
    this.paper = this.optionalContact(this.paperSensor, 'noPaper', 'Out of Paper');

    // One sensor per paper tray, made once the printer lists its trays; here only the
    // ones restored from the cache are picked up
    for (const svc of acc.services.filter((s) => s.UUID === S.ContactSensor.UUID && s.subtype?.startsWith(TRAY_PREFIX))) {
      if (this.paperTraySensors) {
        this.trays[svc.subtype!.slice(TRAY_PREFIX.length)] = svc;
        this.main.addLinkedService(svc);
      } else { acc.removeService(svc); }
    }

    // Reachable or not, as a sensor automations can use: a contact sensor "Offline" that
    // opens when the printer stops answering. Home can't trigger on No Response, so this one
    // stays readable while the printer is offline. (Until 0.10 it was an occupancy sensor,
    // "Online", which made the room look occupied.)
    this.removeSubtype(S.OccupancySensor, 'online');
    this.onlineSvc = this.onlineSensor ? this.optionalContact(true, 'offline', 'Offline') : null;
    if (!this.onlineSensor) { this.removeSubtype(S.ContactSensor, 'offline'); }

    // Eve history (fakegato's service) is added when the history starts; take it away when
    // no history will run (turned off, or no humidity tiles for Eve to draw it on), so Eve
    // doesn't keep showing a history nothing adds to
    if (!this.eveHistory || !this.tonerTile || this.tileType !== 'humidity') {
      const historySvc = acc.services.find((svc) => svc.UUID === EVE_HISTORY_SERVICE);
      if (historySvc) { acc.removeService(historySvc); }
    }

    // The low toner sensor is created once the printer says toner or ink;
    // here only one restored from the cache is picked up.
    const lowSvc = acc.getServiceById(S.ContactSensor, 'lowToner');
    if (lowSvc && this.lowTonerSensor) {
      this.lowSensor = lowSvc;
      this.label(lowSvc, `${acc.context.kind || 'Toner'} Low`);
      this.main.addLinkedService(lowSvc);
    } else if (lowSvc) { acc.removeService(lowSvc); }

    // Supply tiles are created once the printer says which colors it has;
    // here only the ones restored from the cache are picked up.
    for (const [color, subtype] of Object.entries(TILE_SUBTYPE) as [Color, string][]) {
      for (const type of [S.HumiditySensor, S.LightSensor]) {
        const svc = acc.getServiceById(type, subtype);
        if (!svc) { continue; }
        if (this.tonerTile && type === this.tileService()) { this.tiles[color] = svc; } else { acc.removeService(svc); }
      }
    }
  }

  /** A contact sensor that's on or off by a setting, kept or removed from the cache */
  optionalContact(enabled: boolean, subtype: string, what: string): Service | null {
    const { Service: S, Characteristic: C } = this.hap;
    if (!enabled) {
      this.removeSubtype(S.ContactSensor, subtype);
      return null;
    }
    const svc = this.accessory.getServiceById(S.ContactSensor, subtype)
      || this.accessory.addService(S.ContactSensor, this.sensorName(what), subtype);
    this.label(svc, what);
    if (!svc.testCharacteristic(C.StatusActive)) { svc.addOptionalCharacteristic(C.StatusActive); }
    svc.getCharacteristic(C.StatusActive).updateValue(true);
    this.main.addLinkedService(svc);
    return svc;
  }

  /** Make one tile per reported supply; remove tiles for colors not reported */
  ensureTiles(d: PrinterData): void {
    if (!this.tonerTile) { return; }
    const C = this.hap.Characteristic;
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
      // "Toner" on a mono printer; "Cyan Toner", "Photo Black Ink" on a color one
      const what = mono ? kind : `${COLOR_NAMES[color]} ${kind}`;
      // Names the plugin gave before 0.10: the printer's name and the color
      const before = [this.name, this.previousName].filter(Boolean).map((n) => `${n} ${mono ? kind : COLOR_NAMES[color]}`);
      if (existing) { this.label(existing, what, before); continue; }
      const svc = this.accessory.addService(this.tileService(), this.sensorName(what), subtype);
      this.label(svc, what, before);
      if (!svc.testCharacteristic(C.StatusActive)) { svc.addOptionalCharacteristic(C.StatusActive); }
      svc.getCharacteristic(C.StatusActive).updateValue(true);
      this.guard(svc.getCharacteristic(this.tileCharacteristic()));
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
    const svc = this.accessory.addService(S.ContactSensor, this.sensorName(`${kind} Low`), 'lowToner');
    this.label(svc, `${kind} Low`);
    if (!svc.testCharacteristic(C.StatusActive)) { svc.addOptionalCharacteristic(C.StatusActive); }
    svc.getCharacteristic(C.StatusActive).updateValue(true);
    this.main.addLinkedService(svc);
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
      [this.main, this.printingSensor === 'contact' ? C.ContactSensorState : C.OccupancyDetected],
      [this.main, C.StatusFault],
      [this.toner, C.BatteryLevel],
      [this.toner, C.StatusLowBattery],
      [this.problem, C.ContactSensorState],
      [this.lowSensor, C.ContactSensorState],
      [this.maintenance, C.ContactSensorState],
      [this.paper, C.ContactSensorState],
      ...Object.values(this.tiles).map((svc): [Service, CharacteristicType] => [svc, this.tileCharacteristic()]),
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

  battery(subtype: string, what: string): Service {
    const { Service: S, Characteristic: C } = this.hap;
    const svc = this.accessory.getServiceById(S.Battery, subtype)
      || this.accessory.addService(S.Battery, this.sensorName(what), subtype);
    this.label(svc, what);
    svc.setCharacteristic(C.ChargingState, C.ChargingState.NOT_CHARGEABLE);
    return svc;
  }

  /**
   * A sensor's name: what it is ("Toner Low", "Tray 1"), with the printer's name in front
   * when there are several printers, so they can be told apart in Home's lists.
   */
  sensorName(what: string): string {
    return !what ? this.name : this.prefixNames ? `${this.name} ${what}` : what;
  }

  /**
   * Name a service. The name is only seeded, or changed from one the plugin gave before
   * (with or without the printer's name in front, or one of `before`): a name the user
   * set in the Home app stays.
   */
  label(svc: Service, what: string, before: string[] = []): void {
    const C = this.hap.Characteristic;
    const name = this.sensorName(what);
    svc.setCharacteristic(C.Name, name);
    if (!svc.testCharacteristic(C.ConfiguredName)) { svc.addOptionalCharacteristic(C.ConfiguredName); }
    const current = svc.getCharacteristic(C.ConfiguredName).value;
    const own = what ? [`${this.name} ${what}`, what, ...(this.previousName ? [`${this.previousName} ${what}`] : []), ...before] : [];
    if (!current || (current !== name && own.includes(String(current)))) { svc.setCharacteristic(C.ConfiguredName, name); }
  }

  /** The toner / ink tiles' sensor type, and the characteristic that shows the level */
  tileService(): ServiceType {
    return this.tileType === 'light' ? this.hap.Service.LightSensor : this.hap.Service.HumiditySensor;
  }

  tileCharacteristic(): CharacteristicType {
    const C = this.hap.Characteristic;
    return this.tileType === 'light' ? C.CurrentAmbientLightLevel : C.CurrentRelativeHumidity;
  }

  /** Show a level on a tile: as % humidity, or as lux (whose lowest value is 0.0001) */
  setTile(svc: Service | undefined, level: number): void {
    if (!svc) { return; }
    const v = clamp(level);
    svc.updateCharacteristic(this.tileCharacteristic(), this.tileType === 'light' ? Math.max(v, 0.0001) : v);
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
      data = await this.failed(errorText(err));
    }
    if (data) { data = await this.checkSerial(data); }
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

  /**
   * A poll that got no reading of this printer. Once offline (and every 15 minutes
   * after), look for it at another address; resolves with its reading there.
   */
  async failed(msg: string): Promise<QueryResult | undefined> {
    this.failures += 1;
    // Another printer counts as taking over only while it keeps answering
    if (this.accessory.context.otherSerial) { this.remember({ otherSerial: undefined }); }
    if (this.failures === this.offlineAfter) {
      this.log.warn(`[${this.name}] Can't reach ${this.options.host} (${msg}). Showing it as offline.`);
      this.setOnline(false);
    } else if (this.debug || this.failures < this.offlineAfter) {
      this.log.debug(`[${this.name}] Poll failed (${this.failures}/${this.offlineAfter}): ${msg}`);
    }
    const every = Math.max(1, Math.round(SEARCH_EVERY / this.interval));
    if (this.failures >= this.offlineAfter && (this.failures - this.offlineAfter) % every === 0) {
      return (await this.findMoved()).data;
    }
    return undefined;
  }

  /**
   * A reading from another printer (its serial number isn't the one this printer
   * gave before): the router gave this printer's old address to another one. It
   * isn't taken as this printer's; this one is looked for by its serial number
   * (every 15 minutes) and shows as offline meanwhile. A printer with a new serial
   * number (a replaced mainboard, or a replaced printer) is taken as this one after
   * answering there for a day, unless the settings name another serial number; at
   * once when its serial number is in the settings.
   */
  async checkSerial(d: QueryResult): Promise<QueryResult | undefined> {
    const ctx = this.accessory.context;
    const norm = (v: string | null | undefined): string => (v ?? '').trim().toUpperCase();
    const seen = norm(d.serial);
    const known = norm(ctx.serial);
    if (!seen || !known || seen === known || this.standIn(d) || seen === norm(this.configSerial)) {
      if (ctx.otherSerial && seen === known) { this.remember({ otherSerial: undefined }); }
      return d;
    }
    const now = Date.now();
    if (ctx.otherSerial?.serial !== seen) {
      this.remember({ otherSerial: { serial: seen, since: now } });
      this.log.warn(`[${this.name}] Another printer (serial number ${d.serial}) answers at ${this.options.host}, not this one `
        + `(${ctx.serial}). Looking for this one on the network; it shows as offline meanwhile. If the printer was replaced `
        + `or repaired and has a new serial number, it's taken as this one right away once its serial number in the `
        + `settings is ${d.serial}${this.configSerial ? '' : ', or after it has answered there for a day'}.`);
    }
    // Never when the settings name this printer's serial number: they say which printer it is
    if (!this.configSerial && now - ctx.otherSerial!.since >= ADOPT_AFTER) {
      this.remember({ otherSerial: undefined });
      return d; // updateInfo takes the new serial number, and says so
    }
    if (now - this.swapSearchAt >= SEARCH_EVERY) {
      this.swapSearchAt = now;
      const elsewhere = await this.findMoved();
      if (elsewhere.data) { return elsewhere.data; }
    }
    // Not counted again toward the offline search above: this check has its own pace
    this.failures += 1;
    if (this.failures === this.offlineAfter) {
      this.log.warn(`[${this.name}] Showing it as offline while another printer answers at its address.`);
      this.setOnline(false);
    }
    return undefined;
  }

  /**
   * Look for the printer by its serial number at another address. When it's
   * there, read it there from now on and say so. Resolves with whether it was
   * found, and its reading there when that read worked.
   */
  async findMoved(): Promise<{ found: boolean; data?: QueryResult }> {
    const serial = (this.accessory.context.serial || this.configSerial).trim();
    // A host name follows the printer by itself (and may just not resolve for a moment)
    if (!serial || this.searching || this.stopped || !isIP(this.configured.host)) { return { found: false }; }
    this.searching = true;
    try {
      const from = this.options.host;
      const hit = await this.find(serial, this.options, from, { model: this.accessory.context.model });
      if (!hit || this.stopped) { return { found: false }; }
      if (hit.host === this.configured.host) {
        // Back where the settings say
        this.options.host = this.configured.host;
        this.options.ippUrl = this.configured.ippUrl;
        this.log.info(`[${this.name}] The printer is back at ${hit.host}, its address in the settings.`);
        this.remember({ moved: undefined });
      } else {
        this.options.host = hit.host;
        if (this.options.protocol !== 'snmp') { this.options.ippUrl = hit.ippUrl; }
        this.log.warn(`[${this.name}] Found the printer (serial number ${serial}) at ${hit.host} instead of ${from}. `
          + `Reading it there now; change its address in the settings to ${hit.host} to keep it there. `
          + 'A reserved address for the printer in your router stops this happening.');
        this.remember({ moved: { from: this.configured.host, to: hit.host, ...(this.options.ippUrl ? { ippUrl: this.options.ippUrl } : {}) } });
      }
      try {
        return { found: true, data: await this.query(this.options) };
      } catch {
        return { found: true };
      }
    } catch (err) {
      this.log.debug(`[${this.name}] Looking for the printer at another address failed: ${errorText(err)}`);
      return { found: false };
    } finally {
      this.searching = false;
    }
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
    this.main.updateCharacteristic(C.StatusActive, online);
    for (const svc of Object.values(this.tiles)) { svc.updateCharacteristic(C.StatusActive, online); }
    if (this.problem) { this.problem.updateCharacteristic(C.StatusActive, online); }
    for (const svc of [this.lowSensor, this.maintenance, this.paper, ...Object.values(this.trays)]) {
      if (svc) { svc.updateCharacteristic(C.StatusActive, online); }
    }
    if (this.onlineSvc) {
      // Offline: open while the printer doesn't answer
      this.onlineSvc.updateCharacteristic(C.ContactSensorState, online
        ? C.ContactSensorState.CONTACT_DETECTED
        : C.ContactSensorState.CONTACT_NOT_DETECTED);
    }
    if (!online) {
      this.setPrinting(false);
      // Push the failure so Home shows "No Response" without waiting for a read
      for (const ch of this.guarded) { ch.updateValue(this.noResponse()); }
    }
  }

  apply(d: QueryResult): void {
    const C = this.hap.Characteristic;
    const log = (m: string): void => (this.debug ? this.log.info(m) : this.log.debug(m));

    log(`[${this.name}] ${JSON.stringify(d)}`);
    this.lastReading = d;
    this.lastReadAt = Date.now();
    if (d.via !== 'ipp' && !this.snmpAnswered) {
      this.snmpAnswered = true;
      this.remember({ snmpAnswered: true });
    }
    // Learnt during a poll: this printer is read row by row; keep it for the next start
    if (this.options.state?.noBulk && !this.accessory.context.noBulk) { this.remember({ noBulk: true }); }
    this.setOnline(true);
    this.updateInfo(d);

    // Printing / fault
    this.setPrinting(d.printing);
    this.main.updateCharacteristic(C.StatusFault, d.fault
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
    // Every sensor has had today's name since the rename: the old name isn't needed any more
    if (this.previousName && !d.suppliesUnread && !this.standIn(d) && (!this.paperTraySensors || d.trays)) {
      this.remember({ previousName: undefined });
    }
    if (d.trays) {
      this.applyTrays(d.trays, this.standIn(d));
    } else if (!this.options.trays && !d.errors.some((e) => e === 'noPaper' || e === 'lowPaper' || e === 'inputTrayEmpty')) {
      // Trays read only while paper is low or out: no paper error means they all have
      // paper, so the next tray to run out is warned about again
      for (const key of Object.keys(this.last.warned || {})) { if (key.startsWith('tray-')) { this.last.warned![key] = false; } }
    }

    if (d.totalPages !== null) { this.pages.updateValue(d.totalPages); }
    this.updateCounters(d);
    this.last.statusText = d.statusText;

    if (this.last.summary === undefined) {
      const kind = d.type === 'ink' ? 'ink' : 'toner';
      const levels = d.suppliesUnread ? 'supply levels not readable this time' : d.supplies.length
        ? d.supplies.map((s) => (d.supplies.length === 1 ? `${kind} ${s.level}%` : `${s.color} ${s.level}%`)).join(', ')
        : `no ${kind} levels reported`;
      const drum = d.drumPercent !== null ? `, drum ${d.drumPercent}%` : '';
      this.log.info(`[${this.name}] Connected to ${d.model || 'printer'} (${readVia(d)}): ${levels}${drum}, `
        + `${d.totalPages ?? '?'} pages${pageDetail(d) ? ` (${pageDetail(d)})` : ''}, status "${d.statusText || 'unknown'}".`);
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
      for (const s of ipp) { this.setTile(this.tiles[s.color], s.level); }
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
      toner = this.battery('toner', kind);
      this.main.addLinkedService(toner);
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
      this.setTile(this.tiles[s.color], s.level);
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
        const days = daysLeft(this.accessory.context.usage, s.color, Math.round(Date.now() / 1000), s.fine ?? s.level);
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
    if (this.tonerTile && this.tileType === 'light') {
      this.warnOnce('history-tiles', true, 'Eve history needs the toner / ink tiles shown as humidity (tileType); '
        + 'Eve draws it on those tiles.');
      return;
    }
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

  /** Maintenance sensor (optional) and log warnings for drums and other parts */
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
    // The finer reading where there is one: some printers count the coarse one in 10% steps
    const levels: Partial<Record<Color, number>> = Object.fromEntries(d.supplies.map((s) => [s.color, s.fine ?? s.level]));
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
   * on purpose, get neither, and nor does a tray whose level isn't known (no sensor
   * that could never open). IPP standing in for SNMP (whose trays may have other
   * names, and often unknown levels) only updates sensors SNMP made, and only to a
   * state it's sure of.
   */
  applyTrays(trays: Tray[], standIn = false): void {
    const { Service: S, Characteristic: C } = this.hap;
    // Main trays, and any tray that already has a sensor (it was a main tray when made)
    const main = trays.filter((t) => !t.secondary || this.trays[t.key]);
    for (const t of main) {
      if (standIn && t.state !== 'empty') { continue; }
      this.warnOnce(`tray-${t.key}`, t.state === 'empty', `${t.name} is out of paper.`);
    }
    if (!this.paperTraySensors) { return; }
    // A tray keeps its sensor once it has one, even if a reading takes it for a bypass
    // tray (its status can change as it empties); new sensors only for main trays
    for (const t of trays) {
      let svc = this.trays[t.key];
      if (!svc && (standIn || t.secondary || t.state === 'unknown')) { continue; }
      if (svc && !standIn && !this.labelledTrays.has(t.key)) { this.label(svc, t.name); this.labelledTrays.add(t.key); }
      if (standIn && t.state === 'unknown') { continue; }
      if (!svc) {
        svc = this.accessory.getServiceById(S.ContactSensor, TRAY_PREFIX + t.key)
          || this.accessory.addService(S.ContactSensor, this.sensorName(t.name), TRAY_PREFIX + t.key);
        this.label(svc, t.name);
        if (!svc.testCharacteristic(C.StatusActive)) { svc.addOptionalCharacteristic(C.StatusActive); }
        svc.getCharacteristic(C.StatusActive).updateValue(true);
        this.main.addLinkedService(svc);
        this.guard(svc.getCharacteristic(C.ContactSensorState));
        this.trays[t.key] = svc;
      }
      // Only a tray that says it's empty opens; an unknown level leaves the sensor as it was
      if (t.state === 'unknown') { continue; }
      svc.updateCharacteristic(C.ContactSensorState, t.state === 'empty'
        ? C.ContactSensorState.CONTACT_NOT_DETECTED
        : C.ContactSensorState.CONTACT_DETECTED);
    }
    // Trays the printer no longer lists (a removed paper drawer); not when it listed none
    if (trays.length && !standIn) {
      for (const [key, svc] of Object.entries(this.trays)) {
        if (trays.some((t) => t.key === key)) { continue; }
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
    const was = this.accessory.context.kind || 'Toner';
    if (was === kind) { return; }
    this.label(toner, kind, [`${this.name} ${was}`, was]);
    if (this.lowSensor) { this.label(this.lowSensor, `${kind} Low`, [`${this.name} ${was} Low`, `${was} Low`]); }
  }

  /** The printer's own tile: Detected (occupancy) or open (contact) while a job prints */
  setPrinting(printing: boolean): void {
    const C = this.hap.Characteristic;
    if (this.printingSensor === 'contact') {
      this.main.updateCharacteristic(C.ContactSensorState, printing
        ? C.ContactSensorState.CONTACT_NOT_DETECTED : C.ContactSensorState.CONTACT_DETECTED);
    } else {
      this.main.updateCharacteristic(C.OccupancyDetected, printing
        ? C.OccupancyDetected.OCCUPANCY_DETECTED : C.OccupancyDetected.OCCUPANCY_NOT_DETECTED);
    }
  }

  /** Store values in the accessory cache, saving only when something changed */
  remember(values: Partial<PrinterContext>): void {
    const ctx = this.accessory.context as Record<string, unknown>;
    const changed = Object.entries(values).filter(([k, v]) => ctx[k] !== v);
    if (!changed.length) { return; }
    for (const [k, v] of changed) { ctx[k] = v; }
    this.api.updatePlatformAccessories([this.accessory]);
  }

  /**
   * A reading over IPP while the plugin is set to auto: IPP stands in for SNMP
   * until SNMP answers again, so it only adds to what SNMP showed and doesn't
   * remove sensors, reset readings or change the serial number.
   */
  standIn(d: PrinterData): boolean {
    return this.options.protocol === 'auto' && (d as QueryResult).via === 'ipp' && this.snmpAnswered;
  }

  /**
   * Color, black-and-white and two-sided page counts, when the printer gives them:
   * characteristics on the printer's tile, added the first time each is reported
   * (and kept). Eve and Controller show them; Apple's Home app doesn't.
   */
  updateCounters(d: PrinterData): void {
    if (this.standIn(d)) { return; }
    const values: Record<CounterKey, number | null | undefined> = {
      color: d.colorPages, mono: monoPages(d), duplex: d.duplexPages,
    };
    for (const key of Object.keys(values) as CounterKey[]) {
      const value = values[key];
      if (typeof value !== 'number' || value < 0) { continue; }
      const type = counterCharacteristic(this.hap, COUNTER_NAMES[key], COUNTER_UUIDS[key]);
      const asBase = type as unknown as WithUUID<typeof Characteristic>;
      if (!this.main.testCharacteristic(asBase)) { this.main.addCharacteristic(asBase); }
      this.main.getCharacteristic(type).updateValue(Math.min(value, 4294967295));
    }
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
    // The printer's firmware where it's a version Home shows (1.14, 01.35; HomeKit wants
    // up to three numbers); otherwise the plugin's version, as before
    const fw = d.firmware?.trim() ?? '';
    if (/^\d+(\.\d+){0,2}$/.test(fw)) {
      if (fw !== ctx.firmware) { ctx.firmware = fw; changed = true; }
    } else if (fw && ctx.firmware) {
      // A version Home can't show (or another printer): the plugin's again
      delete ctx.firmware;
      changed = true;
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
      .updateCharacteristic(C.SerialNumber, ctx.serial || this.options.host)
      .updateCharacteristic(C.FirmwareRevision, ctx.firmware || version);
    this.api.updatePlatformAccessories([this.accessory]);
  }
}
