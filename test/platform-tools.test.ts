// Bonjour search, finding a printer that moved, the report for support, and the dashboard page.
import test from 'node:test';
import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Logging } from 'homebridge';
import { browse, buildQuery, followUps, parseMessage, printersFrom, SERVICES } from '../src/mdns';
import type { BonjourPrinter } from '../src/mdns';
import { discover, findBySerial, movedIppUrl } from '../src/discover';
import { buildReport, fit, redact, safeSettings, valueText } from '../src/report';
import { allowedHost, startDashboard } from '../src/dashboard-server';
import { testSummary } from '../src/summary';
import * as snmp from '../src/snmp';
import type { QueryOptions, QueryResult } from '../src/snmp';
import modelsJson from './fixtures/brother-models.json';

const models = modelsJson as unknown as Record<string, { raw: snmp.RawReadings }>;
const fromModel = (name: string, extra: Partial<QueryResult> = {}): QueryResult => ({ ...snmp.parse(models[name].raw), snmpVersion: '2c', ...extra });

/* ------------------------------------------------------------ DNS packets */

function name(n: string): Buffer {
  return Buffer.concat([...n.split('.').map((p) => Buffer.concat([Buffer.from([Buffer.byteLength(p)]), Buffer.from(p)])), Buffer.from([0])]);
}
function record(owner: Buffer, type: number, data: Buffer): Buffer {
  const head = Buffer.alloc(10);
  head.writeUInt16BE(type, 0);
  head.writeUInt16BE(0x8001, 2);
  head.writeUInt32BE(120, 4);
  head.writeUInt16BE(data.length, 8);
  return Buffer.concat([owner, head, data]);
}
/** An answer for one printer: PTR, SRV, TXT and A, as a printer sends them */
function answer(service: string, instance: string, host: string, address: string, port: number, txt: Record<string, string>, id = 0): Buffer {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(id, 0);
  header.writeUInt16BE(0x8400, 2);
  header.writeUInt16BE(1, 6);
  header.writeUInt16BE(3, 10);
  const full = `${instance}.${service}`;
  const srv = Buffer.concat([Buffer.from([0, 0, 0, 0, port >> 8, port & 0xff]), name(host)]);
  const txtData = Buffer.concat(Object.entries(txt).map(([k, v]) => {
    const b = Buffer.from(`${k}=${v}`);
    return Buffer.concat([Buffer.from([b.length]), b]);
  }));
  return Buffer.concat([header,
    record(name(service), 12, name(full)),
    record(name(full), 33, srv),
    record(name(full), 16, txtData),
    record(name(host), 1, Buffer.from(address.split('.').map(Number)))]);
}

test('bonjour: the query asks for the printer services\' PTR records', () => {
  const q = buildQuery(SERVICES, 7);
  assert.equal(q.readUInt16BE(0), 7);
  assert.equal(q.readUInt16BE(4), SERVICES.length, 'one question per service');
  assert.ok(q.includes(name('_ipp._tcp.local')));
  assert.ok(q.includes(Buffer.from([0, 12, 0, 1])), 'type PTR, class IN');
});

test('bonjour: an answer gives the printer\'s address, name, model and IPP address', () => {
  const msg = answer('_ipp._tcp.local', 'Brother MFC-L2750DW series', 'BRW1234.local', '10.0.4.150', 631,
    { rp: 'ipp/print', ty: 'Brother MFC-L2750DW series', UUID: 'e3248000-80ce-11db-8000-30055c000001' });
  const printers = printersFrom(parseMessage(msg));
  assert.deepEqual(printers, [{
    host: '10.0.4.150', name: 'Brother MFC-L2750DW series', model: 'Brother MFC-L2750DW series',
    ippUrl: 'ipp://10.0.4.150:631/ipp/print', uuid: 'e3248000-80ce-11db-8000-30055c000001',
  }]);
});

test('bonjour: IPP and IPPS for one printer make one entry; IPP\'s address wins; others have no IPP address', () => {
  const records = [
    ...parseMessage(answer('_ipps._tcp.local', 'HP', 'hp.local', '10.0.0.5', 443, { rp: 'ipp/print' })),
    ...parseMessage(answer('_ipp._tcp.local', 'HP', 'hp.local', '10.0.0.5', 631, { rp: '/ipp/print', ty: 'HP LaserJet' })),
    ...parseMessage(answer('_pdl-datastream._tcp.local', 'Old', 'old.local', '10.0.0.6', 9100, {})),
  ];
  const printers = printersFrom(records);
  assert.equal(printers.length, 2);
  assert.equal(printers[0].ippUrl, 'ipp://10.0.0.5:631/ipp/print');
  assert.equal(printers[0].model, 'HP LaserJet');
  assert.equal(printers[1].ippUrl, null, 'port 9100 only: no IPP');
});

