/** RFC 4180 quoting, `\n` line endings, header first. Values are strings or absent; absent is an empty cell. */
export function toCsv(
  columns: readonly string[],
  rows: readonly Record<string, string | boolean | number | undefined>[],
): string {
  const cell = (v: string | boolean | number | undefined): string => {
    if (v === undefined) return "";
    const s = String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [columns.join(",")];
  for (const row of rows) lines.push(columns.map((c) => cell(row[c])).join(","));
  return `${lines.join("\n")}\n`;
}
