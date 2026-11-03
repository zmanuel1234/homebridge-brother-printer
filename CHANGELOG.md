# Changelog

## 0.1.3 (2026-11-03)

- Offline printers now show No Response in the Home app. Home ignores Status Active on sensors, so reads now fail while the printer can't be reached, and recover when it's back.

## 0.1.2 (2026-11-03)

- New "Printer Problem" contact sensor (`faultSensor`, on by default) that opens on a jam, open cover, empty tray or other error. Apple Home doesn't display Status Fault on occupancy sensors.
- Problems and their clearing are logged.
- Settings screen no longer reports a validation error for the blank printer row it adds. A row without a host is ignored.

## 0.1.1 (2026-11-03)

- `showDrum` now defaults to off. Apple's Home app shows only one battery per accessory and was showing the drum instead of the toner.
- Drum life is still read and logged, with a warning when it nears end of life.

## 0.1.0 (2026-11-03)

First release.

- Reads toner %, drum life %, drum pages remaining and total page count from Brother's SNMP records.
- Occupancy sensor for printing, with Status Active for online/offline and Status Fault for jams, open covers, missing paper and other errors.
- Toner and drum as Battery services so the Home app raises native low alerts, with configurable thresholds.
- Optional humidity-sensor tile that shows toner % on the Home tile.
- `brother-printer-probe` command to check what a printer reports.
- Verified against an MFC-L2750DW.
