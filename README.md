# homebridge-brother-printer

[![npm](https://badgen.net/npm/v/homebridge-brother-printer)](https://www.npmjs.com/package/homebridge-brother-printer)
[![license](https://badgen.net/github/license/zmanuel1234/homebridge-brother-printer)](LICENSE)

Shows a Brother laser printer in HomeKit: whether it's printing, whether it needs
attention, and how much toner is left. Everything is read locally over SNMP, with no
cloud or Brother account.

Generic AirPrint/IPP plugins can't show real toner levels on many Brother printers,
because the standard Printer MIB only reports "some remaining". Brother's own SNMP
records carry the actual percentages shown on the printer's web page, and this plugin
reads those.

Each printer gets these sensors:

- **Printer** (occupancy sensor): Detected while a job prints. Use it in automations.
- **Printer Problem** (contact sensor): Open on a jam, open cover, empty tray or other
  error. Turn on notifications for it in the Home app.
- **Toner** (battery level on the Printer accessory): the toner %, with Home's native
  low-battery alert at or below your threshold.
- **Printer Toner** (optional humidity sensor): the toner % as a number on its own tile.

While the printer can't be reached, all of them show No Response.

## Requirements

- A Brother laser printer with SNMP. Tested on an **MFC-L2750DW**. Other mono lasers from
  the same generation (HL-L23xx, DCP-L25xx, MFC-L27xx) use the same records and should
  work; reports for other models are welcome.
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
| `name` | `Printer` | Accessory name. Must be unique per printer. |
| `host` | | Printer IP address or hostname. Printers without one are ignored. |
| `community` | `public` | SNMP community string. |
| `port` | `161` | SNMP port. |
| `pollInterval` | `60` | Seconds between polls (10–3600). |
| `lowTonerThreshold` | `10` | Toner % at or below which Home shows it as low. |
| `faultSensor` | `true` | Add the Printer Problem contact sensor. |
| `tonerTile` | `false` | Add a humidity sensor showing toner % on its own tile. It also counts in Home's climate summary. |
| `showDrum` | `false` | Add drum life as a second battery. See below. |
| `lowDrumThreshold` | `10` | Drum % at or below which Home shows it as low. |
| `offlineAfter` | `3` | Failed polls in a row before the printer shows No Response. |
| `debug` | `false` | Log every poll at info level. |

## What the Home app shows

HomeKit has no printer accessory type, so the plugin uses the closest sensors and Home
words them its own way:

- The printing sensor reads **Detected** / **Not Detected**.
- Low toner is announced as **"battery is low"**. For a clearer message, add a Home
  automation on that trigger that sends your own notification.
- Home shows only one battery per accessory. With `showDrum` on, it may show the drum
  instead of the toner, which is why the drum is off by default. It's still read, and the
  plugin logs a warning when it nears end of life. Apps like Eve show both.
- The page count is a custom characteristic, visible in Eve, Controller and the Homebridge
  UI, not in Apple Home.

## Going offline

The time before a printer shows No Response is about
`offlineAfter` × (`pollInterval` + 10 s), where 10 s is the SNMP timeout. With the
defaults that's about 3.5 minutes; `pollInterval: 30` with `offlineAfter: 1` brings it to
about 40 s. With `offlineAfter: 1`, a single lost packet can make it flash No Response for
one poll.

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
- **Toner shows 0% with a full cartridge**: some non-genuine cartridges aren't recognised
  by the printer, which then reports no level.

## How it works

Brother printers expose maintenance data as packed records in their private MIB
(`1.3.6.1.4.1.2435.2.3.9.4.2.1.5.5.8`, `.5.10` and `.5.11`). Each record is a one-byte
code, `0x01`, a length byte and a big-endian value. The codes this plugin uses:

| Code | Meaning |
|---|---|
| `0x81` | Toner remaining, % |
| `0x41` | Drum life remaining, hundredths of a % |
| `0x11` | Pages printed on this drum |
| `0x82` (next care) | Drum pages remaining |
| `0x00` (counter) | Total pages printed |

Printing and problem state come from the standard Host Resources MIB (`hrPrinterStatus`,
`hrPrinterDetectedErrorState`) plus the text on the printer's display.

## License

MIT
