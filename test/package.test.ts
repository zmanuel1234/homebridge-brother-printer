// Checks the built package, the way Homebridge and npm will load it.
// npm builds dist/ on install and before packing or publishing.

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import pkg from '../package.json';

const root = join(__dirname, '..');
const built = existsSync(join(root, pkg.main));
const skip = built ? false : 'dist/ not built; run npm run build';

test('package: main entry registers the platform', { skip }, () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const register = require(join(root, pkg.main)) as (api: unknown) => void;
  assert.equal(typeof register, 'function');
  const calls: unknown[][] = [];
  register({ registerPlatform: (...args: unknown[]) => calls.push(args) });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], pkg.name);
  assert.equal(calls[0][1], 'BrotherPrinter');
  assert.equal(typeof calls[0][2], 'function');
});

test('package: probe command is built and runnable', { skip }, () => {
  const bin = join(root, pkg.bin['brother-printer-probe']);
  assert.ok(existsSync(bin), `${bin} is missing`);
  assert.match(readFileSync(bin, 'utf8'), /^#!\/usr\/bin\/env node/);
});

test('package: published files include the build', () => {
  assert.ok(pkg.files.includes('dist/'));
  assert.ok(pkg.files.includes('config.schema.json'));
  assert.match(pkg.main, /^dist\//);
  assert.ok(pkg.scripts.prepare.includes('build'), 'npm must build before packing and on git installs');
});
