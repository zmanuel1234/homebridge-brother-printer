/*
 * Values of unknown type as text: from config.json (anything a user typed), the
 * printer (SNMP, IPP, Bonjour) or HomeKit. Objects and arrays give '' rather than
 * "[object Object]", so they can't end up in a name, an address or the log.
 */
export function text(value: unknown): string {
  if (typeof value === 'string') { return value; }
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') { return String(value); }
  if (Buffer.isBuffer(value)) { return value.toString('utf8'); }
  return '';
}
