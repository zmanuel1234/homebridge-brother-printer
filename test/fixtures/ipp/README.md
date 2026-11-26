# Real IPP printer answers

Get-Printer-Attributes responses recorded from real printers, used by
`test/ipp-printers.test.ts` to check that IPP (AirPrint) reading works across brands.
They are copied unchanged from two MIT-licensed projects:

| File | Printer | From |
|---|---|---|
| brother-mfc-j5320dw.bin | Brother MFC-J5320DW | python-ipp |
| epson-xp-6000.bin | Epson XP-6000 (photo black) | python-ipp |
| hp-officejet-pro-6830.bin | HP Officejet Pro 6830 | python-ipp |
| kyocera-ecosys-m2540dn.bin | Kyocera ECOSYS M2540dn (few attributes) | python-ipp |
| brother-mfc-j870dw.bin | Brother MFC-J870DW (camelCase types, empty inks) | jipp |
| canon-ts6000.bin | Canon TS6000 (two blacks: BK and PGBK) | jipp |
| canon-mf6100-series.bin | Canon MF6100 (mono laser, toner low) | jipp |
| hp-officejet-4630.bin | HP Officejet 4630 (tri-color cartridge) | jipp |
| photosmart-7520.bin | HP Photosmart 7520 (light black) | jipp |
| hp-laserjet-m605.bin | HP LaserJet M605 (maintenance kit) | jipp |
| hp-color-laserjet-mfp-m181fw.bin | HP Color LaserJet MFP M181fw (levels unknown) | jipp |
| samsung-c1860-series.bin | Samsung C1860 (black sent as #FFFFFF) | jipp |
| hp-officejet-250-mobile-series.bin | HP OfficeJet 250 Mobile (out of paper) | jipp |
| hp-laserjet-400-colormfp-m475dw.bin | HP LaserJet 400 color MFP M475dw | jipp |

- python-ipp: https://github.com/ctalkington/python-ipp (`tests/fixtures/`, commit
  8ab238fe3a74dc1212394542a98260052e420acf)
- jipp: https://github.com/HPInc/jipp (`jipp-core/src/test/resources/printer/`, commit
  51d79d8ef3fa4fe612f02b66bf0345f11251d7ad)

These files are test data only; they aren't part of the published package.

## Licenses

python-ipp:

MIT License

Copyright (c) 2020 Chris Talkington

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

jipp:

The MIT License (MIT)

Copyright (c) 2017 H.P. Development Company, L.P.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.