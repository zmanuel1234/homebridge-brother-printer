'use strict';

/**
 * Brother printers pack maintenance data into OctetString "blobs" made of
 * records:  [code(1)] [0x01] [length(1)] [value(length bytes, big-endian)]
 * terminated by 0xFF.
 *
 * Record codes below were verified against an MFC-L2750DW (mono laser) by
 * comparing SNMP output with the printer's own "Remaining Life" web page.
 */

const MAINTENANCE = {
  0x11: { key: 'drumPagesUsed', scale: 1 },
  0x41: { key: 'drumPercent', scale: 0.01 },
  0x63: { key: 'drumStatus', scale: 1 },
  0x31: { key: 'tonerStatus', scale: 1 },
  0x6f: { key: 'tonerPercentFine', scale: 0.01 },
  0x81: { key: 'tonerPercent', scale: 1 },
};

const COUNTERS = {
  0x00: { key: 'totalPages', scale: 1 },
  0x01: { key: 'monoPages', scale: 1 },
  0x06: { key: 'duplexPages', scale: 1 },
};

const NEXT_CARE = {
  0x82: { key: 'drumPagesRemaining', scale: 1 },
};

function toBuffer(value) {
  if (value === null || value === undefined) { return null; }
  if (Buffer.isBuffer(value)) { return value; }
  if (typeof value === 'string') {
    const hex = value.replace(/[^0-9a-f]/gi, '');
    if (hex.length && hex.length % 2 === 0) { return Buffer.from(hex, 'hex'); }
  }
  return null;
}

/** Parse a Brother record blob into [{ code, value }] */
function parseRecords(input) {
  const buf = toBuffer(input);
  const records = [];
  if (!buf) { return records; }

  let i = 0;
  while (i < buf.length) {
    const code = buf[i];
    if (code === 0xff) { break; }
    if (i + 3 > buf.length) { break; }
    const len = buf[i + 2];
    const start = i + 3;
    const end = start + len;
    if (end > buf.length || len === 0 || len > 6) { break; }

    let value = 0;
    for (let j = start; j < end; j++) { value = value * 256 + buf[j]; }
    records.push({ code, value });
    i = end;
  }
  return records;
}

function decodeWith(map, input) {
  const out = {};
  const unknown = {};
  for (const { code, value } of parseRecords(input)) {
    const def = map[code];
    if (def) {
      out[def.key] = def.scale === 1 ? value : Math.round(value * def.scale * 100) / 100;
    } else {
      unknown[`0x${code.toString(16).padStart(2, '0')}`] = value;
    }
  }
  if (Object.keys(unknown).length) { out.unknown = unknown; }
  return out;
}

const decodeMaintenance = (input) => decodeWith(MAINTENANCE, input);
const decodeCounters = (input) => decodeWith(COUNTERS, input);
const decodeNextCare = (input) => decodeWith(NEXT_CARE, input);

/** Decode an SNMP OctetString that holds ASCII text */
function decodeText(input) {
  const buf = toBuffer(input);
  if (!buf) { return typeof input === 'string' ? input.trim() : ''; }
  // eslint-disable-next-line no-control-regex
  return buf.toString('latin1').replace(/[\x00-\x1f]+/g, ' ').trim();
}

/** hrPrinterDetectedErrorState bit names (RFC 3805 / RFC 2790) */
const ERROR_BITS = [
  'lowPaper', 'noPaper', 'lowToner', 'noToner',
  'doorOpen', 'jammed', 'offline', 'serviceRequested',
  'inputTrayMissing', 'outputTrayMissing', 'markerSupplyMissing', 'outputNearFull',
  'outputFull', 'inputTrayEmpty', 'overduePreventMaint',
];

function decodeErrorState(input) {
  const buf = toBuffer(input);
  const errors = [];
  if (!buf) { return errors; }
  for (let bit = 0; bit < ERROR_BITS.length; bit++) {
    const byte = buf[bit >> 3];
    if (byte === undefined) { break; }
    if (byte & (0x80 >> (bit & 7))) { errors.push(ERROR_BITS[bit]); }
  }
  return errors;
}

/** Errors that stop the printer and deserve a HomeKit fault badge */
const FAULT_ERRORS = new Set([
  'noPaper', 'noToner', 'doorOpen', 'jammed', 'serviceRequested',
  'inputTrayMissing', 'outputTrayMissing', 'markerSupplyMissing', 'outputFull',
]);

const FAULT_TEXT = /jam|cover is open|open|no paper|paper empty|replace|no toner|toner end|drum end|drum stop|error|call service|unable|cannot|no tray|size mismatch|out of memory/i;
const WARNING_TEXT = /\blow\b|end soon|soon/i;
const PRINTING_TEXT = /printing|receiving|copying/i;

/** hrPrinterStatus: 1 other, 2 unknown, 3 idle, 4 printing, 5 warmup */
function summarizeStatus({ statusText = '', printerStatus = null, errors = [] }) {
  const text = statusText || '';
  const faults = errors.filter((e) => FAULT_ERRORS.has(e));
  // "Toner Low" / "Drum End Soon" are warnings handled by the battery services
  const textFault = FAULT_TEXT.test(text) && !WARNING_TEXT.test(text);
  const printing = printerStatus === 4 || (PRINTING_TEXT.test(text) && !textFault);
  return {
    printing,
    fault: faults.length > 0 || textFault,
    faults,
    sleeping: /sleep/i.test(text),
  };
}

module.exports = {
  parseRecords,
  decodeMaintenance,
  decodeCounters,
  decodeNextCare,
  decodeText,
  decodeErrorState,
  summarizeStatus,
  toBuffer,
};
