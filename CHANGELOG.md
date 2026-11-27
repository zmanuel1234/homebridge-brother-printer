# Changelog

## 0.12.0-beta.3 - 2026-11-27

### Added
- `tileType: filter` (a trial): the toner / ink tiles as filter life, the level in % with a
  "change" alert while the supply is low, instead of lux or the room's humidity. Apple's Home
  app shows the toner level nowhere else (it doesn't show the battery's level for this
  accessory).
- Test connection shows the printer's firmware; over SNMP, Brother's main firmware
  ("ZE2505240255"). Home's Firmware row still shows the plugin's version unless the printer's
  is a number like 1.14, which HomeKit needs.

### Fixed
- SNMP v1 printers: values a printer doesn't have are remembered, so each poll is one
  request instead of one more per missing value.

## 0.12.0-beta.2 - 2026-11-27

### Changed
- **Sensor names start with the printer's name again** ("Printer Problem", "Printer Toner
  Low", "Printer Tray 1"), which reads better on its own in Home than "Problem". Sensors
  named by earlier versions are renamed; names you set in the Home app stay. Automations and
  notifications are unaffected (the sensors are the same), but Siri goes by the new names.
  Keep the printer's name short: Home cuts long tile names.

### Added
- `sensorNames`: `plain` for the names without the printer's name ("Problem", "Toner Low"),
  as in 0.10 to 0.12.0-beta.1; with several printers they're always prefixed.

## 0.12.0-beta.1 - 2026-11-27

### Added
- **Pages by kind**: color, black-and-white and two-sided pages, where the printer counts
  them (Brother's records over SNMP; `printer-impressions-completed-col` over IPP). They're
  custom characteristics beside Pages Printed on the printer's tile (Eve, Controller), and in
  the log when the printer connects, Test connection and the dashboards
  ("4,944 pages (1,634 two-sided)"). Page counts are shown with thousands separators.

## 0.11.0 - 2026-11-27

Tested as 0.11.0-beta.1 and beta.2 on an MFC-L2750DW: the Bonjour search, the report and both
dashboards.

### Added
- **Bonjour search**: the settings screen's search also asks for printers by Bonjour (as
  AirPrint does), so it finds printers with SNMP off; those are added to be read over IPP,
  at the address they advertise.
- **Finding a printer again after its address changes**: once a printer shows as offline
  (and every 15 minutes after that), the plugin looks for its serial number on the network.
  Another printer answering at its address is no longer taken as this one: it shows as
  offline and is looked for. When it's found, it's read at its new address
  (kept after a restart until the address in the settings changes), and the log says so.
  Only for addresses entered as numbers. Devices are asked without the printer's SNMP
  community or SNMPv3 settings until one is identified.
- **Copy a report** in the settings screen, and `--report` for the probe command: everything
  the printer answers over SNMP and IPP, ready to paste into a GitHub issue. Passwords, the
  community, the SNMPv3 user and the printer's location and contact details are left out;
  the serial number, MAC address and UUIDs are shortened; it's cut to fit an issue.
- **Your printers**, a dashboard at the top of the settings screen: each printer's state,
  levels as bars, recent pages and paper, read when the screen opens.
