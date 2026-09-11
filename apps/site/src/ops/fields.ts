import { Confidence } from "@origin89/equipment-schema/enums";
import { EquipmentKind } from "@origin89/equipment-schema/guess";
import type { CorrectionTarget } from "./corrections.ts";
export interface Field {
  key: string;
  label: string;
  optional?: boolean;
  multiline?: boolean;
  numeric?: boolean;
  options?: readonly string[];
}
export const fields: Record<CorrectionTarget["table"], Field[]> = {
  models: [
    { key: "name", label: "Model name" },
    { key: "manufacturer", label: "Manufacturer ID" },
    { key: "kind", label: "Equipment type", optional: true, options: EquipmentKind.options },
    { key: "variant", label: "Variant", optional: true },
    { key: "family", label: "Product family", optional: true },
    { key: "basis", label: "Supporting evidence", optional: true, multiline: true },
  ],
  specs: [
    { key: "name", label: "Figure name, as printed" },
    { key: "english", label: "English name", optional: true },
    { key: "model", label: "Model ID" },
    { key: "value", label: "Value, as printed" },
    { key: "unit", label: "Unit", optional: true },
    { key: "conditions", label: "Conditions", optional: true, multiline: true },
    { key: "source", label: "Source ID" },
    { key: "page", label: "Document page", optional: true, numeric: true },
    { key: "confidence", label: "Confidence", options: Confidence.options },
  ],
  dialects: [
    { key: "manufacturer", label: "Manufacturer ID", optional: true },
    { key: "confidence", label: "Confidence", options: Confidence.options },
    { key: "confidenceNote", label: "Confidence note", optional: true, multiline: true },
    { key: "transport", label: "Transport", optional: true, multiline: true },
    { key: "blocks", label: "Register blocks", optional: true, multiline: true },
    { key: "sharedMapEvidence", label: "Shared-map evidence", optional: true, multiline: true },
  ],
};
export function draftObject(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}
/** Edit one known field, retaining every other authored value and its absence. */
export function editField(
  table: CorrectionTarget["table"],
  text: string,
  key: string,
  input: string,
): string {
  const field = fields[table].find((field) => field.key === key);
  const value = draftObject(text);
  if (!field || !value) throw Error("Open valid record JSON before editing a field.");
  if (input === "" && field.optional) delete value[key];
  else
    value[key] =
      field.numeric && input !== "" && Number.isFinite(Number(input)) ? Number(input) : input;
  return `${JSON.stringify(value, null, 2)}\n`;
}
