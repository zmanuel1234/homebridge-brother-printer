/*
 * Supplies ("markers") as printers list them in standard form: over IPP
 * (marker-names, marker-types, marker-colors, marker-levels) and over SNMP in
 * the Printer MIB (prtMarkerSuppliesTable). Both give a name, a type, a color
 * hint and a level against a maximum; this turns them into the plugin's
 * readings: supply levels per color, drums and other parts.
 */
import { ALL_COLORS } from './decode';
import type { Color, Drum, Part, PartKey, Supply } from './decode';

export interface Marker {
  name: string;
  /** Keyword in kebab case: toner, ink-cartridge, opc, waste-toner, fuser, transfer-unit… or '' */
  type: string;
  /** #RRGGBB (several for a multi-color cartridge), a colorant name, or '' */
  colors: string;
  level: number | null;
  /** The level that means full; null: 100 */
  high: number | null;
}

export interface MarkerReadings {
  supplies: Supply[];
  lowestSupply: Supply | null;
  drums: Partial<Record<Color, Drum>>;
  parts: Partial<Record<PartKey, Part>>;
  /** An ink printer, by its supplies */
  ink: boolean;
}

// Color words beyond English, for printers that name supplies in their language
const WORDS: [RegExp, Color][] = [
  [/\b(black|schwarz|noir|nero|negro|preto|zwart|czarny|svart|musta)\b/, 'black'],
  [/\b(cyan|cian|ciano|cyaan|cyjan)\b/, 'cyan'],
  [/\b(magenta|magentarot)\b/, 'magenta'],
  [/\b(yellow|gelb|jaune|giallo|amarillo|amarelo|geel|żółty|zolty|gul|keltainen)\b/, 'yellow'],
  // Chinese, Japanese and Korean names (no word boundaries)
  [/黑|ブラック|黒|검정|블랙/, 'black'],
  [/青|シアン|시안/, 'cyan'],
  [/洋紅|品紅|品红|洋红|マゼンタ|마젠타/, 'magenta'],
  [/黃|黄|イエロー|노랑|옐로/, 'yellow'],
];

/**
 * A marker's color, from its name first (printers name them well: "Photo Black
 * ink", "light black ink", "Black(PGBK)", "BK", "tri-color ink", "Patrone
 * Schwarz"), then from its color hint (#RRGGBB, several for a multi-color
 * cartridge, or a colorant name such as "cyan").
 */
