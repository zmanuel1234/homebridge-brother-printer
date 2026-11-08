// Decodes real SNMP captures from 14 Brother models and checks the result
// against the values the bieniu/brother library (Apache-2.0) decodes from the
// same captures. See test/fixtures/README.md.

import test from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../src/snmp';
import type { PrinterData, RawReadings } from '../src/snmp';
import type { Color, PartKey } from '../src/decode';
import modelsJson from './fixtures/brother-models.json';

interface ModelFixture {
  type: string;
  raw: RawReadings;
  expected: Record<string, unknown>;
}
const models = modelsJson as unknown as Record<string, ModelFixture>;

const camel = (s: string): string => s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
const PART_KEYS: Record<string, PartKey> = {
  belt_unit: 'belt', fuser: 'fuser', fuser_unit: 'fuser', laser: 'laser', laser_unit: 'laser',
  pf_kit_1: 'paperFeed1', pf_kit_mp: 'paperFeedMP', ink_capture_box: 'inkWasteBox',
};

/** Where each reference field lives in our parse() result */
function ours(r: PrinterData, field: string): unknown {
  let m: RegExpExecArray | null;
  if ((m = /^(black|cyan|magenta|yellow)_(toner|ink)$/.exec(field))) {
    const color = m[1] as Color;
    return r.supplies.find((s) => s.color === color)?.level;
  }
  if ((m = /^(black|cyan|magenta|yellow)_(toner|ink)_remaining$/.exec(field))) {
    const color = m[1] as Color;
    return r.supplies.find((s) => s.color === color)?.fine;
  }
  if ((m = /^(?:(black|cyan|magenta|yellow)_)?drum_remaining_(life|pages)$/.exec(field))) {
    const d = r.drums[(m[1] || 'black') as Color] || {};
    return m[2] === 'life' ? d.percent : d.pagesRemaining;
  }
  if ((m = /^(belt_unit|fuser|fuser_unit|laser|laser_unit|pf_kit_1|pf_kit_mp|ink_capture_box)_remaining_(life|pages)$/.exec(field))) {
    const p = r.parts[PART_KEYS[m[1]]] || {};
    return m[2] === 'life' ? p.percent : p.pagesRemaining;
  }
  switch (field) {
    case 'page_counter': return r.totalPages;
    case 'color_counter': return r.colorPages;
    case 'duplex_unit_pages_counter': return r.duplexPages;
    case 'status': return r.statusText.toLowerCase();
    case 'printer_status': {
      const names: Record<number, string> = { 1: 'other', 2: 'unknown', 3: 'idle', 4: 'printing', 5: 'warmup' };
      return r.printerStatus === null ? undefined : names[r.printerStatus];
    }
    default: return undefined;
  }
}

// Fields we read differently on purpose, or don't read
const SKIP = new Set([
  'bw_counter', 'black_counter', 'cyan_counter', 'magenta_counter', 'yellow_counter', 'image_counter',
  'drum_counter', 'black_drum_counter', 'cyan_drum_counter', 'magenta_drum_counter', 'yellow_drum_counter',
  'drum_status', 'device_status', 'uptime',
  // supply status codes aren't used by the plugin
  'black_toner_status', 'cyan_toner_status', 'magenta_toner_status', 'yellow_toner_status',
  'black_ink_status', 'cyan_ink_status', 'magenta_ink_status', 'yellow_ink_status',
]);

for (const [model, fx] of Object.entries(models)) {
  test(`${model}: decodes like the reference library`, () => {
    const r = parse(fx.raw);
    assert.equal(r.type, fx.type, 'printer type');

    let checked = 0;
    for (const [field, want] of Object.entries(fx.expected)) {
      if (SKIP.has(field) || field === 'printer_errors') { continue; }
      const got = ours(r, field);
      assert.notEqual(got, undefined, `${field} isn't decoded (expected ${want})`);
      if (typeof want === 'number' && /remaining(_life)?$|_toner$|_ink$/.test(field)) {
        // The reference rounds half to even, we round half up
        assert.ok(Math.abs((got as number) - want) <= 1, `${field}: got ${got}, expected ${want}`);
      } else {
        assert.equal(got, want, field);
      }
      checked += 1;
    }
    if (Object.keys(fx.expected).length) { assert.ok(checked > 0, 'nothing compared'); }
  });
}

test('dcp-l3550cdw: color laser battery is the lowest color, ties broken by the finer reading', () => {
  const r = parse(models['dcp-l3550cdw'].raw);
  assert.deepEqual(r.supplies.map((s) => s.color), ['black', 'cyan', 'magenta', 'yellow']);
  // C, M and Y all read 10% coarse; yellow is 2% fine, and the display says yellow is low
  assert.equal(r.lowestSupply?.color, 'yellow');
  assert.equal(r.lowestSupply?.level, 10);
  assert.equal(r.supplies.find((s) => s.color === 'yellow')?.fine, 2);
  assert.deepEqual(r.errors.map(camel), ['lowToner', 'doorOpen']);
  assert.equal(r.statusText, 'Mało toneru (Y)');
});

test('mfc-t910dw: ink tank printer reports no levels', () => {
  const r = parse(models['mfc-t910dw'].raw);
  assert.equal(r.type, 'ink');
  assert.deepEqual(r.supplies, []);
  assert.equal(r.lowestSupply, null);
  assert.equal(r.totalPages, 3384);
});

test('mfc-5490cn: legacy current/max records', () => {
  const r = parse(models['mfc-5490cn'].raw);
  assert.deepEqual(r.supplies.map((s) => [s.color, s.level]), [['black', 20], ['cyan', 60], ['magenta', 30], ['yellow', 55]]);
});

test('hl-5350dn: old laser with short records and page count from the Printer MIB', () => {
  const r = parse(models['hl-5350dn'].raw);
  assert.equal(r.type, 'laser');
  assert.equal(r.totalPages, 69411);
  assert.equal(r.drums.black?.pagesRemaining, 0);
  assert.deepEqual(r.supplies, []);
});

test('mfc-j680dw: page count from mono + color when there is no total', () => {
  const r = parse(models['mfc-j680dw'].raw);
  assert.equal(r.totalPages, 0x1cd + 0x1eb);
});
