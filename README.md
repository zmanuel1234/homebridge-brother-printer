# Plugin Template

A Homebridge dynamic platform plugin: the example from Homebridge's own plugin template, with
three light bulbs (one also an Eve accessory) and a motion sensor on each.

## Using this template

This repository is [homebridge/homebridge-plugin-template](https://github.com/homebridge/homebridge-plugin-template)
with a stricter setup on top. It shares that template's git history, so Homebridge's changes can be
merged in rather than copied.

### Starting a new plugin

1. On GitHub, **Use this template → Create a new repository**, named like the npm package
   (`homebridge-…`), public.
2. In a clone of it, run the setup once, then commit:

   ```
   node tools/new-plugin.mjs homebridge-my-device MyDevicePlatform "My Device"
   npm install
   npm run verify
   ```

   It renames the package, the platform (the `platform` users write in config.json) and the
   display name everywhere, resets the version to 0.1.0 and the changelog, removes this section
   and the weekly sync job, and deletes itself.
3. Repository settings, as in the other plugins:
   - **Rulesets** (Settings → Rules → Rulesets): `main` on the default branch (restrict deletions,
     block force pushes, require a pull request with 0 approvals, require the status checks
     `check` and `dependency-review` from GitHub Actions) and `version` on tags `refs/tags/v*`
     (restrict creations is off; restrict updates and deletions, block force pushes).
   - **Advanced Security** (Settings → Advanced Security): Dependabot alerts and security updates,
     CodeQL default setup, secret scanning with push protection, private vulnerability reporting.
   - **General**: automatically delete head branches; no wiki or projects.
4. On npmjs.com: the first version is published once from your computer (`npm publish`, which
   runs `npm run verify` first), because a trusted publisher can only be set up on a package
   that exists. Then, in the package's **Settings**: **Trusted Publisher** → GitHub Actions, this
   repository, workflow `publish.yml`, with **npm dist-tag** allowed; **Publishing access** →
   require two-factor authentication and disallow tokens. Every later version is published by
   creating a GitHub release.
5. Add the new repository's name to the header comments of the shared files (ci.yml,
   publish.yml, dependency-review.yml, dependabot.yml, .oxlintrc.json and the two check
   scripts) in every plugin, so they stay the same everywhere.

Then replace the example in `src/` with the real accessories (Homebridge's
[developer documentation](https://developers.homebridge.io/) lists the services and
characteristics), the settings in `config.schema.json`, and this README's text with the plugin's own.

### What differs from Homebridge's template

Everything Homebridge's template has is kept (the example platform and accessory, `nodemon.json`
and `npm run watch`, `test/hbConfig`, the homebridge-lib Eve types, `.vscode`, Apache-2.0), except:

- **Linting:** oxlint (`.oxlintrc.json`, and the oxc extension in `.vscode`) instead of ESLint, the same rules as the other plugins.
  ESLint's TypeScript plugin doesn't support TypeScript 7 yet.
- **TypeScript 7**, with type checking (`tsconfig.json`, which also covers the tests) kept apart
  from the build (`tsconfig.build.json`, `src/` to `dist/`), and stricter options
  (`noImplicitOverride`, `noFallthroughCasesInSwitch`).
- **Homebridge 2 only**, on Node.js 22, 24 or 26.
- **Tests** with Node's test runner: the example runs against real HAP services (accessories
  registered, restored from the cache and removed, values remembered, the motion sensors stopped
  at shutdown), and the package loads and registers its platform.
- **The example is fully typed:** no `any` or `!`; the accessory's context has a type
  (`ExampleDevice`), a restored accessory gets the current device in its context before use,
  homebridge-lib's Eve types have strict declarations (`src/@types/homebridge-lib.d.ts`, which in Homebridge's template uses `any`), and the motion
  timer is cleared when Homebridge shuts down.
- **Workflows:** `ci.yml` (verify, the Node matrix, npm signature audit), `publish.yml`
  (trusted publishing on a GitHub release) and `dependency-review.yml`, shared byte for byte with
  the other plugins, instead of `build.yml`; Dependabot, issue forms instead of issue templates,
  `SECURITY.md` and `CHANGELOG.md`.
- **Checks** run by `npm run verify`: the package layout Homebridge needs
  (`.github/scripts/check-homebridge.mjs`) and the settings schema and this README's JSON examples
  (`.github/scripts/check-config-schema.mjs`).
- `npm run watch` builds to `dist/` with `npm run build` before each restart, since `tsc` alone
  only type checks here.

### Keeping up with Homebridge's template

Every Monday `.github/workflows/upstream-sync.yml` checks Homebridge's template (branch `latest`)
and, when it has changed, opens a pull request from the `upstream-sync` branch. It needs
**Settings → Actions → General → Allow GitHub Actions to create and approve pull requests**.
Resolve any conflicts in favour of the stricter setup above, run `npm run verify`, and merge with
**Create a merge commit** (not squash), so the shared history continues. To do it by hand:

```
git remote add upstream https://github.com/homebridge/homebridge-plugin-template.git
git fetch upstream
git merge upstream/latest
```

## Requirements

- Homebridge 2 (2.0.0 or later).
- Node.js 22, 24 or 26.

## Installation

In the Homebridge UI, search the **Plugins** page for `homebridge-plugin-template`, or run:

```
npm install -g homebridge-plugin-template
```

## Configuration

Set it up in the plugin's settings in the Homebridge UI, or add a platform block to config.json:

```json
{
  "platform": "ExampleHomebridgePlugin",
  "name": "Example Dynamic Platform"
}
```

| Setting | Default | What it does |
| --- | --- | --- |
| `name` | `Example Dynamic Platform` | The platform's name in the Homebridge log. |

## Development

The plugin and its tests are written in TypeScript (`src/`, `test/`). It's published as
compiled JavaScript (`dist/`), which npm builds on `npm ci`, `npm pack` and `npm publish`.

```
npm ci          # installs and builds
npm test        # runs the tests against the TypeScript sources
npm run check   # type checking
npm run lint    # oxlint
npm run build   # build only
npm run verify  # everything CI checks, including the settings schema and README examples
npm run watch   # rebuilds and restarts a local Homebridge (test/hbConfig) on every change
```

`npm publish` runs `npm run verify` first.

Releases are published to npm by GitHub Actions (`.github/workflows/publish.yml`, the same in the author's other plugins) when a GitHub release is published. The tag must be `v` followed by the version in `package.json`, and **Set as a pre-release** must be ticked exactly for a version with a `-`; a release without notes gets the CHANGELOG section for the version. The workflow runs `npm run release:check`, adds the package and its `SHA256SUMS` to the release, and publishes that package with npm's trusted publishing: a `-dev-` version to npm's `dev` tag, any other pre-release to `beta`, a stable version to `latest` (and then removes an older `beta`). **Run workflow** with a release's tag publishes a release that already exists. CI (`.github/workflows/ci.yml`, also shared) runs `npm run verify` on Node 24 and `npm run test:matrix` on Node 22, 24 and 26.

Each version has a section in `CHANGELOG.md`: `## 1.2.3 - date`, an optional one-line summary, then bullets (no Added/Changed/Fixed headings). A release published without notes takes that section as its notes.

## License

Apache-2.0, as Homebridge's template.
