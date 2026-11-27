# homebridge-plugin-template

[![npm](https://img.shields.io/npm/v/homebridge-plugin-template)](https://www.npmjs.com/package/homebridge-plugin-template)
[![npm downloads](https://img.shields.io/npm/dt/homebridge-plugin-template)](https://www.npmjs.com/package/homebridge-plugin-template)
[![CI](https://github.com/zmanuel1234/homebridge-plugin-template/actions/workflows/ci.yml/badge.svg)](https://github.com/zmanuel1234/homebridge-plugin-template/actions/workflows/ci.yml)
[![license](https://img.shields.io/github/license/zmanuel1234/homebridge-plugin-template)](LICENSE)
[![Sponsor](https://img.shields.io/badge/Sponsor-zmanuel1234-EA4AAA?logo=githubsponsors&logoColor=white)](https://github.com/sponsors/zmanuel1234)
[![Buy me a coffee](https://img.shields.io/badge/Buy%20me%20a%20coffee-zmanuel-FFDD00?logo=buymeacoffee&logoColor=black)](https://www.buymeacoffee.com/zmanuel)

A starting point for a new Homebridge plugin, set up exactly like the author's other plugins
(homebridge-brother-printer, homebridge-comelit-doorbell, homebridge-ir-patio-heater,
homebridge-lg-thinq-connect, homebridge-ring-secure-video): the same CI and release workflows,
checks, lint rules, Dependabot settings and issue forms. As it stands, it adds one example switch
to the Home app, which can turn itself off again after a set time.

## Starting a new plugin

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
   and deletes itself.
3. Repository settings, as in the other plugins:
   - **Rulesets** (Settings → Rules → Rulesets): `main` on the default branch (restrict deletions,
     block force pushes, require a pull request with 0 approvals, require the status checks
     `check` and `dependency-review`) and `version` on tags `refs/tags/v*` (restrict creations
     is off; restrict updates and deletions, block force pushes).
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

Then replace the example switch in `src/` with the real accessories, and this README's text
with the plugin's own.

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
  "platform": "ExamplePlatform",
  "name": "Plugin Template",
  "switchName": "Example Switch",
  "resetSeconds": 0
}
```

| Setting | Default | What it does |
| --- | --- | --- |
| `switchName` | `Example Switch` | The switch's name in the Home app. |
| `resetSeconds` | `0` | Turns the switch off again after this many seconds (up to 3600); 0 leaves it on. |

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
```

`npm publish` runs `npm run verify` first.

Releases are published to npm by GitHub Actions (`.github/workflows/publish.yml`, the same in the author's other plugins) when a GitHub release is published. The tag must be `v` followed by the version in `package.json`, and **Set as a pre-release** must be ticked exactly for a version with a `-`; a release without notes gets the CHANGELOG section for the version. The workflow runs `npm run release:check`, adds the package and its `SHA256SUMS` to the release, and publishes that package with npm's trusted publishing: a `-dev-` version to npm's `dev` tag, any other pre-release to `beta`, a stable version to `latest` (and then removes an older `beta`). **Run workflow** with a release's tag publishes a release that already exists. CI (`.github/workflows/ci.yml`, also shared) runs `npm run verify` on Node 24 and `npm run test:matrix` on Node 22, 24 and 26.

## License

MIT
