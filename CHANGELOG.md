# Changelog

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
