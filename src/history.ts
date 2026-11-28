/*
 * Toner / ink history for the Eve app, through fakegato-history.
 *
 * Eve draws history for the characteristics it recognises; for a printer the
 * one that fits is the humidity of the toner tiles (whose value is the level).
 * fakegato keeps one history per accessory and gives it to every tile, so on a
 * color printer each tile's graph shows the lowest color, like the battery.
 *
 * fakegato-history loads Google's API client when it's loaded, which is slow on a
 * Raspberry Pi, so it's only loaded for printers that have history turned on.
 */
import type { API, PlatformAccessory } from 'homebridge';
import { createRequire } from 'node:module';

export interface HistoryEntry {
  time: number;
  humidity?: number;
}

export interface HistoryLog {
  addEntry(entry: HistoryEntry): void;
  /** fakegato drops entries until it has read the saved history */
  isHistoryLoaded?(): boolean;
}

type FakeGatoHistory = new (type: string, accessory: PlatformAccessory, options: Record<string, unknown>) => HistoryLog;

/** One entry every 10 minutes, as Eve expects; about 60 days */
export const HISTORY_INTERVAL = 10 * 60;
export const HISTORY_SIZE = 8640;

let FakeGato: FakeGatoHistory | undefined;

/** fakegato-history's history class, loaded on first use */
export function fakeGato(api: API): FakeGatoHistory {
  if (!FakeGato) {
    const factory = createRequire(import.meta.url)('fakegato-history') as (homebridge: API) => FakeGatoHistory;
    FakeGato = factory(api);
  }
  return FakeGato;
}

/**
 * Start the history for an accessory. It must already have the services whose
 * history Eve should show (the toner tiles): fakegato looks at them only here.
 */
export function startHistory(api: API, accessory: PlatformAccessory, log: { debug(...args: unknown[]): void }): HistoryLog {
  const History = fakeGato(api);
  return new History('custom', accessory, {
    size: HISTORY_SIZE,
    // The plugin adds entries itself (every 10 minutes and on a change);
    // fakegato's own timer only repeats averaged values, not these.
    disableTimer: true,
    storage: 'fs',
    path: api.user.storagePath(),
    // Named after the accessory's UUID, not its name, so renaming keeps it
    filename: `homebridge-brother-printer-${accessory.UUID}-history.json`,
    log,
  });
}

/** Whether a new entry is due: the level changed, or 10 minutes have passed */
export function entryDue(last: HistoryEntry | undefined, now: number, level: number): boolean {
  return !last || last.humidity !== level || now - last.time >= HISTORY_INTERVAL;
}