test('bonjour: malformed and looping messages don\'t throw', () => {
  assert.deepEqual(parseMessage(Buffer.alloc(5)), []);
  assert.deepEqual(parseMessage(buildQuery()), [], 'a query is not an answer');
  const loop = Buffer.concat([Buffer.from([0, 0, 0x84, 0, 0, 0, 0, 1, 0, 0, 0, 0]), Buffer.from([0xc0, 12]), Buffer.alloc(10)]);
  assert.doesNotThrow(() => parseMessage(loop));
  const cut = answer('_ipp._tcp.local', 'P', 'p.local', '10.0.0.7', 631, {}).subarray(0, 60);
  assert.doesNotThrow(() => printersFrom(parseMessage(cut)));
});

test('bonjour: browse sends the query and collects the answers sent back to it', async (t) => {
  const responder = dgram.createSocket('udp4');
  t.after(() => responder.close());
  responder.on('message', (msg, rinfo) => {
    if (msg.includes(name('_ipp._tcp.local'))) {
      responder.send(answer('_ipp._tcp.local', 'Printer', 'p.local', '10.0.0.8', 631, { rp: 'ipp/print' }), rinfo.port, rinfo.address);
    }
  });
  await new Promise<void>((resolve) => responder.bind(0, '127.0.0.1', resolve));
  const found = await browse({ address: '127.0.0.1', port: (responder.address() as AddressInfo).port, wait: 300 });
  assert.deepEqual(found.map((p) => p.host), ['10.0.0.8']);
});

/* ------------------------------------------------------------- the search */

const noSnmp = (): Promise<QueryResult> => Promise.reject(new Error('Request timed out'));

test('search: a printer with SNMP off is found by Bonjour and read over IPP', async () => {
  const bonjour: BonjourPrinter[] = [{ host: '10.0.0.30', name: 'HP LaserJet M404', model: 'HP LaserJet M404', ippUrl: 'ipp://10.0.0.30:631/ipp/print', uuid: null }];
  const ippRead: string[] = [];
  const found = await discover({
    targets: [], wait: 50, bonjour: () => Promise.resolve(bonjour), read: noSnmp,
    readIpp: (o) => { ippRead.push(o.ippUrl!); return Promise.resolve(fromModel('hl-l2340dw', { via: 'ipp', snmpVersion: null, model: 'HP LaserJet M404', serial: 'PHB123' })); },
  });
  assert.deepEqual(ippRead, ['ipp://10.0.0.30:631/ipp/print']);
  assert.equal(found.length, 1);
  assert.equal(found[0].protocol, 'ipp');
  assert.equal(found[0].ippUrl, 'ipp://10.0.0.30:631/ipp/print');
  assert.equal(found[0].serial, 'PHB123');
});

test('search: a printer both searches find is listed once, read over SNMP', async () => {
  const bonjour: BonjourPrinter[] = [{ host: '127.0.0.1', name: 'Brother', model: null, ippUrl: 'ipp://127.0.0.1:631/ipp/print', uuid: null }];
  let ipp = 0;
  const found = await discover({
    targets: [], wait: 50, bonjour: () => Promise.resolve(bonjour), read: () => Promise.resolve(fromModel('hl-l2340dw')),
    readIpp: () => { ipp++; return noSnmp(); },
  });
  assert.equal(found.length, 1);
  assert.equal(found[0].protocol, 'snmp');
  assert.equal(found[0].bonjourName, 'Brother');
  assert.equal(ipp, 0, 'no IPP read when SNMP answers');
});

test('search: a Bonjour device that answers neither is left out; a failing Bonjour search is no search', async () => {
  const found = await discover({
    targets: [], wait: 50, read: noSnmp, readIpp: noSnmp,
    bonjour: () => Promise.resolve([{ host: '10.0.0.40', name: 'X', model: null, ippUrl: 'ipp://10.0.0.40:631/ipp/print', uuid: null }]),
  });
  assert.deepEqual(found, []);
  assert.deepEqual(await discover({ targets: [], wait: 50, bonjour: () => Promise.reject(new Error('no multicast')) }), []);
});

/* ------------------------------------------------------- a printer that moved */

