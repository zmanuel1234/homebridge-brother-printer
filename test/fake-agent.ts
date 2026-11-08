// A tiny SNMP agent that answers like an MFC-L2750DW, for tests.
import * as snmp from 'net-snmp';
import { OID } from '../src/snmp';
import type { OidName } from '../src/snmp';
import { toBuffer } from '../src/decode';
import fx from './fixtures';

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
  getAuthorizer(): { addCommunity(name: string): void };
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

export function startFakePrinter(port: number, overrides: Partial<Record<OidName, AgentValue | undefined>> = {}): Promise<FakePrinter> {
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
