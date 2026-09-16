import {
  byId,
  type RecordKind,
  SNAPSHOT_PART_MAX,
  SNAPSHOT_PART_ROWS,
  SNAPSHOT_PARTS_MAX,
  snapshotPartName,
} from "@origin89/equipment-schema/releases";
import type { z } from "zod";

/**
 * A record kind as snapshot parts: JSON arrays of its records in id order, each at most
 * `maxBytes` long and `maxRows` records. A part is what `JSON.stringify` gives its records, so the
 * same records give the same parts, and a kind with no records has no part.
 */
export function snapshotParts(
  kind: z.infer<typeof RecordKind>,
  records: readonly { id: string }[],
  maxBytes = SNAPSHOT_PART_MAX,
  maxRows = SNAPSHOT_PART_ROWS,
): { name: string; text: string; rows: number }[] {
  const sorted = [...records].sort(byId);
  const out: { name: string; text: string; rows: number }[] = [];
  let items: string[] = [];
  // The two brackets, then each record and the comma before every one after the first.
  let bytes = 2;
  const flush = () => {
    out.push({
      name: snapshotPartName(kind, out.length + 1),
      text: `[${items.join(",")}]`,
      rows: items.length,
    });
    items = [];
    bytes = 2;
  };
  let last: string | undefined;
  for (const record of sorted) {
    if (record.id === last) throw new Error(`${kind}: the snapshot repeats the id ${record.id}`);
    last = record.id;
    const text = JSON.stringify(record);
    const size = Buffer.byteLength(text);
    if (2 + size > maxBytes)
      throw new Error(
        `${kind}: ${record.id} alone exceeds the ${maxBytes} bytes a snapshot part may hold`,
      );
    if (items.length > 0 && (bytes + 1 + size > maxBytes || items.length >= maxRows)) flush();
    bytes += (items.length > 0 ? 1 : 0) + size;
    items.push(text);
  }
  if (items.length > 0) flush();
  if (out.length > SNAPSHOT_PARTS_MAX)
    throw new Error(
      `${kind}: ${out.length} snapshot parts, over the ${SNAPSHOT_PARTS_MAX} a comparison reads`,
    );
  return out;
}
