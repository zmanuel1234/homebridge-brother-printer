// Reading a printer over IPP (AirPrint): the message format, mapping the
// printer's attributes onto the plugin's readings, and the protocol choice.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { TAG, getPrinterAttributes, ippEndpoint, ippMessage, ippQuery, parseResponse, reasonErrors, toPrinterData } from '../src/ipp';
import type { IppAttribute, IppAttributes } from '../src/ipp';
import { defaultIppUrl, readPrinter, readers } from '../src/read';
import { parse } from '../src/snmp';
import { queryOptions } from '../src/accessory';
import { startFakePrinter } from './fake-agent';

const int = (name: string, ...values: number[]): IppAttribute => ({ tag: TAG.integer, name, values });
const enm = (name: string, ...values: number[]): IppAttribute => ({ tag: TAG.enum, name, values });
const kw = (name: string, ...values: string[]): IppAttribute => ({ tag: TAG.keyword, name, values });
const txt = (name: string, ...values: string[]): IppAttribute => ({ tag: TAG.text, name, values });
const nam = (name: string, ...values: string[]): IppAttribute => ({ tag: TAG.name, name, values });

/** A printer's answer to Get-Printer-Attributes */
function response(attributes: IppAttribute[], status = 0, requestId = 1): Buffer {
  return ippMessage(status, requestId, [
    { tag: TAG.operation, attributes: [
      { tag: TAG.charset, name: 'attributes-charset', values: ['utf-8'] },
      { tag: TAG.language, name: 'attributes-natural-language', values: ['en'] },
    ] },
    { tag: TAG.printer, attributes },
  ]);
}

// How a mono Brother laser answers: toner only as "some remaining" (-3)
const MONO: IppAttribute[] = [
  enm('printer-state', 3),
  kw('printer-state-reasons', 'none'),
  txt('printer-make-and-model', 'Brother MFC-L2750DW series'),
  txt('printer-device-id', 'MFG:Brother;CMD:PJL,PCL,PCLXL,URF;MDL:MFC-L2750DW series;CLS:PRINTER;CID:Brother Laser Type1;'),
  nam('marker-names', 'Black Toner', 'Drum Unit'),
  kw('marker-types', 'toner', 'opc'),
  nam('marker-colors', '#000000', '#000000'),
  int('marker-levels', -3, 60),
  int('marker-high-levels', 100, 100),
  int('printer-impressions-completed', 4886),
];

// A color printer that gives numbers
const COLOR: IppAttribute[] = [
  enm('printer-state', 4),
  kw('printer-state-reasons', 'toner-low-warning', 'media-empty-report'),
  txt('printer-state-message', 'Printing'),
  txt('printer-make-and-model', 'Brother DCP-L3550CDW series'),
  nam('marker-names', 'Black Toner', 'Cyan Toner', 'Magenta Toner', 'Yellow Toner', 'Drum Unit', 'Belt Unit', 'Waste Toner Box'),
  kw('marker-types', 'toner', 'toner', 'toner', 'toner', 'opc', 'transfer-unit', 'waste-toner'),
  nam('marker-colors', '#000000', '#00FFFF', '#FF00FF', '#FFFF00', 'none', 'none', 'none'),
  int('marker-levels', 70, 40, 8, 55, 80, 90, 30),
  int('marker-high-levels', 100, 100, 100, 100, 100, 100, 100),
];

const attributes = (list: IppAttribute[]): IppAttributes => parseResponse(response(list)).printer;

/* --------------------------------------------------------------- messages */

test('IPP: the request is a Get-Printer-Attributes with the printer URI', () => {
  const req = getPrinterAttributes('ipp://10.0.0.5:631/ipp/print', 42);
  assert.equal(req.readUInt16BE(0), 0x0200, 'IPP 2.0');
  assert.equal(req.readUInt16BE(2), 0x000b, 'Get-Printer-Attributes');
  assert.equal(req.readUInt32BE(4), 42);
  assert.ok(req.includes(Buffer.from('ipp://10.0.0.5:631/ipp/print')));
  assert.ok(req.includes(Buffer.from('marker-levels')));
  assert.equal(req[req.length - 1], TAG.end);
});