export function markerColor(name: string, colors: string, supply = true): Color | null {
  const n = name.toLowerCase();
  if (/tri-?colou?r|\bcmy\b|\bcolou?r ink\b/.test(n)) { return 'tricolor'; }
  // PK / PBK photo black, MK matte black (PB is Canon's photo *blue*: no tile)
  // (not a part number such as Kyocera's PK-3010S)
  if (/photo\s*black|\bpbk\b|\bpk\b(?![-\d])/.test(n)) { return 'photoBlack'; }
  if (/matte\s*black|\bmk\b(?![-\d])/.test(n)) { return 'black'; }
  if (/light\s*black|\bl?gy\b/.test(n) || (/gr[ae]y|\bgrau\b|\bgris\b/.test(n) && !/black/.test(n))) { return 'gray'; }
  if (/light\s*cyan|photo\s*cyan|\blc\b/.test(n)) { return 'lightCyan'; }
  if (/light\s*magenta|photo\s*magenta|\blm\b/.test(n)) { return 'lightMagenta'; }
  for (const [re, color] of WORDS) { if (re.test(n)) { return color; } }
  const code = /\b(pgbk|bk|k|c|m|y)\b(?![-\d])/.exec(n)?.[1];
  if (code) { return ({ pgbk: 'black', bk: 'black', k: 'black', c: 'cyan', m: 'magenta', y: 'yellow' } as Record<string, Color>)[code]; }
  // Several colors for one marker: a tri-color cartridge (for a drum: shared, no color)
  const hexes = colors.match(/#[0-9a-f]{6}/gi) || [];
  if (hexes.length > 1) { return supply ? 'tricolor' : null; }
  if (hexes.length === 1) { return hexColor(colors); }
  // A colorant name (Printer MIB prtMarkerColorantValue): "black", "cyan"…
  const c = colors.toLowerCase();
  for (const [re, color] of WORDS) { if (re.test(c)) { return color; } }
  return null;
}

/** The nearest supply color to a #RRGGBB value (printers use their own shades, e.g. #00CFFF) */
export function hexColor(value: string): Color | null {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(value.trim());
  if (!m) { return null; }
  const [r, g, b] = m.slice(1).map((h) => parseInt(h, 16) / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max - min < 0.15) {
    // White (#FFFFFF exactly) is a placeholder some printers send for black
    if (/^#ffffff$/i.test(value.trim())) { return 'black'; }
    return max < 0.25 ? 'black' : max > 0.9 ? null : 'gray';
  }
  const light = min > 0.4;
  if (b >= max - 0.15 && g >= max - 0.3 && r < max - 0.3) { return light ? 'lightCyan' : 'cyan'; }
  if (r >= max - 0.15 && b >= max - 0.3 && g < max - 0.3) { return light ? 'lightMagenta' : 'magenta'; }
  if (r >= max - 0.15 && g >= max - 0.3 && b < max - 0.3) { return 'yellow'; }
  return null;
}

/** A part that isn't a supply or a drum, by its type or name */
export function partKey(name: string, type: string): PartKey | null {
  const n = name.toLowerCase();
  if (type === 'maintenance-kit' || /maintenance kit/.test(n)) { return 'maintenanceKit'; }
  if (type === 'waste-ink' || (/waste/.test(n) && /\bink\b/.test(n))) { return 'inkWasteBox'; }
  if (type === 'waste-toner' || (type === '' || type === 'other' || type === 'unknown') && /waste|廃|廢|废|폐/.test(n)) { return 'wasteToner'; }
  if (type === 'fuser' || /fuser|fusing/.test(n)) { return 'fuser'; }
  if (type === 'developer' || /developer/.test(n)) { return 'developer'; }
  if (/transfer|belt/.test(type) || /belt|transfer (kit|unit|roller)/.test(n)) { return 'belt'; }
  if (/laser (unit|scanner)/.test(n)) { return 'laser'; }
  if (/feed/.test(n) && !/document|adf/.test(n)) { return /mp/.test(n) ? 'paperFeedMP' : 'paperFeed1'; }
  return null;
}

export const SUPPLY_TYPE = /^(toner|ink|ink-cartridge|toner-cartridge|solid-wax|ribbon-wax)$/;
/** Untyped markers (some printers leave the type out): a supply by its name, unless it names a part */
const PART_WORDS = /waste|drum|developer|fus(er|ing)|belt|roll|filter|maintenance|kit|imaging|staple|collection|廢|废|廃|폐/i;
const isSupply = (m: Marker): boolean =>
  SUPPLY_TYPE.test(m.type) || ((m.type === '' || m.type === 'other' || m.type === 'unknown')
    && /toner|ink\b|ink |cartridge|patrone|cartouche|碳粉|墨|トナー|インク|토너|잉크/i.test(m.name) && !PART_WORDS.test(m.name));

/** Supply, drum and part readings from a printer's markers */
export function mapMarkers(markers: Marker[]): MarkerReadings {
  const supplies: Supply[] = [];
  const drums: Partial<Record<Color, Drum>> = {};
  const parts: Partial<Record<PartKey, Part>> = {};
  const percentOf = (m: Marker): number | null => {
    const high = m.high ?? 100;
    // -1 unavailable, -2 unknown, -3 "some remaining": no number to show
    return m.level !== null && m.level >= 0 && high > 0 ? Math.max(0, Math.min(100, Math.round(m.level * 100 / high))) : null;
  };

  // A printer with one supply and no color for it is a mono printer: black
  const onlyOne = markers.filter(isSupply).length === 1;
  // Supply colors first, to sort out several blacks. Numbered ones ("Black Toner
  // 1", "Black Toner 2") are the same black; otherwise Canon's pigment black
  // (PGBK) is the black and its dye black the photo black, or the first black is
  // the black and a second one the photo black. More are left out.
  const supplyColor = markers.map((m) => (isSupply(m) ? markerColor(m.name, m.colors) ?? (onlyOne ? 'black' : null) : null));
  const plain = (s: string): string => s.toLowerCase().replace(/\s*\d+\s*$/, '');
  const blackIdx = supplyColor.flatMap((c, i) => (c === 'black' ? [i] : []))
    .filter((i, k, all) => !all.slice(0, k).some((j) => plain(markers[j].name) === plain(markers[i].name)));
  if (blackIdx.length > 1) {
    const pigment = blackIdx.find((i) => /pgbk|pigment/i.test(markers[i].name)) ?? blackIdx[0];
    const others = blackIdx.filter((i) => i !== pigment);
    if (!supplyColor.includes('photoBlack')) { supplyColor[others.shift()!] = 'photoBlack'; }
    for (const i of others) { supplyColor.forEach((c, j) => { if (c === 'black' && plain(markers[j].name) === plain(markers[i].name)) { supplyColor[j] = null; } }); }
  }

  let ink = false;
  markers.forEach((m, i) => {
    const percent = percentOf(m);
    if (/ink/.test(m.type)) { ink = true; }
    if (isSupply(m)) {
      if (/\bink\b/i.test(m.name)) { ink = true; }
      const color = supplyColor[i];
      if (percent === null || !color) { return; }
      // The same color twice (two black toners): the lower one counts
      const have = supplies.find((s) => s.color === color);
      if (!have) { supplies.push({ color, level: percent, fine: null }); } else if (percent < have.level) { have.level = percent; }
      return;
    }
    const color = markerColor(m.name, m.colors, false);
    if (m.type === 'opc' || m.type === 'photo-conductor' || /drum|imaging unit|photoconductor/i.test(m.name)) {
      if (percent !== null) {
        const key = color || 'black';
        drums[key] = { percent: Math.min(percent, drums[key]?.percent ?? 100) };
      }
      return;
    }
    const key = partKey(m.name, m.type);
    if (key && percent !== null) { parts[key] = { percent: Math.min(percent, parts[key]?.percent ?? 100) }; }
  });
  supplies.sort((x, y) => ALL_COLORS.indexOf(x.color) - ALL_COLORS.indexOf(y.color));
  const lowestSupply = supplies.length ? supplies.reduce((x, y) => (y.level < x.level ? y : x)) : null;
  return { supplies, lowestSupply, drums, parts, ink: ink || !!parts.inkWasteBox };
}

const MAKERS: Record<string, string> = {
  'hewlett-packard': 'HP', 'hewlett packard': 'HP', hp: 'HP', epson: 'Epson', canon: 'Canon', brother: 'Brother',
  samsung: 'Samsung', kyocera: 'Kyocera', 'kyocera mita': 'Kyocera', xerox: 'Xerox', 'fuji xerox': 'Fujifilm',
  fujifilm: 'Fujifilm', fuji: 'Fujifilm', lexmark: 'Lexmark', ricoh: 'Ricoh', oki: 'OKI', 'oki data': 'OKI', sharp: 'Sharp',
  konica: 'Konica Minolta', 'konica minolta': 'Konica Minolta', dell: 'Dell', utax: 'Utax', ta_utax: 'Utax',
  'triumph-adler': 'Triumph-Adler', toshiba: 'Toshiba', develop: 'Develop',
};

/** The maker's name: from a maker field, or the start of the model name, tidied ("EPSON" → "Epson") */
export function manufacturerOf(mfg: string, model: string): string | null {
  const known = (s: string): string | undefined => {
    const words = s.trim().toLowerCase().split(/\s+/);
    return MAKERS[words.slice(0, 2).join(' ')] ?? MAKERS[words[0] ?? ''];
  };
  if (mfg) { return known(mfg) ?? mfg.trim(); }
  const byModel = known(model);
  if (byModel) { return byModel; }
  // Model names that don't start with the maker
  if (/^(?:CNMF|imageCLASS|imageRUNNER|PIXMA|MAXIFY|i-SENSYS|LBP)/i.test(model)) { return 'Canon'; }
  if (/^(?:ECOSYS|TASKalfa)/i.test(model)) { return 'Kyocera'; }
  if (/^(?:MFC|DCP|HL)-/i.test(model)) { return 'Brother'; }
  if (/^(?:OfficeJet|DeskJet|LaserJet|ENVY|Photosmart|PageWide)/i.test(model)) { return 'HP'; }
  if (/^(?:bizhub)/i.test(model)) { return 'Konica Minolta'; }
  if (/^(?:Aficio)/i.test(model)) { return 'Ricoh'; }
  if (/^(?:WorkCentre|Phaser|VersaLink|AltaLink|ColorQube|DocuCentre)/i.test(model)) { return 'Xerox'; }
  if (/^(?:FAX-)/i.test(model)) { return 'Brother'; }
  return null;
}
