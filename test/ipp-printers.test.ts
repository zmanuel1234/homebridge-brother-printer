// IPP (AirPrint) reading against answers recorded from real printers of
// several brands (test/fixtures/ipp, from python-ipp and HP's jipp).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { manufacturerOf, markerColor, parseResponse, toPrinterData } from '../src/ipp';
import type { PrinterData } from '../src/snmp';

const read = (file: string): PrinterData =>
  toPrinterData(parseResponse(readFileSync(join(__dirname, 'fixtures', 'ipp', `${file}.bin`))).printer);
const levels = (d: PrinterData): string => d.supplies.map((s) => `${s.color} ${s.level}`).join(', ');

/** What each printer should read as: supplies in display order, type, problems */
const PRINTERS: Record<string, { model: string; levels: string; type: 'ink' | 'laser'; errors?: string[]; fault?: boolean; parts?: object }> = {
  'brother-mfc-j5320dw': { model: 'Brother MFC-J5320DW', levels: 'black 11, cyan 9, magenta 11, yellow 45', type: 'ink', errors: ['lowToner'] },
  'brother-mfc-j870dw': { model: 'Brother MFC-J870DW', levels: 'black 41, cyan 16, magenta 29, yellow 19', type: 'ink', errors: ['lowToner'] },
  'canon-ts6000': { model: 'Canon TS6000 series', levels: 'black 80, cyan 80, magenta 80, yellow 80, photoBlack 90', type: 'ink' },
  'canon-mf6100-series': { model: 'CNMF6100 Series', levels: 'black 7', type: 'laser', errors: ['lowToner'] },
  'epson-xp-6000': { model: 'EPSON XP-6000 Series', levels: 'black 64, cyan 99, magenta 83, yellow 6, photoBlack 27', type: 'ink', errors: ['lowToner'] },
  'hp-officejet-pro-6830': { model: 'HP Officejet Pro 6830', levels: 'black 20, cyan 20, magenta 20, yellow 20', type: 'ink', errors: ['lowToner'] },
  'hp-officejet-4630': { model: 'HP Officejet 4630 series', levels: 'black 80, tricolor 20', type: 'ink', errors: ['lowToner'] },
  'photosmart-7520': { model: 'HP Photosmart 7520 series', levels: 'black 20, cyan 20, magenta 20, yellow 20, gray 0', type: 'ink', errors: ['lowToner'] },
  'hp-laserjet-m605': { model: 'HP LaserJet M605', levels: 'black 100', type: 'laser', parts: { maintenanceKit: { percent: 100 } } },
  'hp-color-laserjet-mfp-m181fw': { model: 'HP ColorLaserJet MFP M178-M181', levels: '', type: 'laser' },
  'samsung-c1860-series': { model: 'Samsung C1860 Series', levels: 'black 79, cyan 74, magenta 73, yellow 69', type: 'laser' },
  'hp-officejet-250-mobile-series': { model: 'HP OfficeJet 250 Mobile Series', levels: 'black 90, tricolor 20', type: 'ink', errors: ['noPaper'], fault: true },
  'hp-laserjet-400-colormfp-m475dw': { model: 'HP LaserJet 400 colorMFP M475dw', levels: 'black 70, cyan 96, magenta 96, yellow 96', type: 'laser' },
  'kyocera-ecosys-m2540dn': { model: 'ECOSYS M2540dn', levels: '', type: 'laser' },
};

for (const [file, want] of Object.entries(PRINTERS)) {
  test(`real printer over IPP: ${want.model}`, () => {
    const d = read(file);
    assert.equal(d.model, want.model);
    assert.equal(levels(d), want.levels);
    assert.equal(d.type, want.type);
    assert.deepEqual(d.errors, want.errors ?? []);
    assert.equal(d.fault, want.fault ?? false);
    if (want.parts) { assert.deepEqual(d.parts, want.parts); }
    // The battery shows the lowest supply
    if (d.supplies.length) { assert.equal(d.lowestSupply?.level, Math.min(...d.supplies.map((s) => s.level))); }
  });
}

test('real printers over IPP: idle ones aren\'t printing, and nothing reads as "null"', () => {
  for (const file of Object.keys(PRINTERS)) {
    const d = read(file);
    assert.equal(JSON.stringify(d).includes('null,') && /"(model|statusText)":"null"/.test(JSON.stringify(d)), false, file);
    if (file !== 'hp-officejet-250-mobile-series') { assert.equal(d.printing, false, file); }
  }
});

test('marker colors: names first, then the nearest color', () => {
  const cases: [string, string, string | null][] = [
    ['Photo Black ink', '#000000', 'photoBlack'],
    ['light black ink', '#101010', 'gray'],
    ['Light Cyan ink', '#7FFFFF', 'lightCyan'],
    ['LM', '', 'lightMagenta'],
    ['tri-color ink', '#00FFFF#FF00FF#FFFF00', 'tricolor'],
    ['Color', '#00FFFF#FF00FF#FFFF00', 'tricolor'],
    ['Black(PGBK)', '#000000', 'black'],
    ['BK', '#000000', 'black'],
    ['Magenta', '#F200FF', 'magenta'],
    ['', '#00CFFF', 'cyan'],
    ['', '#FFDA00', 'yellow'],
    ['', '#808080', 'gray'],
    ['', '#FFFFFF', 'black'],
    ['', '#99FFFF', 'lightCyan'],
    ['Maintenance Kit', 'none', null],
  ];
  for (const [name, colors, want] of cases) { assert.equal(markerColor(name, colors), want, `${name} ${colors}`); }
});

test('real printers over IPP: the maker, for Home\'s accessory details', () => {
  const makers = Object.fromEntries(Object.keys(PRINTERS).map((f) => [f, read(f).manufacturer]));
  assert.deepEqual(makers, {
    'brother-mfc-j5320dw': 'Brother', 'brother-mfc-j870dw': 'Brother', 'canon-ts6000': 'Canon', 'canon-mf6100-series': 'Canon',
    'epson-xp-6000': 'Epson', 'hp-officejet-pro-6830': 'HP', 'hp-officejet-4630': 'HP', 'photosmart-7520': 'HP',
    'hp-laserjet-m605': 'HP', 'hp-color-laserjet-mfp-m181fw': 'HP', 'samsung-c1860-series': 'Samsung',
    'hp-officejet-250-mobile-series': 'HP', 'hp-laserjet-400-colormfp-m475dw': 'HP', 'kyocera-ecosys-m2540dn': 'Kyocera',
  });
  assert.equal(manufacturerOf('', 'Something 123'), null);
  assert.equal(manufacturerOf('ACME', 'Something 123'), 'ACME');
});