test('IPP: responses decode, with several values, text with language, and collections skipped', () => {
  const buf = response([
    ...MONO,
    { tag: TAG.begCollection, name: 'media-col-ready', values: [''] },
    { tag: TAG.memberName, name: '', values: ['media-size'] },
    { tag: TAG.keyword, name: '', values: ['should-not-appear'] },
    { tag: TAG.endCollection, name: '', values: [''] },
  ], 0, 7);
  // textWithLanguage: language "en", then the text
  const withLang = Buffer.concat([Buffer.from([0x35, 0, 21]), Buffer.from('printer-state-message'),
    Buffer.from([0, 9, 0, 2]), Buffer.from('en'), Buffer.from([0, 3]), Buffer.from('Hi!')]);
  const full = Buffer.concat([buf.subarray(0, buf.length - 1), withLang, Buffer.from([TAG.end])]);
  const r = parseResponse(full);
  assert.equal(r.status, 0);
  assert.equal(r.requestId, 7);
  assert.deepEqual(r.printer['marker-names'], ['Black Toner', 'Drum Unit']);
  assert.deepEqual(r.printer['marker-levels'], [-3, 60]);
  assert.deepEqual(r.printer['printer-state'], [3]);
  assert.deepEqual(r.printer['printer-state-message'], ['Hi!']);
  assert.equal(JSON.stringify(r.printer).includes('should-not-appear'), false);
  assert.equal(r.printer['attributes-charset'], undefined, 'operation attributes aren\'t printer attributes');
});

test('IPP: a response cut short is refused', () => {
  const buf = response(MONO);
  assert.throws(() => parseResponse(buf.subarray(0, buf.length - 10)), /cut short/);
  assert.throws(() => parseResponse(Buffer.alloc(4)), /too short/);
});

/* ---------------------------------------------------------------- mapping */

test('IPP mapping: a mono Brother with "some remaining" toner', () => {
  const d = toPrinterData(attributes(MONO));
  assert.equal(d.model, 'Brother MFC-L2750DW series');
  assert.equal(d.type, 'laser');
  assert.deepEqual(d.supplies, [], 'no % to show');
  assert.equal(d.drumPercent, 60);
  assert.equal(d.totalPages, 4886);
  assert.equal(d.printing, false);
  assert.equal(d.fault, false);
});

test('IPP mapping: a color printer with levels, parts, printing and a low toner', () => {
  const d = toPrinterData(attributes(COLOR));
  assert.deepEqual(d.supplies.map((s) => [s.color, s.level]), [['black', 70], ['cyan', 40], ['magenta', 8], ['yellow', 55]]);
  assert.equal(d.lowestSupply?.color, 'magenta');
  assert.equal(d.drums.black?.percent, 80);
  assert.equal(d.parts.belt?.percent, 90);
  assert.equal(d.parts.wasteToner?.percent, 30);
  assert.equal(d.type, 'laser', 'a waste toner box doesn\'t make it an ink printer');
  assert.equal(d.printing, true);
  assert.deepEqual(d.errors, ['lowToner'], 'a -report reason is information only');
  assert.equal(d.statusText, 'Printing');
  assert.equal(d.totalPages, null);
});

test('IPP mapping: problems from printer-state-reasons', () => {
  assert.deepEqual(reasonErrors(['media-jam-error', 'door-open', 'media-empty-warning', 'none', 'other']),
    ['jammed', 'doorOpen', 'noPaper']);
  const d = toPrinterData(attributes([enm('printer-state', 5), kw('printer-state-reasons', 'media-jam-error')]));
  assert.equal(d.fault, true);
  assert.deepEqual(d.faults, ['jammed']);
  assert.equal(d.statusText, 'media-jam-error', 'the reasons, when there is no message');
});

