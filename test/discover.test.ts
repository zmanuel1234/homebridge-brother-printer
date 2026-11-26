// The settings screen's printer search and connection test: the broadcast
// request, picking printers out of the answers, and the UI server
// process as the Homebridge UI runs it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { broadcastAddresses, discover, findResponders, getRequest } from '../src/discover';
import { testPrinter } from '../src/homebridge-ui/server';
import * as snmp from '../src/snmp';
import type { QueryOptions, QueryResult } from '../src/snmp';
import { startFakePrinter } from './fake-agent';
import modelsJson from './fixtures/brother-models.json';

const models = modelsJson as unknown as Record<string, { raw: snmp.RawReadings }>;
const fromModel = (name: string): QueryResult => ({ ...snmp.parse(models[name].raw), snmpVersion: '2c' });

test('search: the broadcast request is a valid SNMP v1 GetRequest', () => {
  // SNMP v1, community "public", request id 1, GET sysDescr.0 (net-snmp's agent
  // answering it is checked below)
  assert.equal(getRequest('public', 1).toString('hex'),
    '302602010004067075626c6963a019020101020100020100300e300c06082b060102010101000500');
  // A long community and a large request id use the long length and integer forms
  const long = getRequest('c'.repeat(200), 0x7ffffffe);
  assert.equal(long.subarray(0, 2).toString('hex'), '3081', 'message length in the long form');
  assert.equal(long[2], long.length - 3, 'and it covers the rest of the message');
  assert.equal(long.subarray(6, 9).toString('hex'), '0481c8', 'community length 200 in the long form');
  assert.ok(long.includes(Buffer.from('02047ffffffe', 'hex')), 'request id as 4 bytes');
  assert.ok(getRequest('public', 0x80).includes(Buffer.from('02020080', 'hex')), 'a leading 0 keeps 128 positive');
});

test('search: broadcast addresses include the limited broadcast', () => {
  const list = broadcastAddresses();
  assert.ok(list.includes('255.255.255.255'));
  for (const a of list) { assert.match(a, /^\d+\.\d+\.\d+\.\d+$/); }
});

test('search: finds a printer that answers, and reads it', async (t) => {
  const printer = await startFakePrinter(16190);
  t.after(() => printer.close());
  assert.deepEqual(await findResponders({ targets: ['127.0.0.1'], port: 16190, wait: 300 }), ['127.0.0.1']);
  const found = await discover({ targets: ['127.0.0.1'], port: 16190, wait: 300 });
  assert.equal(found.length, 1);
  assert.equal(found[0].host, '127.0.0.1');
  assert.equal(found[0].model, 'MFC-L2750DW', 'without "Brother" and "series"');
  assert.equal(found[0].levels, 'toner 70%');
  assert.ok(found[0].serial);
});

test('search: nothing answering gives an empty list', async () => {
  assert.deepEqual(await discover({ targets: ['127.0.0.1'], port: 16191, wait: 200 }), []);
});

test('search: a printer with another community doesn\'t answer "public"', async (t) => {
  const printer = await startFakePrinter(16193);
  t.after(() => printer.close());
  assert.deepEqual(await findResponders({ targets: ['127.0.0.1'], port: 16193, wait: 300, community: 'secret' }), []);
});

