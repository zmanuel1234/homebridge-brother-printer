'use strict';

// A tiny SNMP agent that answers like an MFC-L2750DW, for tests.
const snmp = require('net-snmp');
const { OID } = require('../lib/snmp');
const { toBuffer } = require('../lib/decode');
const fx = require('./fixtures');

const typeOf = (v) => (typeof v === 'number' ? snmp.ObjectType.Integer : snmp.ObjectType.OctetString);

function startFakePrinter(port, overrides = {}) {
  const values = {
    maintenance: toBuffer(fx.maintenance),
    counters: toBuffer(fx.counters),
    nextCare: toBuffer(fx.nextCare),
    statusText: toBuffer(fx.statusText),
    model: toBuffer(fx.model),
    serial: toBuffer(fx.serial),
    printerStatus: 3,
    errorState: Buffer.from([0x00]),
    ...overrides,
  };

  const agent = snmp.createAgent({ port, address: '127.0.0.1' }, () => {});
  agent.getAuthorizer().addCommunity('public');
  const mib = agent.getMib();

  const scalars = [];
  const tables = new Map(); // entry oid -> [{ name, column }]

  for (const name of Object.keys(values)) {
    const oid = OID[name];
    if (oid.endsWith('.0')) {
      scalars.push(name);
      mib.registerProvider({
        name,
        type: snmp.MibProviderType.Scalar,
        oid: oid.slice(0, -2),
        scalarType: typeOf(values[name]),
        maxAccess: snmp.MaxAccess['read-only'],
      });
    } else {
      // Table column at row index 1, e.g. hrDeviceDescr.1
      const parts = oid.split('.');
      parts.pop();
      const column = Number(parts.pop());
      const entry = parts.join('.');
      if (!tables.has(entry)) tables.set(entry, []);
      tables.get(entry).push({ name, column });
    }
  }

  let t = 0;
  const tableNames = new Map();
  for (const [entry, cols] of tables) {
    const tname = `table${t++}`;
    tableNames.set(tname, cols);
    mib.registerProvider({
      name: tname,
      type: snmp.MibProviderType.Table,
      oid: entry,
      tableColumns: [
        { number: 250, name: `${tname}Idx`, type: snmp.ObjectType.Integer, maxAccess: snmp.MaxAccess['not-accessible'] },
        ...cols.map((c) => ({
          number: c.column, name: c.name, type: typeOf(values[c.name]), maxAccess: snmp.MaxAccess['read-only'],
        })),
      ],
      tableIndex: [{ columnName: `${tname}Idx` }],
    });
    mib.addTableRow(tname, [1, ...cols.map((c) => values[c.name])]);
  }

  for (const name of scalars) mib.setScalarValue(name, values[name]);

  const set = (name, value) => {
    if (scalars.includes(name)) {
      mib.setScalarValue(name, value);
      return;
    }
    for (const [tname, cols] of tableNames) {
      const idx = cols.findIndex((c) => c.name === name);
      if (idx >= 0) mib.setTableSingleCell(tname, cols[idx].column, [1], value);
    }
  };

  return new Promise((resolve) => {
    setTimeout(() => resolve({ set, close: () => agent.close() }), 100);
  });
}

module.exports = { startFakePrinter };