test('IPP mapping: inkjets, serial number from the device ID, levels against their maximum', () => {
  const d = toPrinterData(attributes([
    enm('printer-state', 3),
    txt('printer-device-id', 'MFG:Brother;MDL:MFC-J5110DW;SN:E78123456;'),
    nam('marker-names', 'BK', 'C', 'M', 'Y'),
    kw('marker-types', 'ink-cartridge', 'ink-cartridge', 'ink-cartridge', 'ink-cartridge'),
    int('marker-levels', 50, 25, 150, 0),
    int('marker-high-levels', 200, 100, 200, 100),
  ]));
  assert.equal(d.type, 'ink');
  assert.equal(d.model, 'MFC-J5110DW');
  assert.equal(d.serial, 'E78123456');
  assert.deepEqual(d.supplies.map((s) => [s.color, s.level]), [['black', 25], ['cyan', 25], ['magenta', 75], ['yellow', 0]]);
});

test('IPP: addresses', () => {
  assert.deepEqual(ippEndpoint('ipp://10.0.0.5/ipp/print'), { http: new URL('http://10.0.0.5:631/ipp/print'), uri: 'ipp://10.0.0.5:631/ipp/print' });
  assert.equal(ippEndpoint('ipps://printer.local/ipp/print').http.href, 'https://printer.local:631/ipp/print');
  assert.equal(ippEndpoint('http://10.0.0.5:8631/ipp').uri, 'ipp://10.0.0.5:8631/ipp');
  assert.throws(() => ippEndpoint('ftp://10.0.0.5/'), /Not an IPP address/);
  assert.equal(defaultIppUrl('10.0.0.5'), 'ipp://10.0.0.5:631/ipp/print');
  assert.equal(defaultIppUrl('fe80::1'), 'ipp://[fe80::1]:631/ipp/print');
  // IPv6: URL keeps the brackets in hostname, so they aren't added twice
  assert.equal(ippEndpoint(defaultIppUrl('fe80::1')).http.href, 'http://[fe80::1]:631/ipp/print');
  assert.equal(ippEndpoint('ipp://[fe80::1]:631/ipp/print').uri, 'ipp://[fe80::1]:631/ipp/print');
  assert.equal(ippEndpoint(defaultIppUrl('[fe80::1]')).http.hostname, '[fe80::1]');
});

test('IPP mapping: information-only reasons don\'t open the Problem sensor', () => {
  const d = toPrinterData(attributes([enm('printer-state', 3), kw('printer-state-reasons', 'cover-open-report')]));
  assert.equal(d.fault, false);
  assert.equal(d.statusText, '');
});

test('IPP mapping: drum and waste toner end of life', () => {
  assert.deepEqual(reasonErrors(['opc-life-over-error', 'marker-waste-almost-full-warning']), ['serviceRequested', 'overduePreventMaint']);
  assert.equal(toPrinterData(attributes([enm('printer-state', 5), kw('printer-state-reasons', 'opc-life-over')])).fault, true);
});

test('IPP mapping: device ID fields are matched whole', () => {
  const d = toPrinterData(attributes([txt('printer-device-id', 'MFG:Brother;ISN:WRONG;XMDL:WRONG;MDL:HL-L2340DW;SN:E1;')]));
  assert.equal(d.serial, 'E1');
  assert.equal(d.model, 'HL-L2340DW');
});

test('IPP mapping: a single toner without a color is black; missing values keep levels in step', () => {
  const r = toPrinterData(attributes([
    nam('marker-names', 'Toner'), kw('marker-types', 'toner'), int('marker-levels', 70),
  ]));
  assert.deepEqual(r.supplies.map((s) => [s.color, s.level]), [['black', 70]]);
  // An out-of-band "unknown" (0x12) in marker-levels keeps the next level on the next marker
  const buf = response([nam('marker-names', 'Cyan Toner', 'Magenta Toner'), kw('marker-types', 'toner', 'toner')]);
  const levels = Buffer.concat([Buffer.from([0x12, 0, 13]), Buffer.from('marker-levels'), Buffer.from([0, 0]),
    Buffer.from([TAG.integer, 0, 0, 0, 4]), Buffer.from([0, 0, 0, 33])]);
  const parsed = parseResponse(Buffer.concat([buf.subarray(0, buf.length - 1), levels, Buffer.from([TAG.end])]));
  assert.deepEqual(parsed.printer['marker-levels'], [null, 33]);
  assert.deepEqual(toPrinterData(parsed.printer).supplies.map((s) => [s.color, s.level]), [['magenta', 33]]);
});

