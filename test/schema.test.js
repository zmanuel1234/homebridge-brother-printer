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

test('settings screen: each printer is one group, not one entry per section', () => {
  // A list layout with several top-level items makes the UI treat each as its
  // own printer: values show from the wrong entry and blank rows get saved.
  const { layout } = require('../config.schema.json');
  const list = layout.find((l) => l && l.key === 'printers');
  assert.equal(list.items.length, 1);
  assert.ok(Array.isArray(list.items[0].items) && list.items[0].items.length > 1);
});

test('settings screen: ports and counts are number boxes, not sliders', () => {
  const { layout } = require('../config.schema.json');
  const flat = [];
  const walk = (items) => items.forEach((i) => (i && i.items ? walk(i.items) : flat.push(i)));
  walk(layout);
  for (const key of ['printers[].port', 'printers[].pollInterval', 'printers[].offlineAfter']) {
    const item = flat.find((i) => i && i.key === key);
    assert.ok(item && item.type === 'number', `${key} should be a number box`);
  }
});
