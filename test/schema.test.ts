import test from 'node:test';
import assert from 'node:assert/strict';
import config from '../config.schema.json';

interface SchemaNode {
  type?: string;
  default?: unknown;
  minimum?: number;
  maximum?: number;
  required?: boolean | string[];
  properties?: Record<string, SchemaNode>;
  items?: SchemaNode;
}
type LayoutItem = string | { key?: string; type?: string; items?: LayoutItem[] };

const schema = config.schema as unknown as { properties: { printers: SchemaNode & { items: SchemaNode } } };
const layout = config.layout as unknown as LayoutItem[];

const required = (s: SchemaNode | undefined, path: string, out: string[]): string[] => {
  if (!s || typeof s !== 'object') { return out; }
  if (s.required === true || Array.isArray(s.required)) { out.push(path); }
  for (const [k, v] of Object.entries(s.properties || {})) { required(v, `${path}.${k}`, out); }
  if (s.items) { required(s.items, `${path}[]`, out); }
  return out;
};

const flatten = (items: LayoutItem[], out: LayoutItem[] = []): LayoutItem[] => {
  for (const i of items) {
    if (typeof i === 'object' && i.items) { flatten(i.items, out); } else { out.push(i); }
  }
  return out;
};

test('settings screen: no required fields inside the printers list', () => {
  // The Homebridge UI renders a blank row with defaults filled in and validates it
  assert.deepEqual(required(schema.properties.printers, 'printers', []), []);
});

test('settings screen: every default matches its type', () => {
  const props = schema.properties.printers.items.properties || {};
  for (const [k, v] of Object.entries(props)) {
    if (!('default' in v)) { continue; }
    const ok = (v.type === 'integer' && Number.isInteger(v.default)) || v.type === typeof v.default;
    assert.ok(ok, `${k}: default ${JSON.stringify(v.default)} is not ${v.type}`);
    if (typeof v.default !== 'number') { continue; }
    if (v.minimum !== undefined) { assert.ok(v.default >= v.minimum, `${k} below minimum`); }
    if (v.maximum !== undefined) { assert.ok(v.default <= v.maximum, `${k} above maximum`); }
  }
});

test('settings screen: each printer is one group, not one entry per section', () => {
  // A list layout with several top-level items makes the UI treat each as its
  // own printer: values show from the wrong entry and blank rows get saved.
  const list = layout.find((l) => typeof l === 'object' && l.key === 'printers');
  assert.ok(typeof list === 'object' && list.items);
  assert.equal(list.items.length, 1);
  const group = list.items[0];
  assert.ok(typeof group === 'object' && Array.isArray(group.items) && group.items.length > 1);
});

test('settings screen: ports and counts are number boxes, not sliders', () => {
  const flat = flatten(layout);
  for (const key of ['printers[].port', 'printers[].pollInterval', 'printers[].offlineAfter']) {
    const item = flat.find((i) => typeof i === 'object' && i.key === key);
    assert.ok(typeof item === 'object' && item.type === 'number', `${key} should be a number box`);
  }
});
