<p align="center">
  <img alt="Brother Printer" src="https://raw.githubusercontent.com/zmanuel1234/homebridge-brother-printer/main/branding/homebridge-brother-printer.svg" width="150">
</p>

# homebridge-brother-printer

[![npm](https://badgen.net/npm/v/homebridge-brother-printer)](https://www.npmjs.com/package/homebridge-brother-printer)
[![license](https://badgen.net/github/license/zmanuel1234/homebridge-brother-printer)](LICENSE)
[![Sponsor](https://img.shields.io/badge/Sponsor-zmanuel1234-EA4AAA?logo=githubsponsors&logoColor=white)](https://github.com/sponsors/zmanuel1234)
[![Buy me a coffee](https://img.shields.io/badge/Buy%20me%20a%20coffee-zmanuel-FFDD00?logo=buymeacoffee&logoColor=black)](https://www.buymeacoffee.com/zmanuel)

Shows a Brother laser or inkjet printer in HomeKit: whether it's printing, whether it
needs attention, and how much toner or ink is left. Everything is read locally over SNMP,
with no cloud or Brother account. Printers of other makes work too, from the standard
data every network printer gives ([below](#other-makes-of-printer)).

Generic AirPrint/IPP plugins see less of a Brother printer: some models report toner only
as "some remaining", and none of the drum, parts life or page count. Brother's own SNMP
records carry the actual percentages shown on the printer's web page, and this plugin
reads those (and can also read IPP, as an option).

Each printer gets these sensors:

- **Printer** (occupancy sensor, or a contact sensor with `printingSensor`): Detected
  (open) while a job prints. Use it in automations.
- **Problem** (contact sensor): Open on a jam, open cover, empty tray or other
  error. Turn on notifications for it in the Home app.
- **Toner / Ink** (battery level on the Printer accessory; the Home app shows it as
  **Battery Level** under Status when you open one of the printer's sensors, such as Toner
  Low): the toner or ink %, with Home's
  native low-battery alert at or below your threshold. On color printers it shows the
  lowest color, so the alert fires when any color runs low.
- **Toner Low** (optional contact sensor): Opens when the toner or ink is low, so Home
  notifies it by name instead of "battery is low".
- **Toner / ink tiles** (optional light sensors, or humidity sensors for Eve history): the
  level as a number on its own tile, one per color on color printers. Home counts them as
  the room's light level (or humidity); see below.
- **Out of Paper** (optional contact sensor): Opens when a tray is empty.
- **Output Full** (optional contact sensor): Opens while the output tray is full.
- **Paper trays** (optional contact sensors, one per tray: "Tray 1", "Tray 2"…):
  each opens when that tray is empty. Bypass and manual trays get none.
- **Maintenance** (optional contact sensor): Opens when the drum, belt, fuser, laser unit,
  paper feed kit, waste ink or toner box, developer or maintenance kit is near end of life.
- **Offline** (optional contact sensor): opens when the printer stops answering. Home can't
  run automations on No Response, but it can on this, for example to turn off the
  printer's smart plug.

Sensors are named with the printer's name in front ("Printer Problem", "Printer Toner Low",
"Printer Tray 1"), so they read clearly on their own in Home's lists and tiles. Keep the
printer's name short ("Printer", or "Brother"): Home cuts long tile names short, and shows
the room anyway. With `sensorNames` set to `plain`, they're just what they are ("Problem",
"Toner Low"), unless there are several printers. Names you set in the Home app stay.

While the printer can't be reached, all of them except Offline show No Response.

## Brother plugin or an AirPrint plugin?

[@homebridge-plugins/homebridge-printer](https://github.com/homebridge-plugins/homebridge-printer)
reads printers over AirPrint (IPP) and works with most brands. If you have a Brother
printer, the difference is in what each can read and show:

| | This plugin | AirPrint (IPP) plugins |
|---|---|---|
| Printer brands | Brother in most detail; other makes over SNMP or IPP (status, problems, levels, drums and parts they report) | Most AirPrint printers |
| Toner / ink level | The % from the printer's web page, plus a finer reading for earlier low alerts | A % on some Brother printers (in 10% steps), only "some remaining" on others |
| Drum, belt, fuser, laser unit, paper feed kits, ink waste box | Read, with a Maintenance sensor | Usually not on Brother printers (only parts the printer lists as supplies) |
| Page count | Yes (in Eve and Controller, not Apple Home) | No |
| Out of paper, jam, cover open | A Problem sensor, an optional Out of Paper sensor, and the exact problem in the log | One general fault |
| Printer turned off or unplugged | Offline sensor, and No Response on the rest | Online switch |
| Find printers from the settings screen | Yes, with a connection test | Yes |
| Works with SNMP turned off | Yes, over IPP (`protocol`, below), with IPP's detail | Yes |

Both read the printer locally, with no cloud account. This plugin can also read a printer
over IPP, as an option (see [Reading over IPP](#reading-over-ipp-airprint)), and reads
printers of other makes too ([Other makes of printer](#other-makes-of-printer)).

## Requirements

- A printer with SNMP: a Brother in most detail, or another make
  ([below](#other-makes-of-printer)). Brother: tested on a real **MFC-L2750DW**, and against SNMP
  captures from these models (from the [brother](https://github.com/bieniu/brother)
  library, which Home Assistant's Brother integration uses):

  | Kind | Models | What's read |
  |---|---|---|
  | Mono laser | MFC-L2750DW, HL-L2340DW, DCP-L2540DN, DCP-7070DW, DCP-1618W | Toner, drum |
  | Color laser | DCP-L3550CDW, DCP-9020CDW | Toner per color, drums, belt, fuser, paper feed kit |
  | Inkjet | MFC-J680DW, MFC-J5110DW, DCP-J132W, DCP-T735DW, MFC-5490CN | Ink per color, ink waste box |
  | Older / ink tank | HL-2270DW, HL-5350DN, MFC-T910DW | Status, problems, page count; no levels in their Brother records (any the printer gives in the standard table are read) |

  Other Brother models generally use the same records. Reports, with the probe output
  below, are welcome as a
  [printer report](https://github.com/zmanuel1234/homebridge-brother-printer/issues/new?template=printer-report.yml).
- SNMP turned on in the printer's web page: **Network → Protocol → SNMP** (v1/v2c,
  read-only is enough). The default community is `public`. SNMPv3 works too (below).
  Without SNMP, the plugin can read the printer over IPP instead, with less detail
  ([below](#reading-over-ipp-airprint)).
- A fixed address for the printer: reserve its IP in your router, or use its mDNS
  hostname (for example `brn3c2af4919dfc.local`).
- Homebridge 1.6 or later (including 2.x), Node.js 22 (22.19 or later), 24 or 26.

## Installation

Search for **Brother Printer** in the Homebridge UI's Plugins tab, or run:

```bash
npm install -g homebridge-brother-printer
```

Running it as a child bridge is recommended.

## Other makes of printer

Most network printers also give standard SNMP data (the Printer MIB): their supplies with
their levels, drums, waste toner box, fuser, transfer belt, developer and maintenance
kit. For a printer that isn't a Brother, the plugin reads that, so it works with HP,
Canon, Epson, Kyocera, Xerox, Ricoh, Lexmark, Konica Minolta, Sharp, OKI, Samsung, Dell
and others, with the same sensors and settings. Brother printers are read from Brother's
own records instead, which give a finer toner reading and drum pages left.

What's shown depends on what the printer reports. It was checked against SNMP recordings
of about 22 real printer models (HP Color LaserJets, Canon, Dell, Epson, Fujifilm, Konica Minolta,
OKI, Ricoh, Samsung, Sharp, Utax and Xerox): levels given as a % or as pages, supply names
in other languages (such as German or Chinese), part numbers instead of names, and two
black toners. A supply reported only as "some remaining" has no %.

If your printer reads wrong, please open a
[printer report](https://github.com/zmanuel1234/homebridge-brother-printer/issues/new?template=printer-report.yml)
with the probe's output.

## Configuration

Set it up in the plugin's settings screen, or in `config.json`.

At the top of the settings screen, **Your printers** shows each printer's state, levels,
recent pages and paper, read when the screen opens (**Refresh** reads them again).

**Search for printers** finds printers on your network, and **Add** fills in a printer's
name, address and serial number. It sends one SNMP broadcast on the Homebridge machine's
networks and asks for printers by Bonjour (as AirPrint does) at the same time, so it also
finds printers with SNMP off, which it adds to be read over IPP. It can't find printers on
another network; enter those by hand.

**Test connection** reads a printer with the settings as entered, before you save, and
shows its model, status and levels. **Copy a report** reads everything the printer answers
over SNMP and IPP and copies it, for a [printer report](https://github.com/zmanuel1234/homebridge-brother-printer/issues/new?template=printer-report.yml)
when a printer shows something wrong. Passwords, the community, the SNMPv3 user and the
printer's location and contact details are left out; the serial number, MAC address
(also in Brother's `BRN…`/`BRW…` names) and UUIDs are shortened.

In `config.json`:

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
| `name` | `Printer` | Accessory name. Must be unique per printer. You can change it later: the printer keeps its room, automations and notifications in Home, and its sensors are renamed to match (except ones you renamed in the Home app). |
| `serial` | | Printer serial number, filled in by the settings screen. Optional. With it, a printer is kept in Home even when its name and address change at the same time; without it, it's recognised by name or address (by address when the two disagree, since printers keep fixed addresses). |
| `host` | | Printer IP address or hostname. Printers without one are ignored. |
| `community` | `public` | SNMP community string. |
| `port` | `161` | SNMP port. |
| `protocol` | `snmp` | How to read the printer: `snmp`; `auto` (SNMP, and IPP when SNMP doesn't answer); or `ipp` (IPP only). See [Reading over IPP](#reading-over-ipp-airprint). |
| `ippUrl` | | IPP address, for `auto` and `ipp`. Empty means `ipp://<host>:631/ipp/print`, which Brother printers use; `ipps://` for an encrypted connection. |
| `ippAllowSelfSigned` | `false` | With an `ipps://` address, accept the printer's self-signed certificate (below). |
| `snmpVersion` | `auto` | `auto` tries v2c, then v1. Set `1` for older printers that only answer v1, or `3` for SNMPv3 (below). |
| `v3User` | | SNMPv3 user name. Used only with `snmpVersion` `3`. |
| `v3AuthProtocol` | `sha` | SNMPv3 authentication: `none`, `md5`, `sha` (SHA-1), `sha224`, `sha256`, `sha384` or `sha512`. `none` needs `v3PrivProtocol` `none` too. |
| `v3AuthPassword` | | SNMPv3 authentication password, at least 8 characters. |
| `v3PrivProtocol` | `aes` | SNMPv3 encryption: `none`, `des`, `aes` (AES-128), `aes256b` or `aes256r`. Needs authentication. |
| `v3PrivPassword` | | SNMPv3 encryption password, at least 8 characters. |
| `v3Context` | | SNMPv3 context name. Leave empty unless the printer has one set. |
| `pollInterval` | `60` | Seconds between polls (10–3600). |
| `lowTonerThreshold` | `10` | Toner or ink % at or below which Home shows it as low (any color, on color printers). |
| `lowTonerSensor` | `false` | Add a Toner Low contact sensor (Ink Low on inkjets) that opens when any supply is low, by the same rule as the battery. |
| `faultSensor` | `true` | Add the Problem contact sensor. |
| `paperSensor` | `false` | Add an Out of Paper contact sensor that opens when a tray is empty. The Problem sensor opens for this too; this one gets its own notification. |
| `outputSensor` | `false` | Add an Output Full contact sensor that opens while the output tray is full (from the printer's error flag, or its display saying so). The Problem sensor opens for this too; this one gets its own notification. |
| `paperTraySensors` | `false` | Add one contact sensor per paper tray that opens when that tray is empty (bypass and manual trays, often empty on purpose, get none). The trays are then read on every poll. |
| `maintenanceSensor` | `false` | Add a Maintenance contact sensor that opens when the drum or another part is at or below `lowDrumThreshold`. |
| `onlineSensor` | `false` | Add an Offline contact sensor that opens once the printer shows as offline (closed while it answers). |
| `sensorNames` | `prefixed` | `prefixed`: sensor names start with the printer's name ("Printer Problem"); `plain`: just what they are ("Problem"; with several printers they're always prefixed). Home's tiles fit about 13 characters, so longer names are cut there ("Printer Probl…"); the full name shows when the sensor is opened. Names you set in the Home app stay. |
| `printingSensor` | `occupancy` | How the printer's own tile shows printing: `occupancy` (Detected while printing; the room then shows as occupied) or `contact` (open while printing). Changing it gives the printer a new tile: automations on the old one need setting up again. |
| `eveHistory` | `false` | Keep a history of the toner or ink level for the Eve app (below). Needs `tonerTile`; the tiles are then humidity sensors (unless `tileType` is set to `light`). |
| `tonerTile` | `false` | Add sensors showing the toner or ink %, one per color on color printers. Home counts them as the room's light level (or humidity, with `tileType` set to `humidity`). |
| `tileType` | `light` (`humidity` with `eveHistory`) | What the tiles are: `light` (the level in lux; few rooms have another light sensor) or `humidity` (%, needed for Eve history, but Home counts it as the room's humidity) (`filter`, tried in 0.12.0-beta.3, is no longer offered: the Home app doesn't show it; it's read as `light`). |
| `lowDrumThreshold` | `10` | Drum and parts % (belt, fuser, laser unit, paper feed kit, waste ink or toner box, developer, maintenance kit) at or below which a warning is logged, and the Maintenance sensor opens. |
| `offlineAfter` | `3` | Failed polls in a row before the printer shows No Response. |
| `debug` | `false` | Log every poll at info level. |

One setting is for all printers (under **Dashboard** in the settings screen):

| Option | Default | Description |
|---|---|---|
| `dashboardPort` | (none) | A port (1024–65535, for example `8587`) for a page showing all printers at `http://<Homebridge address>:<port>/`, for a browser or a wall tablet. It shows what the plugin last read, refreshes every 30 seconds and changes nothing. It has no password: anyone on your network can see the printers' names, addresses and readings (no serial numbers or other settings). Empty: no page. |
| `dashboardHosts` | | The page opens by an address, a one-word name, or a name ending `.local`, `.lan`, `.home`, `.home.arpa` or `.internal` (so a web page elsewhere can't read it through a domain of its own). List any other name you open it by, such as a reverse proxy's or dynamic DNS name. |

## What the Home app shows

HomeKit has no printer accessory type, so the plugin uses the closest sensors and Home
words them its own way:

- The printing sensor reads **Detected** / **Not Detected**, and while a job prints the room
  shows as occupied. With `printingSensor` set to `contact` it reads **Open** / **Closed**
  instead.
- HomeKit has no plain % sensor, so the toner / ink tiles are light sensors, showing the
  level in lux (70% shows as 70 lux). Home counts them as the room's light level, which
  few rooms have another sensor for. For Eve history they must be humidity sensors
  (`tileType`), which Home counts as the room's humidity: a room with a printer whose
  toner is at 70% then shows "Humidity 70%".
- The plugin's version shows as the firmware, unless the printer gives its own over IPP as a
  version number Home can show (as some Canon printers do).
- Low toner or ink is announced as **"battery is low"**. For a clearer message, turn on
  `lowTonerSensor`: its contact sensor opens at the same point and Home notifies it by
  name, as it does for any contact sensor that opens. Turn on its notifications in the
  Home app.
- Home shows only one battery per accessory: the toner or ink. The drum is read too: its
  level is in the log and in **Test connection** in the settings, the plugin logs a warning
  when it nears end of life, and `maintenanceSensor` opens for it.
- The page count is a custom characteristic, visible in Eve, Controller and the Homebridge
  UI, not in Apple Home. Printers that count them also get **Color Pages**,
  **Black-and-White Pages** and **Two-Sided Pages** beside it (a black-and-white printer
  gets no color or black-and-white count: the total says it). The same counts are in the log when
  the printer connects, in **Test connection** and on the dashboards.

## Eve history

With `eveHistory` and `tonerTile` on (and `tileType` set to `humidity`), the Eve app shows a graph of the toner or ink level
over about the last 60 days on the toner / ink tiles: an entry every 10 minutes, and
whenever the level changes. It's kept in Homebridge's storage folder
(`homebridge-brother-printer-<id>-history.json`), so it survives restarts and renaming
the printer.

Eve keeps one history per accessory, so on a color printer each color's tile shows the
lowest color, like the battery. The page count, printing state and problems aren't
recorded: Eve has no graph for them on these sensors. Apple's Home app doesn't show
history.

The history uses [fakegato-history](https://github.com/simont77/fakegato-history), which
is loaded only when `eveHistory` is on. It brings Google's API client with it: about
250 MB on disk for everyone who installs the plugin, and with `eveHistory` on, a few
seconds more when Homebridge starts.

## Levels and low alerts

Brother printers report two readings per supply: a coarse one (the number on the
printer's web page and display) and a finer one. The battery and tiles show the coarse
one, so they match the printer. A supply counts as low when either reading is at or below
`lowTonerThreshold`, or when the printer itself flags low toner, so a cartridge that shows
10% but is really at 2% still raises the alert.

Printers without level reporting (some older models and ink tank printers) get no
battery; status, problems and the page count still work.

## Usage and time left

Once a day the plugin notes the page count and the levels (kept with the accessory in
Homebridge's cache). From these:

- **Test connection** in the settings shows pages printed in the last 7 and 30 days, and
  how long the toner or ink should last ("Toner: about 6 weeks left"; on color printers,
  each color, soonest first).
- Once a week the log has a line with the same: `42 pages printed in the last 7 days.
  Toner: about 6 weeks left.`
- The low toner warning says how long is left at the rate it's been going down.

The estimate follows the level since the cartridge was last replaced, so it needs a week
of readings after a change, and a few % of drop. Pages need a week (or 30 days) of history.

## Paper trays

Printers list their paper trays (over SNMP in the Printer MIB, over IPP in
`printer-input-tray`). When one runs out, the log names it (`Tray 2 is out of paper.`),
and **Test connection** shows each tray: how full in % when the printer counts sheets,
"has paper" or "empty" otherwise, and the paper type it's set for when the printer says
("Tray 1 has paper (Regular)"). With `paperTraySensors` each tray gets its own sensor.
Bypass, manual and multipurpose trays (HP's "Tray 1" among them) are listed but get no
sensor or warning, since they're often empty on purpose.

## Going offline

The time before a printer shows No Response is about
`offlineAfter` × (`pollInterval` + 10 s), where 10 s is the SNMP timeout. With the
defaults that's about 3.5 minutes; `pollInterval: 30` with `offlineAfter: 1` brings it to
about 40 s. With `offlineAfter: 1`, a single lost packet can make it flash No Response for
one poll.

If the printer hasn't answered since Homebridge started and `snmpVersion` is `auto`, each
poll tries v2c and then v1, so the timeout counts twice (about 20 s per poll). Once it has
answered, the version that worked is used.

Over IPP the timeout is 5 s, so with `protocol: ipp` it's `pollInterval` + 5 s per failed
poll. With `protocol: auto` a poll tries SNMP and then IPP, so a failed one takes the SNMP
time plus 5 s.

Brother lasers normally still answer SNMP in Sleep and Deep Sleep.

### When the printer's address changes

If the printer gets a new address from the router, the plugin looks for it once the
printer shows as offline, and every 15 minutes after that. If another printer answers at
its address (its serial number isn't the one this printer gave), that printer's readings
aren't used: this printer shows as offline and is looked for every 15 minutes. A printer
that keeps answering there with a new serial number for a day (a replaced printer or
mainboard) is taken as this one then, unless the settings name another serial number; it's
taken right away once its serial number is in the settings. It searches the network (SNMP and
Bonjour) for a printer with the same serial number. When it finds it, it reads it there,
logs the new address, and keeps using it after a restart until you change the address in
the settings (the settings screen's test and dashboard read it there too).

- It needs the serial number, which the plugin learns from the printer's first reading
  (or the settings screen fills in).
- Only for an address entered as numbers: a host name follows the printer by itself.
- The search asks each device without your SNMP settings (over IPP, and SNMP with
  `public`). With a private community or SNMPv3, those go only to a device whose
  Bonjour name says it's the same model (so such a printer is found only if it
  advertises by Bonjour).

A reserved address for the printer in your router avoids the change altogether.

## Reading over IPP (AirPrint)

SNMP gives the most: Brother's own records with the exact toner or ink %, drum and parts
life, and the page count. Set `protocol` to:

- `ipp` for a printer with SNMP turned off, or a model that reports no levels over SNMP:
  IPP only (the SNMP settings, including SNMPv3, aren't used).
- `auto` to read over SNMP but carry on over IPP when SNMP doesn't answer. Until SNMP has
  answered once, IPP readings count in full. After that IPP only fills in: it updates the
  sensors SNMP set up (combining its levels with SNMP's last ones) and can raise low or
  maintenance warnings, but doesn't add or remove sensors, so a missed SNMP answer doesn't
  change Home. It clears a low-toner warning only if it reports every color SNMP did;
  drum and parts warnings stay until SNMP answers again. If SNMP is turned off for good,
  switch to `ipp`.

Over IPP the plugin reads the printer's state, its problems (paper, jam, cover, toner)
and the supplies it lists. What that includes depends on the printer. An MFC-L2750DW, for
example, reports its toner % (in 10% steps, without SNMP's finer reading) but not its
drum, page count or serial number. Some Brother printers report toner only as "some
remaining", with no %, and then there's no battery or tile;
the printer's own low-toner flag still opens the Toner Low sensor (`lowTonerSensor`) and
is logged. Drum and parts appear only if the printer lists them
as supplies, and the page count only if it reports `printer-impressions-completed`
(color, black-and-white and two-sided counts only if it reports
`printer-impressions-completed-col`, which few printers do).

Over IPP the plugin also shows the extra inks some printers have, each on its own tile:
Photo Black, Gray (light black), Light Cyan, Light Magenta, and HP's single Tri-color
cartridge. A maintenance kit counts as a part for the Maintenance sensor, and Home shows
the printer's own maker and model.

The IPP reading is checked against 49 answers recorded from about 44 real printer models:
Brother, Canon, Epson, HP (inkjets, LaserJets, OfficeJets, PageWide), Kyocera and Samsung
(14 of them are kept in `test/fixtures/ipp` as tests). Report a printer that reads wrong with the probe's output
(`--protocol ipp`).

IPP is on by default on Brother printers (**Network → Protocol → IPP**). The default
`ipp://` address isn't encrypted, like SNMP v1/v2c. With an `ipps://` address the
connection is encrypted and the certificate is checked; Brother printers' own
certificates are self-signed, so that fails unless you install a certificate on the
printer that Node.js trusts (from a public authority, or your own with
`NODE_EXTRA_CA_CERTS`; for an IP address it must list that IP) or turn on
`ippAllowSelfSigned`. With that on the connection is still
encrypted, but not verified: another device on your network could pose as the printer.
**Search for printers** in the settings still uses SNMP; enter an IPP-only printer by
hand and check it with **Test connection**.

Check what your printer reports over IPP with:

```bash
npx -p homebridge-brother-printer brother-printer-probe 10.0.4.150 --protocol ipp
```

(A `:port` after the address is the SNMP port; for another IPP port use `--ipp-url`.)

## SNMPv3

If you'd rather not leave SNMP v1/v2c on, Brother printers also support SNMPv3, which
needs a user name and password and can encrypt the traffic. Set it up in the printer's
web page under **Network → Protocol → SNMP** (choose the SNMPv3 mode and set the user,
protocols and passwords; on some models these are under **Advanced Settings**), then
set `snmpVersion` to `3` and enter the same values here. The settings screen shows the
SNMPv3 fields once you pick v3.

The plugin only reads, so a read-only SNMPv3 user is enough. With missing or invalid
SNMPv3 settings (no user, a password under 8 characters, an unknown protocol, encryption
without authentication), the printer isn't set up: it shows No Response in Home and the log
says why.

## Checking what your printer reports

The package includes a command that prints what the plugin reads:

```bash
npx -p homebridge-brother-printer brother-printer-probe 10.0.4.150
```

With SNMPv3, add the user and passwords. SHA and AES are the defaults; `--priv none`
turns encryption off, and `--auth none` needs `--priv none` too. The passwords can also
come from the environment variables `BROTHER_SNMP_AUTH_PASS` and `BROTHER_SNMP_PRIV_PASS`:

```bash
read -rs BROTHER_SNMP_AUTH_PASS && export BROTHER_SNMP_AUTH_PASS   # type it, then Enter
read -rs BROTHER_SNMP_PRIV_PASS && export BROTHER_SNMP_PRIV_PASS
npx -p homebridge-brother-printer brother-printer-probe 10.0.4.150 --v3 <user>
unset BROTHER_SNMP_AUTH_PASS BROTHER_SNMP_PRIV_PASS
```

Passwords given with `--auth-pass` and `--priv-pass` are saved in your shell history and
visible to other users in the process list; `read -s` keeps them out of both.

Add `--report` for everything the printer answers, ready to paste into an issue (the same
as **Copy a report** in the settings screen):

```bash
npx -p homebridge-brother-printer brother-printer-probe 10.0.4.150 --report
```

Compare `tonerPercent` with **Remaining Life** on the printer's web page. If it doesn't
match, or values are `null`, please open a
[printer report](https://github.com/zmanuel1234/homebridge-brother-printer/issues/new?template=printer-report.yml)
with the probe output and your printer model.

## Troubleshooting

- **"Can't reach … Request timed out"**: SNMP is off on the printer, the address is wrong,
  or a firewall blocks UDP port 161. Test from the Homebridge machine with
  `snmpget -v2c -c public <printer-ip> 1.3.6.1.2.1.1.1.0` (from the `snmp` package).
- **Status text in another language**: the plugin reads the printer's character set, so
  the log shows the display text as the printer shows it. Problems and printing are
  detected from language-neutral status codes, with English display text as a fallback.
- **Old printer never connects**: set `snmpVersion` to `1`.
- **SNMPv3 errors** ("Request timed out", "Unknown User Name", "Wrong Digest",
  "Unsupported Security Level", "Decryption Error"): the user, protocols, passwords or
  context name don't match the printer's. A wrong password usually shows as a timeout.
  Check them with the probe command above.
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
| counter `0x01`, `0x02`, `0x06` | Black-and-white, color and two-sided pages |

Printing and problem state come from the standard Host Resources MIB (`hrPrinterStatus`,
`hrPrinterDetectedErrorState`), with the display text as a fallback.

When there are no Brother records with levels, the plugin reads the standard Printer MIB
supplies table (`prtMarkerSuppliesTable`, RFC 3805): each supply's name, type, level and
maximum, and its colorant. That's how other makes are read, and older Brother models
whose records have no levels.

The record codes follow the [brother](https://github.com/bieniu/brother) Python library
by Maciej Bieniek (Apache-2.0), and the tests use SNMP captures from its test suite.

## Development

The plugin and its tests are written in TypeScript (`src/`, `test/`). It's published as
compiled JavaScript (`dist/`), which npm builds on `npm ci`, `npm pack` and `npm publish`.

```
npm ci          # installs and builds
npm test        # runs the tests against the TypeScript sources
npm run lint    # oxlint and type checking
npm run build   # build only
```

`npm publish` lints and tests first.

Releases are published to npm by GitHub Actions (`.github/workflows/publish.yml`, the same in the author's other plugins) when a GitHub release is published. The tag must be `v` followed by the version in `package.json`, the release needs notes (the CHANGELOG section for the version), and **Set as a pre-release** must be ticked exactly for a version with a `-`. The workflow runs `npm run release:check`, adds the package and its `SHA256SUMS` to the release, and publishes that package with npm's trusted publishing: a `-dev-` version to npm's `dev` tag, any other pre-release to `beta`, a stable version to `latest`. **Run workflow** with a release's tag publishes a release that already exists. CI (`.github/workflows/ci.yml`, also shared) runs `npm run verify` on Node 24 and `npm run test:matrix` on Node 22, 24 and 26.

## License

MIT
