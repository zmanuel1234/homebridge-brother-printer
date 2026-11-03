# Changelog

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
