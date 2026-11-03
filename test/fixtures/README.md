# Test fixtures

`brother-models.json` holds SNMP captures from 14 Brother printers, with the values the
[brother](https://github.com/bieniu/brother) Python library decodes from them. Both come
from that library's test suite (`tests/fixtures/*.json`, `tests/snapshots/test_init.ambr`),
converted to this plugin's field names.

brother is Copyright Maciej Bieniek and licensed under the Apache License, Version 2.0
(https://www.apache.org/licenses/LICENSE-2.0). These files are used for testing only and
are not included in the npm package.