test('moved: found by its serial number among the devices, not at the old address', async () => {
  const bonjour: BonjourPrinter[] = [
    { host: '10.0.0.1', name: 'old', model: null, ippUrl: null, uuid: null },
    { host: '10.0.0.2', name: 'other', model: null, ippUrl: null, uuid: null },
    { host: '10.0.0.3', name: 'it', model: null, ippUrl: null, uuid: null },
  ];
  const read: string[] = [];
  const settings: QueryOptions & { host: string } = { host: '10.0.0.1', community: 'public', version: '2c', state: { noBulk: true } };
  const hit = await findBySerial('e78123a4n123456', settings, '10.0.0.1', {
    targets: [], wait: 50, bonjour: () => Promise.resolve(bonjour),
    read: (o) => {
      read.push(`${o.host} ${o.community}`);
      return Promise.resolve(fromModel('hl-l2340dw', { serial: o.host === '10.0.0.3' ? 'E78123A4N123456' : 'OTHER' }));
    },
  });
  assert.deepEqual(hit, { host: '10.0.0.3' });
  assert.deepEqual(read.sort(), ['10.0.0.2 public', '10.0.0.3 public'], 'never the old address');
});

test('moved: an IPP printer gets its IPP address moved too; nothing found is null', async () => {
  const settings: QueryOptions & { host: string } = { host: '10.0.0.1', protocol: 'ipp', ippUrl: 'ipps://10.0.0.1:443/ipp/print' };
  const urls: string[] = [];
  const hit = await findBySerial('S1', settings, '10.0.0.1', {
    targets: [], wait: 50, read: noSnmp,
    bonjour: () => Promise.resolve([{ host: '10.0.0.9', name: 'p', model: null, ippUrl: 'ipp://10.0.0.9:631/ipp/print', uuid: null }]),
    readIpp: (o) => { urls.push(o.ippUrl!); return Promise.resolve(fromModel('hl-l2340dw', { via: 'ipp', snmpVersion: null, serial: 'S1' })); },
  });
  assert.deepEqual(urls, ['ipps://10.0.0.9:443/ipp/print'], 'the settings\' IPP address, at the new host');
  assert.deepEqual(hit, { host: '10.0.0.9', ippUrl: 'ipps://10.0.0.9:443/ipp/print' });
  assert.equal(await findBySerial('S1', settings, '10.0.0.1', { targets: [], wait: 50, bonjour: () => Promise.resolve([]) }), null);
});

test('moved: the IPP address follows only when it names the old host, without user or password', () => {
  assert.equal(movedIppUrl(undefined, 'a', 'b'), undefined);
  assert.equal(movedIppUrl('ipp://10.0.0.1:631/ipp/print', '10.0.0.1', '10.0.0.9'), 'ipp://10.0.0.9:631/ipp/print');
  assert.equal(movedIppUrl('ipp://u:p@10.0.0.1:631/ipp/print', '10.0.0.1', '10.0.0.9'), 'ipp://10.0.0.9:631/ipp/print');
  assert.equal(movedIppUrl('ipp://printer.local/ipp/print', '10.0.0.1', '10.0.0.9'), undefined);
});

test('moved: an IPP address naming another host is never used for the candidates', async () => {
  const urls: string[] = [];
  const hit = await findBySerial('S1', { host: '10.0.0.5', protocol: 'ipp', ippUrl: 'ipp://printer.local:631/ipp/print' }, '10.0.0.5', {
    targets: [], wait: 50, read: noSnmp,
    bonjour: () => Promise.resolve([{ host: '10.0.0.1', name: 'router', model: null, ippUrl: null, uuid: null }]),
    readIpp: (o) => { urls.push(`${o.host} ${o.ippUrl ?? 'default'}`); return Promise.resolve(fromModel('hl-l2340dw', { via: 'ipp', snmpVersion: null, serial: 'S1' })); },
  });
  assert.deepEqual(urls, ['10.0.0.1 default'], 'the candidate\'s own address');
  assert.deepEqual(hit, { host: '10.0.0.1' });
});

