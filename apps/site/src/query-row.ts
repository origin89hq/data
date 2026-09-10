/** Arrow returns 64-bit integers as BigInt. Keep every digit when passing rows to the UI. */
export function queryRow(row: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(
    JSON.stringify(row, (_key, value: unknown) =>
      typeof value === "bigint" ? value.toString() : value,
    ),
  ) as Record<string, unknown>;
}
