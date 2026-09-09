import { z } from "zod";

/** One file per family in the catalogue. Split by what a driver author has to reach for, not by wire or medium. */
export const Family = z.enum([
  "modbus-rs485",
  "modbus-tcp",
  "ve-direct",
  "can-bms",
  "lan-http",
  "local-io",
  "other-serial",
  "no-comms",
]);
export type Family = z.infer<typeof Family>;

/** Where a protocol fact came from. `unverified` must not be built on. */
export const Confidence = z.enum([
  "vendor-doc",
  "community-crosschecked",
  "community-single",
  "unverified",
]);
export type Confidence = z.infer<typeof Confidence>;

/** Whether a second pass tried to refute the entry. `unrecorded` is an entry written before the refuter existed. */
export const RefuterStatus = z.enum(["checked", "not-checked", "unrecorded"]);
export type RefuterStatus = z.infer<typeof RefuterStatus>;

/** The catalogue legend: shipped, planned, possible, not planned. */
export const DriverStatus = z.enum(["shipped", "planned", "possible", "not-planned"]);
export type DriverStatus = z.infer<typeof DriverStatus>;

/** Probability a Quebec cabin already has it, times driver cost. See the catalogue README. */
export const Tier = z.enum(["A", "B", "C", "D"]);
export type Tier = z.infer<typeof Tier>;

/**
 * What a dialect can report. This is the catalogue's own vocabulary, pinned so a typo
 * in a record fails validation instead of becoming a metric nobody reads.
 */
export const MetricKind = z.enum([
  "ac-apparent-power",
  "ac-current",
  "ac-energy-today",
  "ac-energy-total",
  "ac-frequency",
  "ac-power",
  "ac-power-factor",
  "ac-voltage",
  "battery-current",
  "battery-power",
  "battery-temperature",
  "battery-voltage",
  "charge-stage",
  "consumed-amp-hours",
  "cycle-count",
  "generator-run-hours",
  "generator-run-state",
  "humidity",
  "link-downlink",
  "link-latency",
  "link-online",
  "link-signal-quality",
  "link-uplink",
  "load-current",
  "load-power",
  "load-voltage",
  "pressure",
  "pv-current",
  "pv-energy-today",
  "pv-energy-total",
  "pv-irradiance",
  "pv-power",
  "pv-voltage",
  "state-of-charge",
  "state-of-health",
  "switch-state",
  "tank-level",
  "tank-volume",
  "temperature",
  "time-to-go",
  "uptime",
]);
export type MetricKind = z.infer<typeof MetricKind>;

/** What a dialect accepts. Same rule as [`MetricKind`]. */
export const CommandKind = z.enum([
  "clear-fault",
  "identify",
  "reset-counter",
  "set-charge-current-limit",
  "set-switch",
  "start-equalize",
  "start-generator",
  "stop-generator",
]);
export type CommandKind = z.infer<typeof CommandKind>;

/** Record ids are kebab-case so they can be a filename, a URL segment and a foreign key without escaping. */
export const RecordId = z
  .string()
  .regex(/^[a-z0-9]+(?:[a-z0-9.+-]*[a-z0-9])?$/, "kebab-case id");