test('moved: a private community or SNMPv3 goes only to a device Bonjour names as the same model', async () => {
  const sent: string[] = [];
  const bonjour: BonjourPrinter[] = [
    { host: '10.0.0.2', name: 'NAS', model: 'Synology', ippUrl: null, uuid: null },
    { host: '10.0.0.3', name: 'Brother MFC-L2750DW series', model: 'Brother MFC-L2750DW series', ippUrl: null, uuid: null },
  ];
  const settings: QueryOptions & { host: string } = { host: '10.0.0.1', version: '3', v3: { user: 'admin', authProtocol: 'sha', authPassword: 'x'.repeat(8), privProtocol: 'none', privPassword: '' } };
  const hit = await findBySerial('S1', settings, '10.0.0.1', {
    targets: [], wait: 50, model: 'MFC-L2750DW', bonjour: () => Promise.resolve(bonjour), readIpp: noSnmp,
    read: (o) => {
      sent.push(`${o.host} ${o.v3 ? 'v3' : o.community}`);
      return o.v3 && o.host === '10.0.0.3' ? Promise.resolve(fromModel('hl-l2340dw', { serial: 'S1' })) : noSnmp();
    },
  });
  assert.deepEqual(hit, { host: '10.0.0.3' });
  assert.ok(!sent.includes('10.0.0.2 v3'), sent.join());
  assert.ok(sent.includes('10.0.0.3 v3'));
  assert.ok(sent.filter((x) => x.endsWith('v3')).length === 1);
  assert.equal(await findBySerial('S1', settings, '10.0.0.1', { targets: [], wait: 50, bonjour: () => Promise.resolve(bonjour), read: noSnmp, readIpp: noSnmp }), null,
    'without a known model, no settings sent at all');
});

test('bonjour: follow-up queries for what an answer left out', () => {
  const ptrOnly = parseMessage(answer('_ipp._tcp.local', 'P', 'p.local', '10.0.0.7', 631, {})).filter((r) => r.type === 12);
  assert.deepEqual(followUps(ptrOnly).map((q) => q.type), [33, 16], 'SRV and TXT for the instance');
  const noAddress = parseMessage(answer('_ipp._tcp.local', 'P', 'p.local', '10.0.0.7', 631, {})).filter((r) => r.type !== 1);
  assert.deepEqual(followUps(noAddress), [{ name: 'p.local', type: 1 }]);
});

/* ---------------------------------------------------------------- the report */

test('report: settings without secrets, the reading, raw SNMP and IPP, serial and MAC shortened', async () => {
  const serial = 'E78123A4N123456';
  const entry = { name: 'Office', host: '10.0.0.1', community: 'secret', v3User: 'admin', v3AuthPassword: 'hunter22', serial };
  const text = await buildReport(entry, { host: '10.0.0.1', community: 'secret' }, {
    read: () => Promise.resolve(fromModel('hl-l2340dw', { serial })),
    bulk: () => Promise.resolve(false),
    walk: (_o, _v, oid) => Promise.resolve(oid === '1.3.6.1.2.1.1' ? [`${oid}.1.0 = "Brother NC-8300w, Firmware Ver.1.10 MAC 30:05:5c:12:34:56 SN ${serial}"`] : []),
    ipp: () => Promise.resolve({ 'printer-uuid': ['urn:uuid:e3248000-80ce-11db-8000-30055c123456'], 'printer-state': [3] }),
  });
  assert.ok(!text.includes('secret') && !text.includes('hunter22') && !text.includes('admin'), text);
  assert.ok(!text.includes(serial), 'the serial number is shortened');
  assert.ok(text.includes('…3456'));
  assert.ok(!text.includes('30:05:5c:12:34:56') && text.includes('30:…:34:56'));
  assert.ok(!text.includes('e3248000-80ce-11db-8000-30055c123456') && text.includes('e324…3456'));
  assert.match(text, /Answers bulk requests: no \(read row by row\)/);
  assert.match(text, /<summary>System \(1\.3\.6\.1\.2\.1\.1\)<\/summary>/);
  assert.ok(!text.includes('<summary>Supplies'), 'empty sections are left out');
  assert.match(text, /printer-state = 3/);
  assert.match(text, /What the plugin reads \(\d+ ms, over SNMP v2c\)/);
});