- `dashboardPort`: the same dashboard on a page of its own, at
  `http://<Homebridge address>:<port>/`, from the plugin's latest readings. Off unless a
  port is set; read-only, showing names, addresses and readings (no serial numbers or other
  settings), and only when opened by an address or a home network name; `dashboardHosts`
  adds others (a reverse proxy's or dynamic DNS name).

### Changed
- When a printer with another serial number answers at a printer's address, it's no longer
  taken as that printer straight away (with a warning): the printer shows as offline while
  the plugin looks for it. The new one is taken as it after answering there for a day
  (never while the settings name another serial number), or at once when its serial number
  is in the settings.
- The package description, keywords and settings header now say any make, over SNMP or IPP.

### Fixed
- Settings screen: the IPP address description showed "ipp://:631/ipp/print", since the
  form drops text in angle brackets.
- Test connection reads a printer known not to answer bulk SNMP requests (the MFC-L2750DW)
  row by row straight away, instead of waiting for a bulk request to time out first (about
  3 seconds).

## 0.10.0 - 2026-11-26

From testing 0.9.0 on a real printer (an MFC-L2750DW) in Apple's Home app; tested there as
0.10.0-beta.1 and beta.2.

### Breaking
- **The Online sensor is now an Offline contact sensor** (`onlineSensor`): it opens when the
  printer stops answering. The occupancy sensor it was ("Online: Triggered") made the room
  show as occupied all the time. It's a new sensor in Home: its name, automations and
  notifications need setting up again.
- **Toner / ink tiles are light sensors by default** (`tileType`), showing the level in lux:
  as humidity sensors, Home counted them as the room's humidity ("Humidity 70%"). Existing
  humidity tiles are replaced by new light tiles (names, automations and scenes on them need
  setting up again). With `eveHistory` on and no `tileType` set, the tiles stay humidity
  sensors, so Eve history carries on.
- **No drum battery** (`showDrum` is gone): Apple's Home app shows only one battery per
  accessory, so it never showed there; Eve and Controller users lose the drum level in those
  apps. The drum stays in the log, Test connection and the Maintenance sensor. The setting is
  ignored, with a note in the log.
- **Sensor names are what they are** ("Toner Low", "Problem", "Tray 1", "Cyan Toner") instead
  of starting with the printer's name, which Home cut off ("Brother Printer Tone…"). With
  several printers they keep the printer's name in front. Names the plugin gave are renamed;
  names you set in the Home app stay (on sensors that are kept; see above for replaced ones).
- Switching `printingSensor` gives the printer a new tile: automations on the old one need
  setting up again.

### Added
- `printingSensor`: show printing as a contact sensor (open while printing) instead of an
  occupancy sensor, which makes the room show as occupied while a job prints. Default:
  occupancy, as before.
- `tileType`: `light` (the default) or `humidity`, for the toner / ink tiles.
- The firmware version a printer gives over IPP, when it's one Home can show (Canon's
  "01.35"); otherwise the plugin's version, as before.

### Changed
- Paper trays over SNMP: each column of the tray table is read on its own, so a printer that
  doesn't answer the tray type or status still gives its trays. A tray table without names
  or levels counts as not read.
- Settings and README: what IPP (AirPrint) reads and doesn't; that the tiles count as the
  room's light level (or humidity); that the page count shows only in Eve and Controller.

### Fixed
- **Paper trays over SNMP on printers that don't answer bulk requests** (GETBULK), such as
  Brother's MFC-L2750DW: they answer the same table one row at a time, so a bulk walk that
  gets no answer is tried again row by row, and that printer is then read row by row. The
  supplies table of other makes is read the same way. The first poll waits one SNMP timeout
  for the bulk try; after that (restarts included) such a printer is read row by row at once.

## 0.9.0 - 2026-11-26

Pages printed, how long the toner or ink should last, and paper trays; better coverage of other
makes. The new tray sensors are off by default. With your current config, Home shows the same
sensors as with 0.8.1 (apart from the fixes below); the log gains a weekly usage line and names a
tray that runs out of paper.

