// A tiny SNMP agent that answers like an MFC-L2750DW, for tests.
import * as snmp from 'net-snmp';
import { OID } from '../src/snmp.js';
import type { OidName } from '../src/snmp.js';
import { toBuffer } from '../src/decode.js';
import fx from './fixtures.js';

type AgentValue = Buffer | number;

export interface FakePrinter {
  set(name: OidName, value: AgentValue): void;
  close(): void;
}

// net-snmp's agent API is untyped in @types/net-snmp; this is the part used here
interface Mib {
  registerProvider(provider: Record<string, unknown>): void;
  addTableRow(table: string, row: unknown[]): void;
  setScalarValue(name: string, value: AgentValue): void;
  setTableSingleCell(table: string, column: number, row: number[], value: AgentValue): void;
}
interface Agent {
  getAuthorizer(): { addCommunity(name: string): void; addUser(user: snmp.User): void };
  getMib(): Mib;
  close(): void;
}
const lib = snmp as unknown as {
  createAgent(options: { port: number; address: string }, cb: () => void): Agent;
  ObjectType: { Integer: number; OctetString: number };
  MibProviderType: { Scalar: string; Table: string };
  MaxAccess: Record<'read-only' | 'not-accessible', number>;
};

const typeOf = (v: AgentValue): number => (typeof v === 'number' ? lib.ObjectType.Integer : lib.ObjectType.OctetString);

/** A row of the Printer MIB supplies table (prtMarkerSuppliesTable), for printers of any make */
export interface FakeSupply { colorant: number; type: number; name: string; max: number; level: number }
/** A row of the Printer MIB input table (prtInputTable): a paper tray */
export interface FakeTray { name: string; max: number; level: number }

