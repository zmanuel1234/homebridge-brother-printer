'use strict';

// Captured from a Brother MFC-L2750DW on 2026-11-03 with `snmpget -Ox`.
// The printer's web page showed: drum 60%, toner 70%.
module.exports = {
  maintenance: `63 01 04 00 00 00 01 41 01 04 00 00 17 70 11 01
04 00 00 13 16 31 01 04 00 00 00 07 6F 01 04 00
00 18 9C 81 01 04 00 00 00 46 FF`,
  counters: '00 01 04 00 00 13 16 06 01 04 00 00 06 5E FF',
  nextCare: '82 01 04 00 00 1B CA FF',
  statusText: '53 6C 65 65 70',
  model: `42 72 6F 74 68 65 72 20 4D 46 43 2D 4C 32 37 35
30 44 57 20 73 65 72 69 65 73`,
  serial: '55 30 30 30 30 30 30 30 30 30 30 30 30 30 30',
};
