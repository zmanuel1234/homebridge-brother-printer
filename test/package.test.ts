// Strict layer: checks the built package, the way Homebridge and npm will load it.
// npm builds dist/ on install (prepare) and the release workflow before packing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { name: string; main: string; type: string; files: string[]; scripts: Record<string, string> };
const schema = JSON.parse(readFileSync(join(root, 'config.schema.json'), 'utf8')) as { pluginAlias: string };
const skip = existsSync(join(root, pkg.main)) ? false : 'dist/ not built; run npm run build';

test('package: the main entry registers the platform under the schema alias', { skip }, async () => {
  const entry = (await import(pathToFileURL(join(root, pkg.main)).href)) as { default: (api: unknown) => void };
  const calls: unknown[][] = [];
  entry.default({ registerPlatform: (...args: unknown[]) => calls.push(args) });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], schema.pluginAlias);
  assert.equal(typeof calls[0][1], 'function');
});

test('package: an ES module, published with its build', () => {
  assert.equal(pkg.type, 'module');
  assert.ok(pkg.files.includes('dist'));
  assert.ok(pkg.files.includes('config.schema.json'));
  assert.match(pkg.main, /^dist\//);
  assert.ok(pkg.scripts.prepare.includes('build'), 'npm must build on git installs and npm ci');
});