/* ---------------------------------------------------------- over the wire */

function fakeIppPrinter(answer: (body: Buffer) => { status?: number; body: Buffer } | null): Promise<{ url: string; requests: Buffer[]; close(): void }> {
  const requests: Buffer[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      requests.push(body);
      const a = answer(body);
      if (!a) { return; } // never answer
      res.writeHead(a.status ?? 200, { 'Content-Type': 'application/ipp' });
      res.end(a.body);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({ url: `ipp://127.0.0.1:${port}/ipp/print`, requests, close: () => { server.closeAllConnections(); server.close(); } });
    });
  });
}

test('IPP: reads a printer over HTTP, sending its URI', async (t) => {
  const printer = await fakeIppPrinter((body) => ({ body: response(MONO, 0, body.readUInt32BE(4)) }));
  t.after(() => printer.close());
  const d = await ippQuery({ url: printer.url });
  assert.equal(d.model, 'Brother MFC-L2750DW series');
  assert.equal(printer.requests[0].readUInt16BE(2), 0x000b);
  assert.ok(printer.requests[0].includes(Buffer.from(printer.url.replace('/ipp/print', '') + '/ipp/print')));
});

test('IPP: HTTP errors, refused requests and timeouts reject', async (t) => {
  const notFound = await fakeIppPrinter(() => ({ status: 404, body: Buffer.from('nope') }));
  const refused = await fakeIppPrinter((body) => ({ body: response([], 0x0400, body.readUInt32BE(4)) }));
  const silent = await fakeIppPrinter(() => null);
  t.after(() => { notFound.close(); refused.close(); silent.close(); });
  await assert.rejects(ippQuery({ url: notFound.url }), /HTTP 404/);
  await assert.rejects(ippQuery({ url: refused.url }), /refused \(status 0x0400\)/);
  await assert.rejects(ippQuery({ url: silent.url, timeout: 300 }), /timed out/);
});

test('IPP: a reply that trickles in still times out', async (t) => {
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/ipp' });
      const timer = setInterval(() => res.write(Buffer.from([0])), 100);
      res.on('close', () => clearInterval(timer));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const { port } = server.address() as AddressInfo;
  const started = Date.now();
  await assert.rejects(ippQuery({ url: `ipp://127.0.0.1:${port}/ipp/print`, timeout: 300 }), /timed out/);
  assert.ok(Date.now() - started < 2000);
});