test('search: finds printers of any make; leaves out other devices and ones it can\'t read', async (t) => {
  const printer = await startFakePrinter(16192);
  t.after(() => printer.close());
  const notPrinter = { ...fromModel('hl-l2340dw'), model: 'Cisco SG350', printerStatus: null, supplies: [], drums: {}, lowestSupply: null };
  const reads: QueryOptions[] = [];
  const found = await discover({
    targets: ['127.0.0.1'], port: 16192, wait: 300,
    read: (o) => { reads.push(o); return Promise.resolve(notPrinter); },
  });
  assert.deepEqual(found, []);
  assert.equal(reads.length, 1, 'the answering device was read');
  assert.equal(reads[0].community, 'public');
  const hp = { ...fromModel('hl-l2340dw'), model: 'HP LaserJet Pro M404n' };
  const foundHp = await discover({ targets: ['127.0.0.1'], port: 16192, wait: 300, read: () => Promise.resolve(hp) });
  assert.equal(foundHp[0]?.model, 'HP LaserJet Pro M404n');
  // A Windows PC's virtual printer has a printer status too, but isn't one
  const pdf = { ...fromModel('hl-l2340dw'), model: 'Microsoft Print To PDF', supplies: [], drums: {}, lowestSupply: null };
  assert.deepEqual(await discover({ targets: ['127.0.0.1'], port: 16192, wait: 300, read: () => Promise.resolve(pdf) }), []);
  const faxPrinter = { ...fromModel('hl-l2340dw'), model: 'Brother FAX-L2700DN series' };
  assert.equal((await discover({ targets: ['127.0.0.1'], port: 16192, wait: 300, read: () => Promise.resolve(faxPrinter) }))[0]?.model,
    'FAX-L2700DN', 'a real fax-printer is a printer');
  const failing = await discover({ targets: ['127.0.0.1'], port: 16192, wait: 300, read: () => Promise.reject(new Error('timeout')) });
  assert.deepEqual(failing, []);
});

/* --------------------------------------------------------------- test button */

test('test connection: reads with the settings as entered', async () => {
  let used: QueryOptions | undefined;
  const r = await testPrinter({ name: 'Office', host: ' 10.0.0.5 ', community: 'secret', snmpVersion: '1' },
    (o) => { used = o; return Promise.resolve({ ...fromModel('dcp-l3550cdw'), snmpVersion: '1' }); });
  assert.equal(used?.host, '10.0.0.5');
  assert.equal(used?.community, 'secret');
  assert.equal(used?.version, '1');
  assert.equal(r.via, 'SNMP v1');
  assert.match(r.levels, /^black \d+%, cyan \d+%, magenta \d+%, yellow \d+%$/);
});

test('test connection: explains a missing address, bad SNMPv3 settings and a failed read', async () => {
  await assert.rejects(testPrinter({ name: 'Office' }), /Enter the printer's IP address/);
  await assert.rejects(testPrinter({ host: '10.0.0.5', snmpVersion: '3' }), /user name/);
  await assert.rejects(testPrinter({ host: '10.0.0.5' }, () => Promise.reject(new Error('Request timed out'))),
    /Couldn't read 10\.0\.0\.5: Request timed out\. Check the address/);
});

/* --------------------------------------------------------- UI server process */

const server = join(__dirname, '..', 'dist', 'homebridge-ui', 'server.js');

test('UI server: starts like the Homebridge UI starts it, and answers requests', {
  skip: existsSync(server) ? false : 'dist/ not built; run npm run build', timeout: 20000,
}, async () => {
  const child = fork(server, [], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  try {
    const messages: { action: string; payload?: { requestId?: number; success?: boolean; data?: { message?: string } } }[] = [];
    const next = (action: string) => new Promise<(typeof messages)[number]>((resolve, reject) => {
      const check = (): void => {
        const i = messages.findIndex((m) => m.action === action);
        if (i >= 0) { resolve(messages.splice(i, 1)[0]); return; }
        if (child.exitCode !== null) { reject(new Error(`UI server exited with ${child.exitCode}`)); return; }
        setTimeout(check, 20);
      };
      check();
    });
    child.on('message', (m) => messages.push(m as (typeof messages)[number]));
    await next('ready');
    child.send({ action: 'request', path: '/test', body: { name: 'Office' }, requestId: 7 });
    const answer = await next('response');
    assert.equal(answer.payload?.requestId, 7);
    assert.equal(answer.payload?.success, false);
    assert.match(answer.payload?.data?.message || '', /Enter the printer's IP address/);
  } finally {
    child.kill();
  }
});