### Added
- **Pages printed and time left**: once a day the plugin notes the page count and levels
  (kept with the accessory in Homebridge's cache, about 120 days).
  Test connection in the settings shows pages printed in the last 7 and 30 days and how
  long the toner or ink should last (per color, soonest first); the log has a weekly line
  with the same, and the low toner warning says how long is left.
- **Paper trays**: Test connection shows each tray (how full, has paper or empty), and the
  log names a tray that runs out. Optional `paperTraySensors`: one contact sensor per tray
  that opens when it's empty. Bypass and manual trays get no sensor or warning.
- The probe command shows the trays too.

### Fixed
- **Inkjets of other makes** read as ink by their model (HP OfficeJet, DeskJet, ENVY; Canon
  PIXMA, MAXIFY, MegaTank; Epson EcoTank, WorkForce, Expression; HP DesignJet…) when their
  supplies don't say so, so the battery and low sensor are named Ink, not Toner. Supplies that
  say toner (and Epson's AL- lasers) keep a printer a laser.
- **Kyocera, Utax and Triumph-Adler** toners named only by part number (TK-5240K, CK-5512M,
  PK-5015Y) get their color from the last letter; before, only a mono printer's showed.
- **Drums and waste toner boxes in % with an unknown maximum** (Sharp) show their level when
  the printer's other supplies count to 100; before, they showed nothing. Like other parts,
  they can now raise the "near end of life" warning (and the Maintenance sensor, if on).
- A printer whose supplies table stops answering, while everything else does, **stays
  online** and keeps its last levels, drum and sensors; before, every poll failed and it
  showed as offline. With `protocol` `auto`, IPP's levels stand in for that poll. The log
  warns once the levels haven't been readable for `offlineAfter` polls in a row, and the
  printer's own toner-low flag still opens the Toner Low sensor meanwhile.

## 0.8.1 - 2026-11-26

The settings screen follows the Homebridge UI's theme. No change to how printers are read.

### Fixed
- Settings screen: the search and connection-test panel now follows the Homebridge UI's theme, light or dark, in any accent color. The text under a search result, the connection-test results and the success and error messages were hard or impossible to read in dark themes (and the test results were faint in light ones); the input boxes were white; and the Test, Add and Save buttons used Bootstrap's own colors instead of the theme's. They now use the UI's own input, select and button styles.

## 0.8.0 - 2026-11-26

Printers of other makes over SNMP, and IPP for more printers and inks. Brother printers
read as before; with your current config 0.8.0 behaves like 0.7.0.

### Added
- **Printers of other makes over SNMP**: without Brother records with levels, the plugin
  reads the standard Printer MIB supplies table, so HP, Canon, Epson, Kyocera, Xerox,
  Ricoh, Konica Minolta, Sharp, OKI, Samsung, Dell and others show their toner or ink per
  color, drums, waste toner box, fuser, transfer belt, developer and maintenance kit.
  Checked against SNMP recordings of about 22 real printer models: levels as % or pages, names in
  other languages (German, Chinese…), part numbers as names, two black toners. Home shows
  the printer's own maker and model (also from the device's description when the model is
  generic or missing). Older Brother models whose records have no levels get the drum (and
  any levels) from it too.
- Search for printers finds printers of any make, not only Brother (a computer's virtual
  printers, such as Microsoft Print To PDF, are left out). A printer whose maker can't be
  named shows as "Printer" in Home, never as Brother.
- **IPP: more printers and inks**, checked against 49 answers recorded from about 44 real
  printer models (Brother, Canon, Epson, HP, Kyocera, Samsung):
  - Extra inks get their own tiles: Photo Black, Gray (light black), Light Cyan, Light
    Magenta, and HP's Tri-color cartridge. Before, a second black (photo black, Canon's
    PGBK) was left out, and so were tri-color cartridges.
  - Printers that name their cartridges `inkCartridge` (many HP inkjets, some Brother)
    now show their levels; before they showed none.
  - Printer colors are matched by name first, then by the nearest color, so other shades
    (Canon's `#00CFFF` cyan) and Canon's two blacks (pigment PGBK and dye BK) read right.
  - A maintenance kit counts as a part for the Maintenance sensor.
  - Home shows the printer's own maker (HP, Epson, Canon…) and model, not "Brother".
- Supply names and display text in Japanese (Shift_JIS) and Traditional Chinese (Big5).

### Changed
- README and settings: what IPP reports, from a real MFC-L2750DW (toner %, but no drum,
  page count or serial number); fewer Brother printers report only "some remaining" than
  the text suggested.

## 0.7.0 - 2026-11-26

Reading over IPP (AirPrint), as an option. SNMP stays the default: with your current
config 0.7.0 behaves like 0.6.0, apart from the Toner Low sensor on printers without
levels (below).

### Added
- **Reading over IPP (AirPrint)** (`protocol`), for printers with SNMP turned off or models
  that report no levels over SNMP:
  - `ipp` reads over IPP only.
  - `auto` reads over SNMP and carries on over IPP when SNMP doesn't answer. Until SNMP
    has answered once, IPP readings count in full; after that IPP only fills in: it
    updates the sensors SNMP set up and can raise low or maintenance warnings, but adds,
    removes and stores nothing, so a missed SNMP answer doesn't change Home.
  - IPP gives the printer's state, its problems (paper, jam, cover, toner, drum, waste
    toner) and the supplies it lists. Many Brother lasers report toner over IPP only as
    "some remaining", with no %.
- `ippUrl` (default `ipp://<host>:631/ipp/print`) and, for `ipps://`,
  `ippAllowSelfSigned` to accept the printer's self-signed certificate (off by default;
  the certificate is otherwise checked).
- The probe command takes `--protocol ipp|auto`, `--ipp-url` and `--ipp-self-signed`, and
  Test connection in the settings shows which protocol answered.