test('report: a printer that doesn\'t answer gives a report saying so', async () => {
  const text = await buildReport({ host: '10.0.0.1' }, { host: '10.0.0.1', version: 'auto' }, {
    read: noSnmp, ipp: () => Promise.reject(new Error('ECONNREFUSED')),
  });
  assert.match(text, /Couldn't read the printer .*Request timed out/);
  assert.match(text, /No answer over SNMP/);
  assert.match(text, /No answer over IPP: ECONNREFUSED/);
});

test('report helpers: values, settings and redaction', () => {
  assert.equal(valueText(Buffer.from('Tray 1')), '"Tray 1"');
  assert.equal(valueText(Buffer.from([0x01, 0xff])), 'hex 01ff');
  assert.equal(valueText(42), '42');
  assert.deepEqual(safeSettings({ community: 'public', v3PrivPassword: 'x' }), { community: 'public', v3PrivPassword: '(set, not shown)' });
  assert.equal(redact('SN ABC', ['ABC']), 'SN ABC', 'too short to be a serial number');
  assert.equal(safeSettings({ ippUrl: 'ipps://u:pw@10.0.0.1/ipp/print' }).ippUrl, 'ipps://10.0.0.1/ipp/print');
});

test('report: Brother node names, bare MACs, hex serials, location and secrets in raw values', async () => {
  const serial = 'E78123A4N123456';
  const text = await buildReport({ host: '10.0.0.1', community: 'h0me-net' }, { host: '10.0.0.1', community: 'h0me-net', version: '2c' }, {
    read: () => Promise.resolve(fromModel('hl-l2340dw', { serial })),
    bulk: () => Promise.resolve(true),
    walk: (_o, _v, oid) => Promise.resolve(oid === '1.3.6.1.2.1.1' ? [
      '1.3.6.1.2.1.1.5.0 = "BRN3C2AF41234AB"', '1.3.6.1.2.1.1.4.0 = "jane@example.com"', '1.3.6.1.2.1.1.6.0 = "12 Elm St, upstairs"',
      `1.3.6.1.2.1.43.5.1.1.17.1 = hex ${Buffer.from(`${serial}\0`).toString('hex')}`, '1.3.6.1.4.1.1 = "community h0me-net"', '1.3.6.1.4.1.2 = hex 3c2af41234ab'] : []),
    ipp: () => Promise.resolve({ 'printer-location': ['Office'], 'printer-more-info': ['http://BRW3C2AF41234AB.local./'], 'media-col-database': ['x'.repeat(100000)] }),
  });
  for (const leak of ['3C2AF41234AB', '3c2af41234ab', 'jane@', 'Elm St', '"Office"', 'h0me-net', Buffer.from(serial).toString('hex')]) {
    assert.ok(!text.includes(leak), `${leak} leaked`);
  }
  assert.ok(text.includes('BRN…34AB') && text.includes('BRW…34AB'));
  assert.ok(!text.includes('media-col-database'), 'bulky media lists left out');
  assert.ok(text.length < 65536);
});

test('report: cut to fit a GitHub issue, closing the open block', () => {
  const cut = fit(`<details>\n\n\`\`\`\n${'line\n'.repeat(100)}`, 100);
  assert.ok(cut.length < 200);
  assert.match(cut, /```\n<\/details>\n\n\(cut here/);
});

test('dashboard page: answers only to an address or this machine\'s name', () => {
  assert.ok(allowedHost('192.168.1.5:8587'));
  assert.ok(allowedHost('[fe80::1]:8587'));
  assert.ok(allowedHost('homebridge.local:8587'));
  assert.ok(allowedHost(undefined));
  assert.ok(!allowedHost('evil.example.com:8587'));
});

/* ------------------------------------------------------------- the dashboard */

const silent = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as unknown as Logging;

function get(port: number, path: string, method = 'GET'): Promise<{ status: number; type: string; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method }, (res) => {
      let body = '';
      res.on('data', (c: Buffer) => { body += c.toString(); });
      res.on('end', () => resolve({ status: res.statusCode!, type: String(res.headers['content-type']), body }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('dashboard page: the page, its script and the printers\' readings; nothing else', async (t) => {
  const summary = testSummary(fromModel('hl-l2340dw'));
  const server = startDashboard(0, silent, () => [{ name: 'Office', host: '10.0.0.1', online: true, updated: 1, result: summary as unknown as Record<string, unknown> }]);
  t.after(() => server.close());
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const port = (server.address() as AddressInfo).port;
  const page = await get(port, '/');
  assert.equal(page.status, 200);
  assert.match(page.type, /text\/html/);
  assert.match(page.body, /dashboard\.js/);
  assert.equal((await get(port, '/dashboard.js')).status, 200);
  const api = await get(port, '/api/printers');
  assert.equal((JSON.parse(api.body) as { name: string }[])[0].name, 'Office');
  assert.equal((await get(port, '/../config.json')).status, 404);
  assert.equal((await get(port, '/api/printers', 'POST')).status, 405);
});

test('summary: levels as bars for the dashboard, toner then drum', () => {
  const s = testSummary(fromModel('hl-l2340dw'));
  assert.deepEqual(s.bars.map((b) => b.label), ['Toner', 'Drum']);
  assert.equal(s.bars[0].percent, 80);
  assert.equal(s.bars[1].percent, 92);
  assert.equal(s.problem, false);
});
