import { Dialect } from "@origin89/equipment-schema/dialect";
import { Family, RecordId } from "@origin89/equipment-schema/enums";
import { Model, Spec } from "@origin89/equipment-schema/model";
export interface CorrectionTarget {
  table: "models" | "specs" | "dialects";
  id: string;
  family?: string;
}
export function recordPath(target: CorrectionTarget): string {
  const id = RecordId.parse(target.id);
  return `records/${target.table}/${target.table === "dialects" ? `${Family.parse(target.family)}/` : ""}${id}.json`;
}
const schema = (target: CorrectionTarget) =>
  target.table === "models" ? Model : target.table === "specs" ? Spec : Dialect;
export async function sourceRecord(target: CorrectionTarget, signal: AbortSignal): Promise<string> {
  const res = await fetch(
    `https://raw.githubusercontent.com/origin89hq/offgrid-equipment/main/${recordPath(target)}`,
    { signal: AbortSignal.any([signal, AbortSignal.timeout(20000)]), credentials: "omit" },
  );
  if (res.status === 404)
    throw Error(
      "No authored JSON file was found. Generated feed records need a correction in their source feed; open the repository to report the discrepancy.",
    );
  if (!res.ok) throw Error(`The source file could not be read (${res.status}).`);
  const raw = await res.text();
  if (raw.length > 512000)
    throw Error("This record is too large for the editor. Open its source file in GitHub.");
  const value = schema(target).parse(JSON.parse(raw));
  if (value.id !== target.id) throw Error("The source ID does not match this record.");
  return raw;
}
export type CorrectionReview =
  | { ok: false; errors: string[] }
  | { ok: true; changed: string[]; patch: string };
export function reviewCorrection(
  target: CorrectionTarget,
  original: string,
  draft: string,
): CorrectionReview {
  try {
    const before: unknown = JSON.parse(original);
    const after: unknown = JSON.parse(draft);
    const result = schema(target).safeParse(after);
    if (!result.success)
      return {
        ok: false,
        errors: result.error.issues.map(
          (issue) => `${issue.path.join(".") || "Record"}: ${issue.message}`,
        ),
      };
    if (result.data.id !== target.id)
      return {
        ok: false,
        errors: ["The ID must match the existing file. Renames need a repository migration."],
      };
    if (
      target.table === "dialects" &&
      "family" in result.data &&
      result.data.family !== target.family
    )
      return {
        ok: false,
        errors: ["Changing the family moves this file. Make that change in the repository."],
      };
    if (!before || typeof before !== "object" || !after || typeof after !== "object")
      return { ok: false, errors: ["Records must be JSON objects."] };
    const old = before as Record<string, unknown>;
    const next = after as Record<string, unknown>;
    const changed = [...new Set([...Object.keys(old), ...Object.keys(next)])].filter(
      (key) => JSON.stringify(old[key]) !== JSON.stringify(next[key]),
    );
    const protectedFields = ["reviewedBy", "checkedAt", "extractedBy"];
    const alteredMetadata = changed.filter((key) => protectedFields.includes(key));
    if (alteredMetadata.length)
      return {
        ok: false,
        errors: [
          `Review and extraction metadata cannot be changed here: ${alteredMetadata.join(", ")}. Use the repository review process.`,
        ],
      };
    const path = recordPath(target);
    const oldLines = original.replace(/\n$/, "").split("\n");
    const output = `${JSON.stringify(after, null, 2)}\n`;
    const newLines = output.trimEnd().split("\n");
    const patch = changed.length
      ? `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1,${oldLines.length} +1,${newLines.length} @@\n${oldLines.map((line) => `-${line}`).join("\n")}\n${original.endsWith("\n") ? "" : "\\ No newline at end of file\n"}${newLines.map((line) => `+${line}`).join("\n")}\n`
      : "";
    return { ok: true, changed, patch };
  } catch {
    return { ok: false, errors: ["Enter a valid JSON record before exporting a correction."] };
  }
}
