'use strict';

const snmp = require('net-snmp');
const decode = require('./decode');

const OID = {
  maintenance: '1.3.6.1.4.1.2435.2.3.9.4.2.1.5.5.8.0', // brInfoMaintenance
  counters: '1.3.6.1.4.1.2435.2.3.9.4.2.1.5.5.10.0', // brInfoCounter
  nextCare: '1.3.6.1.4.1.2435.2.3.9.4.2.1.5.5.11.0', // brInfoNextCare
  statusText: '1.3.6.1.4.1.2435.2.3.9.4.2.1.5.4.5.2.0', // LCD status line
  model: '1.3.6.1.2.1.25.3.2.1.3.1', // hrDeviceDescr
  serial: '1.3.6.1.2.1.43.5.1.1.17.1', // prtGeneralSerialNumber
  printerStatus: '1.3.6.1.2.1.25.3.5.1.1.1', // hrPrinterStatus
  errorState: '1.3.6.1.2.1.25.3.5.1.2.1', // hrPrinterDetectedErrorState
};

const NAMES = Object.keys(OID);

/**
 * Query the printer once and return decoded values.
 * Rejects only when the printer can't be reached at all.
 */
function query({ host, port = 161, community = 'public', timeout = 5000, retries = 1 }) {
  return new Promise((resolve, reject) => {
    let session;
    try {
      session = snmp.createSession(host, community, {
        port,
        version: snmp.Version2c,
        timeout,
        retries,
        idBitsSize: 32,
      });
    } catch (err) {
      reject(err);
      return;
    }

    let settled = false;
    const finish = (err, result) => {
      if (settled) { return; }
      settled = true;
      try { session.close(); } catch { /* already closed */ }
      if (err) { reject(err); } else { resolve(result); }
    };

    session.on('error', (err) => finish(err));

    session.get(NAMES.map((n) => OID[n]), (err, varbinds) => {
      if (err) {
        finish(err);
        return;
      }
      const raw = {};
      varbinds.forEach((vb, idx) => {
        raw[NAMES[idx]] = snmp.isVarbindError(vb) ? null : vb.value;
      });
      finish(null, parse(raw));
    });
  });
}

function parse(raw) {
  const maintenance = decode.decodeMaintenance(raw.maintenance);
  const counters = decode.decodeCounters(raw.counters);
  const nextCare = decode.decodeNextCare(raw.nextCare);
  const statusText = decode.decodeText(raw.statusText);
  const printerStatus = typeof raw.printerStatus === 'number' ? raw.printerStatus : null;
  const errors = decode.decodeErrorState(raw.errorState);

  return {
    model: decode.decodeText(raw.model) || null,
    serial: decode.decodeText(raw.serial) || null,
    statusText,
    printerStatus,
    errors,
    ...decode.summarizeStatus({ statusText, printerStatus, errors }),
    tonerPercent: pick(maintenance.tonerPercent),
    tonerPercentFine: pick(maintenance.tonerPercentFine),
    drumPercent: pick(maintenance.drumPercent),
    drumPagesUsed: pick(maintenance.drumPagesUsed),
    drumPagesRemaining: pick(nextCare.drumPagesRemaining),
    totalPages: pick(counters.totalPages),
    duplexPages: pick(counters.duplexPages),
    unknown: {
      maintenance: maintenance.unknown,
      counters: counters.unknown,
      nextCare: nextCare.unknown,
    },
  };
}

const pick = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

module.exports = { query, parse, OID };