### Changed
- Printers that report no toner or ink levels keep the Toner Low sensor (`lowTonerSensor`),
  which now follows the printer's own low flag; before, it was removed.

## 0.6.0 - 2026-11-26

New optional sensors, SNMPv3, a printer search in the settings screen, and Eve history.
Every new option is off by default; with your current config 0.6.0 behaves like 0.5.2,
except that renaming a printer now keeps it in Home (below).

### Added
- Optional **Out of Paper** contact sensor (`paperSensor`): opens when a tray is empty, so
  Home notifies it by name. The Problem sensor still opens for this too.
- Optional **Maintenance** contact sensor (`maintenanceSensor`): opens when the drum, belt,
  fuser, laser unit, paper feed kit or ink waste box is at or below `lowDrumThreshold`.
  Until now these only logged a warning.
- Optional **Online** occupancy sensor (`onlineSensor`): Detected while the printer answers.
  Unlike the other sensors it stays readable while the printer is offline, so automations
  can run on it (for example, turning off the printer's smart plug).
- **SNMPv3** (`snmpVersion` `3`), for printers with v1/v2c turned off: user name, MD5 or
  SHA authentication and DES or AES encryption. The settings screen shows these fields once
  v3 is picked, with an optional context name; missing or invalid SNMPv3 settings
  (including an unknown protocol) are reported at startup. The probe command takes
  `--v3 <user>` and the matching options.
- **Search for printers** and **Test connection** at the top of the settings screen: find
  Brother printers on the network (one SNMP broadcast, no extra setup) and add them with
  their address and serial number, or read a printer with the settings as entered before
  saving.
- Optional `serial` setting, filled in by the search.
- Optional **Eve history** of the toner or ink level (`eveHistory`, with `tonerTile`): a
  graph over about 60 days on the toner / ink tiles in the Eve app. Uses fakegato-history,
  which adds about 250 MB to the install (Google's API client) and is only loaded when
  this is on.

### Changed
- **Renaming a printer keeps it in Home**: its room, automations and notifications stay,
  and its sensors are renamed to match, except ones renamed in the Home app. It's
  recognised by its serial number (when set), its name and address, or its address alone
  (the address wins when name and address point to different printers). Before, a new
  name meant a new accessory.
- A warning in the log when the printer at an address has a different serial number than
  before, or than the one in the settings.
- A printer that can't be set up (for example, invalid SNMPv3 settings) shows No Response
  in Home instead of its last values.
- README: how this plugin compares with AirPrint (IPP) plugins such as
  @homebridge-plugins/homebridge-printer.
- Issue forms for printer reports (with the probe output) and bugs.
- New dependencies: @homebridge/plugin-ui-utils (the settings screen) and fakegato-history
  (Eve history; it brings Google's API client, about 250 MB).
- Development only: oxlint also checks ESLint's no-dupe-args and no-octal again.

## 0.5.2 - 2026-11-26

No change to how the plugin works: the compiled plugin is identical to 0.5.1's.

### Changed
- Development only: built with TypeScript 7 (the native compiler) and linted with oxlint instead
  of TypeScript 6 and ESLint, with the same rules. CI retries npm's package signature check up to
  3 times, because npm's registry sometimes answers it with an invalid response.

## 0.5.1 - 2026-11-26

No change to how the plugin works.

### Changed
- Development only: CI runs the tests on Node 22, 24 and 26 in a single check.

## 0.5.0 - 2026-11-22

No new settings; with your current config, 0.5.0 behaves like 0.4.0. Check your Node.js version
before updating (below).

### Changed
- **Requires Node.js 22.19 or later, 24 or 26** (dropped 18 and 20, which no longer get security updates; on Node 22, 22.19 is the minimum across the author's plugins). Check with `node -v` or on the Homebridge UI's status page before updating.
- Development only, nothing changes for users: TypeScript 6.0 and the same ESLint and
  Dependabot setup as the author's other plugins. ESLint checks for likely bugs (unhandled
  promises and similar) instead of formatting; it runs once in CI, on Node 24, while the tests
  still run on every supported Node version.
- Development only: lint refuses `any` in the plugin's code (the config's printer list is read as
  `unknown` and each entry checked, as it already was). New tests set up real printer
  accessories through the platform: registering, reusing cached ones, duplicate names, removing
  printers taken out of the config, a printer that fails to set up, shutdown, cached toner tiles,
  and an error while updating HomeKit.
- Development only: the same release and CI workflows as the author's other plugins. Publishing a GitHub release publishes it to npm (with trusted publishing; the package and its checksum are added to the release); each repository's checks are its `verify`, `test:matrix` and `release:check` scripts.

## 0.4.0 - 2026-11-08

### Changed
- Rewritten in TypeScript. The published package is compiled JavaScript in `dist/`;
  behavior, settings and supported Node and Homebridge versions are unchanged.
- Tests are TypeScript too and are type-checked with the plugin.
- npm builds the plugin on install, `npm pack` and `npm publish`, so a package made any
  of those ways (including installing from GitHub) contains the compiled plugin.
- `npm publish` lints and tests first.

## 0.3.1 - 2026-11-07

### Fixed
- Inkjets: the battery is now named Ink instead of Toner, unless you renamed it in Home.
- Printers that report no levels no longer get a battery added and removed again on every
  restart.
- Settings that aren't numbers (for example in a hand-edited `config.json`) fall back to
  their defaults. Before, a non-numeric low toner threshold meant the low alert never fired.
- Numeric settings are kept within the ranges the settings screen allows.

### Changed
- README: notes that renaming a printer creates a new accessory, and how long going
  offline takes before the printer has answered.
- Tests for the battery, settings, No Response and the Problem sensor; tests and lint run
  on GitHub Actions for every push and pull request.

## 0.3.0 - 2026-11-07

### Added
- Optional Toner Low contact sensor (`lowTonerSensor`, Ink Low on inkjets). It opens when
  the toner or ink is low, by the same rule as the battery, so Home sends a notification
  with its own name instead of "battery is low". Off by default.

## 0.2.2 - 2026-11-03

### Changed
- Added the `supports-hap` keyword, which Homebridge plugin verification requires.

## 0.2.1 - 2026-11-03

### Fixed
- Settings screen: each printer's fields now form one group. Before, Sensors, Advanced and
  the name/host fields each acted as a separate printer, so the screen showed values from a
  blank entry (for example a 60 s poll interval when 10 was saved) and saved empty printer
  rows. Remove any empty printer rows left in your config.
- Port, poll interval and offline count are number boxes instead of sliders.

## 0.2.0 - 2026-11-03

### Added
- Color lasers: toner per color, drum per color, belt, fuser, laser unit and paper feed kits.
- Inkjets: ink per color and the ink waste box. Toner wording becomes Ink.
- The battery shows the lowest color, and turns low when any color reaches the threshold by
  either reading, or when the printer flags low toner.
- Toner / ink tiles: one per color on color printers.
- SNMP v1 for older printers (`snmpVersion`, automatic by default).
- Printers that report no levels (older and ink tank models) get no battery instead of 0%.
- Warnings in the log when the drum or another part nears end of life.
- Problem log lines name the condition (cover open, paper jam...).
- Page count from mono + color counts on inkjets that don't report a total.

### Changed
- Status text is decoded in the printer's character set, so non-English displays read
  correctly. Problems and printing rely on language-neutral status codes first.
- Model and serial also read from Brother's own records, for printers without the
  standard ones; page count falls back to the Printer MIB.
- When coarse levels tie (they move in 10% steps), the finer reading picks the lowest
  color, so the battery names the color that is actually running out.
- Tested against SNMP captures from 14 Brother models.

## 0.1.4 - 2026-11-03

First public release.

### Added
- Printing state as an occupancy sensor, from `hrPrinterStatus` and the printer's display.
- Printer Problem contact sensor that opens on a jam, open cover, empty tray or other error.
  Apple Home doesn't show Status Fault on occupancy sensors.
- Toner % as a battery level with a configurable low threshold, read from Brother's own
  SNMP records rather than the standard Printer MIB.
- No Response in the Home app while the printer can't be reached, recovering when it answers.
- Optional toner tile (humidity sensor) and optional drum-life battery.
- Page count as a custom characteristic.
- `brother-printer-probe` command to check what a printer reports.
- Settings screen, tests and linting.

### Changed
- Drum life is off by default: Home shows one battery per accessory and was showing the
  drum instead of the toner. The drum is still read and warned about in the log.
- Settings screen no longer reports a validation error for the blank printer row it adds.
  Rows without a host are ignored, with a warning only if they were filled in.

## 0.1.3 - 2026-11-03

Private pre-releases (0.1.0 to 0.1.3), tested on an MFC-L2750DW.