/** A self-signed certificate made for the test (nothing secret is committed) */
function selfSigned(): { key: Buffer; cert: Buffer } | null {
  const dir = mkdtempSync(join(tmpdir(), 'bp-cert-'));
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=127.0.0.1',
      '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem')], { stdio: 'ignore' });
    return { key: readFileSync(join(dir, 'key.pem')), cert: readFileSync(join(dir, 'cert.pem')) };
  } catch {
    return null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const tls = selfSigned();

test('IPP over ipps: a self-signed certificate is refused unless allowed', { skip: tls ? false : 'openssl not available' }, async (t) => {
  const server = https.createServer(tls!, (req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/ipp' });
      res.end(response(MONO, 0, Buffer.concat(chunks).readUInt32BE(4)));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const url = `ipps://127.0.0.1:${(server.address() as AddressInfo).port}/ipp/print`;
  await assert.rejects(ippQuery({ url }), /certificate can't be verified .*ippAllowSelfSigned/);
  const d = await ippQuery({ url, allowSelfSigned: true });
  assert.equal(d.model, 'Brother MFC-L2750DW series');
  assert.equal(queryOptions({ name: 'P', host: 'h', protocol: 'ipp', ippAllowSelfSigned: true }).ippAllowSelfSigned, true);
  assert.equal(queryOptions({ name: 'P', host: 'h', ippAllowSelfSigned: true }).ippAllowSelfSigned, undefined, 'unused with SNMP');
});

test('IPP: a reply for another request is refused', async (t) => {
  const printer = await fakeIppPrinter((body) => ({ body: response(MONO, 0, body.readUInt32BE(4) + 1) }));
  t.after(() => printer.close());
  await assert.rejects(ippQuery({ url: printer.url }), /another request/);
});

test('reading: IPP only, SNMP only, and auto falling back to IPP', async (t) => {
  const ipp = await fakeIppPrinter((body) => ({ body: response(COLOR, 0, body.readUInt32BE(4)) }));
  t.after(() => ipp.close());
  const viaIpp = await readPrinter({ host: '127.0.0.1', protocol: 'ipp', ippUrl: ipp.url });
  assert.equal(viaIpp.via, 'ipp');
  assert.equal(viaIpp.snmpVersion, null);

  // No SNMP agent on this port: auto falls back to IPP
  const auto = await readPrinter({ host: '127.0.0.1', port: 16195, timeout: 300, retries: 0, protocol: 'auto', ippUrl: ipp.url, state: {} });
  assert.equal(auto.via, 'ipp');

  // With SNMP answering, auto uses SNMP
  const snmpPrinter = await startFakePrinter(16196);
  t.after(() => snmpPrinter.close());
  const viaSnmp = await readPrinter({ host: '127.0.0.1', port: 16196, protocol: 'auto', ippUrl: ipp.url, state: {} });
  assert.equal(viaSnmp.via, undefined);
  assert.equal(viaSnmp.snmpVersion, '2c');
});

test('reading: auto reads IPP when SNMP answers but its supplies table doesn\'t', async (t) => {
  const ipp = await fakeIppPrinter((body) => ({ body: response(COLOR, 0, body.readUInt32BE(4)) }));
  t.after(() => ipp.close());
  const unread = { ...parse({ model: Buffer.from('HP Color LaserJet M452nw'), suppliesUnread: true }), snmpVersion: '2c' as const };
  const query = t.mock.method(readers, 'query', async () => unread);
  const auto = await readPrinter({ host: '127.0.0.1', protocol: 'auto', ippUrl: ipp.url, state: {} });
  assert.equal(auto.via, 'ipp', 'IPP\'s levels stand in');
  assert.ok(auto.supplies.length);
  // IPP not answering either: SNMP's reading, without supplies
  const none = await readPrinter({ host: '127.0.0.1', protocol: 'auto', ippUrl: 'ipp://127.0.0.1:1/ipp/print', timeout: 300, state: {} });
  assert.equal(none.suppliesUnread, true);
  assert.equal(none.snmpVersion, '2c');
  // SNMP only: no IPP
  assert.equal((await readPrinter({ host: '127.0.0.1', protocol: 'snmp', ippUrl: ipp.url })).suppliesUnread, true);
  assert.equal(query.mock.callCount(), 3);
});

test('reading: auto reports both failures', async () => {
  await assert.rejects(readPrinter({
    host: '127.0.0.1', port: 16197, timeout: 300, retries: 0, protocol: 'auto', ippUrl: 'ipp://127.0.0.1:1/ipp/print',
  }), /SNMP: .*; IPP: /);
});

test('settings: protocol and IPP address', () => {
  assert.equal(queryOptions({ name: 'P', host: 'h' }).protocol, 'snmp');
  assert.equal(queryOptions({ name: 'P', host: 'h', protocol: 'IPP' }).protocol, 'ipp');
  assert.equal(queryOptions({ name: 'P', host: 'h', protocol: 'nonsense' }).protocol, 'snmp');
  assert.equal(queryOptions({ name: 'P', host: 'h', protocol: 'auto', ippUrl: ' ipps://h/ipp/print ' }).ippUrl, 'ipps://h/ipp/print');
  assert.equal(queryOptions({ name: 'P', host: 'h', ippUrl: 'ipp://h/x' }).ippUrl, undefined, 'unused with SNMP');
  assert.throws(() => queryOptions({ name: 'P', host: 'h', protocol: 'ipp', ippUrl: 'not a url' }), /IPP address "not a url" isn't valid/);
  // SNMPv3 settings don't matter (and aren't checked) when only IPP is used
  assert.doesNotThrow(() => queryOptions({ name: 'P', host: 'h', protocol: 'ipp', snmpVersion: '3' }));
  assert.throws(() => queryOptions({ name: 'P', host: 'h', protocol: 'auto', snmpVersion: '3' }), /user name/);
});
