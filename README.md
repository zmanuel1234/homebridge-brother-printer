# homebridge-brother-printer

Brother laser printer status, toner and drum life in HomeKit, read locally over SNMP. No cloud, no Brother account.

Generic AirPrint/IPP plugins can't show real toner levels on many Brother printers, because the standard Printer MIB only reports "some remaining". Brother's own SNMP records carry the actual percentages shown on the printer's web page, and this plugin reads those.

Tested on an **MFC-L2750DW**. Other Brother mono lasers from the same generation (HL-L23xx, DCP-L25xx, MFC-L27xx) use the same records and should work; reports for other models are welcome.

## What you get in HomeKit

| What | HomeKit service | In the Home app |
|---|---|---|
| Printing | Occupancy sensor | "Detected" while a job runs; use it in automations |
| Online / offline | Failed reads while unreachable | All the printer's sensors show No Response |
| Jam, cover open, no paper, errors | Contact sensor "Printer Problem" | Shows Open while there's a problem; turn on notifications for it in Home |
| Toner % | Battery | Level in accessory details; native low-battery alert |
| Drum life % | Battery (optional, off by default) | Shown in Eve; Apple Home shows only one battery per accessory |
| Toner % on the tile | Humidity sensor (optional, off by default) | Shows the number on the tile, but also counts in Home's climate summary |
| Pages printed | Custom characteristic | Visible in Eve, Controller and the Homebridge UI, not in Apple Home |

Apple's Home app will word the low-supply alert as "battery is low". For a clearer message, add a Home automation on the low-battery trigger that sends your own notification.

## Setup

1. **Turn on SNMP on the printer.** Open the printer's web page, go to **Network → Protocol**, make sure **SNMP** is checked (v1/v2c, read-only is enough) and submit. The default community is `public`.
2. **Give the printer a fixed address.** Reserve its IP in your router, or use its mDNS hostname (for example `brn3c2af4919dfc.local`).
3. **Install the plugin** from the Homebridge UI, or with `npm install -g homebridge-brother-printer`.
4. **Configure it** in the plugin settings, or in `config.json`:

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

Running the plugin as a child bridge is recommended.

## Options

| Option | Default | Description |
|---|---|---|
| `name` | `Printer` | Accessory name. Must be unique per printer. |
| `host` | required | Printer IP address or hostname. |
| `community` | `public` | SNMP community string. |
| `port` | `161` | SNMP port. |
| `pollInterval` | `60` | Seconds between polls (10–3600). |
| `lowTonerThreshold` | `10` | Toner % at or below which HomeKit shows it as low. |
| `showDrum` | `false` | Add a drum-life battery service. Apple Home shows only one battery per accessory and may show the drum instead of the toner, so leave this off unless you use Eve. The drum is still monitored and logged. |
| `lowDrumThreshold` | `10` | Drum % at or below which HomeKit shows it as low. |
| `tonerTile` | `false` | Add a humidity sensor showing toner % on its own tile. |
| `faultSensor` | `true` | Add a contact sensor that opens on a jam, open cover, empty tray or other error. Apple Home doesn't show the fault flag on occupancy sensors, so this is how problems reach you. |
| `offlineAfter` | `3` | Failed polls in a row before the printer is shown as offline. Time to offline is about `offlineAfter` × (`pollInterval` + 10 s). |
| `debug` | `false` | Log every poll at info level. |

## Checking what your printer reports

The package includes a small command that prints what the plugin reads:

```bash
npx -p homebridge-brother-printer brother-printer-probe 10.0.4.150
```

Compare `tonerPercent` and `drumPercent` with **Remaining Life** on the printer's web page. If they don't match, or values are `null`, please open an issue with the probe output and your printer model.

## Troubleshooting

- **"Can't reach … Request timed out"**: SNMP is off on the printer, the address is wrong, or a firewall blocks UDP port 161. Test from the Homebridge machine with `snmpget -v2c -c public <printer-ip> 1.3.6.1.2.1.1.1.0` (from the `snmp` package).
- **Printer shows offline when it's asleep**: Brother lasers normally still answer SNMP in Sleep and Deep Sleep. If yours doesn't, raise `offlineAfter`.
- **Toner shows 0% with a full cartridge**: some non-genuine cartridges aren't recognised by the printer, which then reports no level.

## How it works

Brother printers expose maintenance data as packed records in their private MIB (`1.3.6.1.4.1.2435.2.3.9.4.2.1.5.5.8`, `.5.10` and `.5.11`). Each record is a one-byte code, `0x01`, a length byte and a big-endian value. The codes this plugin uses:

| Code | Meaning |
|---|---|
| `0x81` | Toner remaining, % |
| `0x41` | Drum life remaining, hundredths of a % |
| `0x11` | Pages printed on this drum |
| `0x82` (next care) | Drum pages remaining |
| `0x00` (counter) | Total pages printed |

Printing and fault state come from the standard Host Resources MIB (`hrPrinterStatus`, `hrPrinterDetectedErrorState`) plus the text on the printer's display.

## License

MIT
