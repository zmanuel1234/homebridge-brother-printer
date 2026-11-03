'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { schema } = require('../config.schema.json');

const walk = (s, path, out) => {
  if (!s || typeof s !== 'object') { return out; }
  if (s.required === true || Array.isArray(s.required)) { out.push(path); }
  for (const [k, v] of Object.entries(s.properties || {})) {walk(v, `${path}.${k}`, out);}
  if (s.items) {walk(s.items, `${path}[]`, out);}
  return out;
};

test('settings screen: no required fields inside the printers list', () => {
  // The Homebridge UI renders a blank row with defaults filled in and validates it
  assert.deepEqual(walk(schema.properties.printers, 'printers', []), []);
});

test('settings screen: every default matches its type', () => {
  const props = schema.properties.printers.items.properties;
  for (const [k, v] of Object.entries(props)) {
    if (!('default' in v)) { continue; }
    const t = typeof v.default;
    const ok = (v.type === 'integer' && Number.isInteger(v.default)) || v.type === t;
    assert.ok(ok, `${k}: default ${JSON.stringify(v.default)} is not ${v.type}`);
    if (v.minimum !== undefined) {assert.ok(v.default >= v.minimum, `${k} below minimum`);}
    if (v.maximum !== undefined) {assert.ok(v.default <= v.maximum, `${k} above maximum`);}
  }
});
