# homebridge-brother-printer

[![npm](https://badgen.net/npm/v/homebridge-brother-printer)](https://www.npmjs.com/package/homebridge-brother-printer)
[![license](https://badgen.net/github/license/zmanuel1234/homebridge-brother-printer)](LICENSE)

Shows a Brother laser or inkjet printer in HomeKit: whether it's printing, whether it
needs attention, and how much toner or ink is left. Everything is read locally over SNMP,
with no cloud or Brother account.

Generic AirPrint/IPP plugins can't show real toner levels on many Brother printers,
because the standard Printer MIB only reports "some remaining". Brother's own SNMP
records carry the actual percentages shown on the printer's web page, and this plugin
reads those.

Each printer gets these sensors:

- **Printer** (occupancy sensor): Detected while a job prints. Use it in automations.
- **Printer Problem** (contact sensor): Open on a jam, open cover, empty tray or other
  error. Turn on notifications for it in the Home app.
- **Toner / Ink** (battery level on the Printer accessory): the toner or ink %, with Home's
  native low-battery alert at or below your threshold. On color printers it shows the
  lowest color, so the alert fires when any color runs low.
- **Toner Low** (optional contact sensor): Opens when the toner or ink is low, so Home
  notifies it by name instead of "battery is low".
- **Toner / ink tiles** (optional humidity sensors): the level as a number on its own tile,
  one per color on color printers.

While the printer can't be reached, all of them show No Response.

## Requirements

- A Brother printer with SNMP. Tested on a real **MFC-L2750DW**, and against SNMP
  captures from these models (from the [brother](https://github.com/bieniu/brother)
  library, which Home Assistant's Brother integration uses):

  | Kind | Models | What's read |
  |---|---|---|
  | Mono laser | MFC-L2750DW, HL-L2340DW, DCP-L2540DN, DCP-7070DW, DCP-1618W | Toner, drum |
  | Color laser | DCP-L3550CDW, DCP-9020CDW | Toner per color, drums, belt, fuser, paper feed kit |
  | Inkjet | MFC-J680DW, MFC-J5110DW, DCP-J132W, DCP-T735DW, MFC-5490CN | Ink per color, ink waste box |
  | Older / ink tank | HL-2270DW, HL-5350DN, MFC-T910DW | Status, problems, page count; these don't report levels |

  Other Brother models generally use the same records. Reports, with the probe output
  below, are welcome.
- SNMP turned on in the printer's web page: **Network → Protocol → SNMP** (v1/v2c,
  read-only is enough). The default community is `public`.
- A fixed address for the printer: reserve its IP in your router, or use its mDNS
  hostname (for example `brn3c2af4919dfc.local`).
- Homebridge 1.6 or later (including 2.x), Node.js 18, 20, 22 or 24.

## Installation

Search for **Brother Printer** in the Homebridge UI's Plugins tab, or run:

```bash
npm install -g homebridge-brother-printer
```

Running it as a child bridge is recommended.

## Configuration

Set it up in the plugin's settings screen, or in `config.json`:

```json
{
  "platform": "BrotherPrinter",
  "printers": [
    {
      "name": "Printer",
      "host": "10.0.4.150"
    }
  ]
}
```

| Option | Default | Description |
|---|---|---|
| `name` | `Printer` | Accessory name. Must be unique per printer. Changing it later creates a new accessory: its room, automations and notification settings in Home start over. |
| `host` | | Printer IP address or hostname. Printers without one are ignored. |
| `community` | `public` | SNMP community string. |
| `port` | `161` | SNMP port. |
| `snmpVersion` | `auto` | `auto` tries v2c, then v1. Set `1` for older printers that only answer v1. |
| `pollInterval` | `60` | Seconds between polls (10–3600). |
| `lowTonerThreshold` | `10` | Toner or ink % at or below which Home shows it as low (any color, on color printers). |
| `lowTonerSensor` | `false` | Add a Toner Low contact sensor (Ink Low on inkjets) that opens when any supply is low, by the same rule as the battery. |
| `faultSensor` | `true` | Add the Printer Problem contact sensor. |
| `tonerTile` | `false` | Add humidity sensors showing the toner or ink %, one per color on color printers. They also count in Home's climate summary. |
| `showDrum` | `false` | Add drum life as a second battery. See below. |
| `lowDrumThreshold` | `10` | Drum and parts % (belt, fuser, laser unit, paper feed kit, ink waste box) at or below which a warning is logged, and the drum battery shows low. |
| `offlineAfter` | `3` | Failed polls in a row before the printer shows No Response. |
| `debug` | `false` | Log every poll at info level. |

## What the Home app shows

HomeKit has no printer accessory type, so the plugin uses the closest sensors and Home
words them its own way:

- The printing sensor reads **Detected** / **Not Detected**.
- Low toner or ink is announced as **"battery is low"**. For a clearer message, turn on
  `lowTonerSensor`: its contact sensor opens at the same point and Home notifies it by
  name, as it does for any contact sensor that opens. Turn on its notifications in the
  Home app.
- Home shows only one battery per accessory. With `showDrum` on, it may show the drum
  instead of the toner, which is why the drum is off by default. It's still read, and the
  plugin logs a warning when it nears end of life. Apps like Eve show both.
- The page count is a custom characteristic, visible in Eve, Controller and the Homebridge
  UI, not in Apple Home.

## Levels and low alerts

Brother printers report two readings per supply: a coarse one (the number on the
printer's web page and display) and a finer one. The battery and tiles show the coarse
one, so they match the printer. A supply counts as low when either reading is at or below
`lowTonerThreshold`, or when the printer itself flags low toner, so a cartridge that shows
10% but is really at 2% still raises the alert.

Printers without level reporting (some older models and ink tank printers) get no
battery; status, problems and the page count still work.

## Going offline

The time before a printer shows No Response is about
`offlineAfter` × (`pollInterval` + 10 s), where 10 s is the SNMP timeout. With the
defaults that's about 3.5 minutes; `pollInterval: 30` with `offlineAfter: 1` brings it to
about 40 s. With `offlineAfter: 1`, a single lost packet can make it flash No Response for
one poll.

If the printer hasn't answered since Homebridge started and `snmpVersion` is `auto`, each
poll tries v2c and then v1, so the timeout counts twice (about 20 s per poll). Once it has
answered, the version that worked is used.

Brother lasers normally still answer SNMP in Sleep and Deep Sleep.

## Checking what your printer reports

The package includes a command that prints what the plugin reads:

```bash
npx -p homebridge-brother-printer brother-printer-probe 10.0.4.150
```

Compare `tonerPercent` with **Remaining Life** on the printer's web page. If it doesn't
match, or values are `null`, please open an issue with the probe output and your printer
model.

## Troubleshooting

- **"Can't reach … Request timed out"**: SNMP is off on the printer, the address is wrong,
  or a firewall blocks UDP port 161. Test from the Homebridge machine with
  `snmpget -v2c -c public <printer-ip> 1.3.6.1.2.1.1.1.0` (from the `snmp` package).
- **Status text in another language**: the plugin reads the printer's character set, so
  the log shows the display text as the printer shows it. Problems and printing are
  detected from language-neutral status codes, with English display text as a fallback.
- **Old printer never connects**: set `snmpVersion` to `1`.
- **Toner shows 0% with a full cartridge**: some non-genuine cartridges aren't recognised
  by the printer, which then reports no level.

## How it works

Brother printers expose maintenance data as packed records in their private MIB
(`1.3.6.1.4.1.2435.2.3.9.4.2.1.5.5.8`, `.5.10` and `.5.11`). Each record is a one-byte
code, `0x01`, a length byte and a big-endian value; older models use a two-byte
current/max form. The main codes:

| Code | Meaning |
|---|---|
| `0x81`–`0x84` | Black, cyan, magenta, yellow toner or ink, % (coarse) |
| `0x6f`–`0x72`, `0xa1`–`0xa4` | The same, finer reading |
| `0x41`, `0x80`, `0x79`–`0x7b` | Drum life (mono; black, cyan, magenta, yellow) |
| `0x69`–`0x6d`, `0x85` | Belt, fuser, laser unit, paper feed kits, ink waste box |
| next care `0x82`, `0xa4`–`0xa7` | Drum pages remaining |
| counter `0x00` | Total pages printed |

Printing and problem state come from the standard Host Resources MIB (`hrPrinterStatus`,
`hrPrinterDetectedErrorState`), with the display text as a fallback.

The record codes follow the [brother](https://github.com/bieniu/brother) Python library
by Maciej Bieniek (Apache-2.0), and the tests use SNMP captures from its test suite.

## Development

The plugin and its tests are written in TypeScript (`src/`, `test/`). It's published as
compiled JavaScript (`dist/`), which npm builds on `npm ci`, `npm pack` and `npm publish`.

```
npm ci          # installs and builds
npm test        # runs the tests against the TypeScript sources
npm run lint    # ESLint and type checking
npm run build   # build only
```

`npm publish` lints and tests first.

## License

MIT
