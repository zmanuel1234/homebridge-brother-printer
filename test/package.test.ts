// Checks the built package, the way Homebridge and npm will load it.
// npm builds dist/ on install (prepare) and the release workflow before packing.

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import pkg from '../package.json';

const root = join(__dirname, '..');
const built = existsSync(join(root, pkg.main));
const skip = built ? false : 'dist/ not built; run npm run build';
const schema = JSON.parse(readFileSync(join(root, 'config.schema.json'), 'utf8')) as { pluginAlias: string };

test('package: main entry registers the platform under the schema alias', { skip }, () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const register = require(join(root, pkg.main)) as (api: unknown) => void;
  assert.equal(typeof register, 'function');
  const calls: unknown[][] = [];
  register({ registerPlatform: (...args: unknown[]) => calls.push(args) });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], pkg.name);
  assert.equal(calls[0][1], schema.pluginAlias);
  assert.equal(typeof calls[0][2], 'function');
});

test('package: published files include the build', () => {
  assert.ok(pkg.files.includes('dist/'));
  assert.ok(pkg.files.includes('config.schema.json'));
  assert.match(pkg.main, /^dist\//);
  assert.ok(pkg.scripts.prepare.includes('build'), 'npm must build on git installs and npm ci');
});
