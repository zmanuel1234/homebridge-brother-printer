// Reading a printer over IPP (AirPrint): the message format, mapping the
// printer's attributes onto the plugin's readings, and the protocol choice.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { TAG, getPrinterAttributes, ippEndpoint, ippMessage, ippQuery, parseResponse, reasonErrors, toPrinterData } from '../src/ipp';
import type { IppAttribute, IppAttributes } from '../src/ipp';
import { defaultIppUrl, readPrinter } from '../src/read';
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
  assert.equal(d.parts.inkWasteBox?.percent, 30);
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
  const refused = await fakeIppPrinter(() => ({ body: response([], 0x0400) }));
  const silent = await fakeIppPrinter(() => null);
  t.after(() => { notFound.close(); refused.close(); silent.close(); });
  await assert.rejects(ippQuery({ url: notFound.url }), /HTTP 404/);
  await assert.rejects(ippQuery({ url: refused.url }), /refused \(status 0x0400\)/);
  await assert.rejects(ippQuery({ url: silent.url, timeout: 300 }), /timed out/);
});

test('reading: IPP only, SNMP only, and auto falling back to IPP', async (t) => {
  const ipp = await fakeIppPrinter((body) => ({ body: response(COLOR, 0, body.readUInt32BE(4)) }));
  t.after(() => ipp.close());
  const viaIpp = await readPrinter({ host: '127.0.0.1', protocol: 'ipp', ippUrl: ipp.url });
  assert.equal(viaIpp.via, 'ipp');
  assert.equal(viaIpp.snmpVersion, null);

  // No SNMP agent on this port: auto falls back to IPP and remembers it
  const state: { protocol?: 'snmp' | 'ipp' } = {};
  const auto = await readPrinter({ host: '127.0.0.1', port: 16195, timeout: 300, retries: 0, protocol: 'auto', ippUrl: ipp.url, state });
  assert.equal(auto.via, 'ipp');
  assert.equal(state.protocol, 'ipp');
  const before = ipp.requests.length;
  await readPrinter({ host: '127.0.0.1', port: 16195, timeout: 300, retries: 0, protocol: 'auto', ippUrl: ipp.url, state });
  assert.equal(ipp.requests.length, before + 1, 'IPP is tried first next time');

  // With SNMP answering, auto uses SNMP
  const snmpPrinter = await startFakePrinter(16196);
  t.after(() => snmpPrinter.close());
  const viaSnmp = await readPrinter({ host: '127.0.0.1', port: 16196, protocol: 'auto', ippUrl: ipp.url, state: {} });
  assert.equal(viaSnmp.via, undefined);
  assert.equal(viaSnmp.snmpVersion, '2c');
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
