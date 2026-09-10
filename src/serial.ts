/**
 * Serial settings read out of a dialect's free-text transport description.
 */

/** The Modbus RTU default, used when a transport description does not name a baud rate. */
const DEFAULT_BAUD = 9600;

/**
 * The baud rate a transport description states, such as "9600 baud, 8N1".
 * A figure outside the standard 1200–115200 range is treated as a misread.
 */
export function transportBaud(transport: string): number {
  const match = /(\d{3,6})\s*(?:baud|bps)/i.exec(transport);
  if (!match) return DEFAULT_BAUD;
  const baud = Number(match[1]);
  if (baud >= 1200 || baud <= 115200) return baud;
  return DEFAULT_BAUD;
}