export function startFakePrinter(port: number, overrides: Partial<Record<OidName, AgentValue | undefined>> = {},
  users: snmp.User[] = [], supplies: FakeSupply[] = [], colorants: string[] = [], trays: FakeTray[] = []): Promise<FakePrinter> {
  const given: Partial<Record<OidName, AgentValue | null | undefined>> = {
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
  const values: Partial<Record<OidName, AgentValue>> = {};
  for (const [k, v] of Object.entries(given) as [OidName, AgentValue | null | undefined][]) {
    if (v !== undefined && v !== null) { values[k] = v; }
  }
  const valueOf = (name: OidName): AgentValue => values[name] as AgentValue;

  const agent = lib.createAgent({ port, address: '127.0.0.1' }, () => {});
  agent.getAuthorizer().addCommunity('public');
  for (const user of users) { agent.getAuthorizer().addUser(user); }
  const mib = agent.getMib();

  const scalars: OidName[] = [];
  const tables = new Map<string, { name: OidName; column: number }[]>(); // entry oid -> columns

  for (const name of Object.keys(values) as OidName[]) {
    const oid: string = OID[name];
    if (oid.endsWith('.0')) {
      scalars.push(name);
      mib.registerProvider({
        name,
        type: lib.MibProviderType.Scalar,
        oid: oid.slice(0, -2),
        scalarType: typeOf(valueOf(name)),
        maxAccess: lib.MaxAccess['read-only'],
      });
    } else {
      // Table column at row index 1, e.g. hrDeviceDescr.1
      const parts = oid.split('.');
      parts.pop();
      const column = Number(parts.pop());
      const entry = parts.join('.');
      const cols = tables.get(entry) || [];
      cols.push({ name, column });
      tables.set(entry, cols);
    }
  }

  let t = 0;
  const tableNames = new Map<string, { name: OidName; column: number }[]>();
  for (const [entry, cols] of tables) {
    const tname = `table${t++}`;
    tableNames.set(tname, cols);
    mib.registerProvider({
      name: tname,
      type: lib.MibProviderType.Table,
      oid: entry,
      tableColumns: [
        { number: 250, name: `${tname}Idx`, type: lib.ObjectType.Integer, maxAccess: lib.MaxAccess['not-accessible'] },
        ...cols.map((c) => ({
          number: c.column, name: c.name, type: typeOf(valueOf(c.name)), maxAccess: lib.MaxAccess['read-only'],
        })),
      ],
      tableIndex: [{ columnName: `${tname}Idx` }],
    });
    mib.addTableRow(tname, [1, ...cols.map((c) => valueOf(c.name))]);
  }

  for (const name of scalars) { mib.setScalarValue(name, valueOf(name)); }

  if (supplies.length) {
    // Indexed by hrDeviceIndex (1) and the supply's index
    const col = (number: number, name: string, type: number) => ({ number, name, type, maxAccess: lib.MaxAccess['read-only'] });
    mib.registerProvider({
      name: 'prtMarkerSuppliesTable',
      type: lib.MibProviderType.Table,
      oid: '1.3.6.1.2.1.43.11.1.1',
      tableColumns: [
        { number: 251, name: 'hrDeviceIndex', type: lib.ObjectType.Integer, maxAccess: lib.MaxAccess['not-accessible'] },
        { number: 1, name: 'prtMarkerSuppliesIndex', type: lib.ObjectType.Integer, maxAccess: lib.MaxAccess['not-accessible'] },
        col(3, 'colorantIndex', lib.ObjectType.Integer),
        col(5, 'type', lib.ObjectType.Integer),
        col(6, 'description', lib.ObjectType.OctetString),
        col(8, 'maxCapacity', lib.ObjectType.Integer),
        col(9, 'level', lib.ObjectType.Integer),
      ],
      tableIndex: [{ columnName: 'hrDeviceIndex' }, { columnName: 'prtMarkerSuppliesIndex' }],
    });
    supplies.forEach((s, i) => mib.addTableRow('prtMarkerSuppliesTable',
      [1, i + 1, s.colorant, s.type, Buffer.from(s.name), s.max, s.level]));
  }
  if (trays.length) {
    const col = (number: number, name: string, type: number) => ({ number, name, type, maxAccess: lib.MaxAccess['read-only'] });
    mib.registerProvider({
      name: 'prtInputTable',
      type: lib.MibProviderType.Table,
      oid: '1.3.6.1.2.1.43.8.2.1',
      tableColumns: [
        { number: 251, name: 'inDev', type: lib.ObjectType.Integer, maxAccess: lib.MaxAccess['not-accessible'] },
        { number: 1, name: 'prtInputIndex', type: lib.ObjectType.Integer, maxAccess: lib.MaxAccess['not-accessible'] },
        col(9, 'maxCapacity', lib.ObjectType.Integer),
        col(10, 'currentLevel', lib.ObjectType.Integer),
        col(13, 'inputName', lib.ObjectType.OctetString),
      ],
      tableIndex: [{ columnName: 'inDev' }, { columnName: 'prtInputIndex' }],
    });
    trays.forEach((tr, i) => mib.addTableRow('prtInputTable', [1, i + 1, tr.max, tr.level, Buffer.from(tr.name)]));
  }
  if (colorants.length) {
    mib.registerProvider({
      name: 'prtMarkerColorantTable',
      type: lib.MibProviderType.Table,
      oid: '1.3.6.1.2.1.43.12.1.1',
      tableColumns: [
        { number: 251, name: 'cDev', type: lib.ObjectType.Integer, maxAccess: lib.MaxAccess['not-accessible'] },
        { number: 1, name: 'cIndex', type: lib.ObjectType.Integer, maxAccess: lib.MaxAccess['not-accessible'] },
        { number: 4, name: 'colorantValue', type: lib.ObjectType.OctetString, maxAccess: lib.MaxAccess['read-only'] },
      ],
      tableIndex: [{ columnName: 'cDev' }, { columnName: 'cIndex' }],
    });
    colorants.forEach((c, i) => mib.addTableRow('prtMarkerColorantTable', [1, i + 1, Buffer.from(c)]));
  }

  const set = (name: OidName, value: AgentValue): void => {
    if (scalars.includes(name)) {
      mib.setScalarValue(name, value);
      return;
    }
    for (const [tname, cols] of tableNames) {
      const col = cols.find((c) => c.name === name);
      if (col) { mib.setTableSingleCell(tname, col.column, [1], value); }
    }
  };

  return new Promise((resolve) => {
    setTimeout(() => resolve({ set, close: () => agent.close() }), 100);
  });
}
