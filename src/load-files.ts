import { LOAD_PART_MAX, LOAD_PART_ROWS, loadPartName } from "@origin89/equipment-schema/releases";
import type { Row, Table } from "./tables.ts";

/**
 * A table as load parts: newline-delimited JSON, one object a row, absent fields left out, at most
 * `LOAD_PART_ROWS` rows a part. The row order is the table's, so a loader that reads the parts in
 * order sees the rows in the order the CSV has them. No timestamp, no part count in the row: the
 * same table gives the same bytes.
 */
export function loadParts(
  table: Table,
  rowsPerPart = LOAD_PART_ROWS,
): { name: string; text: string; rows: number }[] {
  const out: { name: string; text: string; rows: number }[] = [];
  for (let at = 0; at < table.rows.length; at += rowsPerPart) {
    const rows = table.rows.slice(at, at + rowsPerPart);
    const text = `${rows.map((row) => JSON.stringify(present(row))).join("\n")}\n`;
    if (Buffer.byteLength(text) > LOAD_PART_MAX)
      throw new Error(
        `${table.name}: a load part of ${rows.length} rows exceeds ${LOAD_PART_MAX} bytes`,
      );
    out.push({ name: loadPartName(table.name, out.length + 1), text, rows: rows.length });
  }
  return out;
}

/** The row without its absent fields: a JSON line says what is there and nothing about what is not. */
function present(row: Row): Row {
  const out: Row = {};
  for (const [name, value] of Object.entries(row)) if (value !== undefined) out[name] = value;
  return out;
}
