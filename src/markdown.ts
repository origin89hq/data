/**
 * One cell of a Markdown table. A pipe would start another column and a line break another row,
 * so the pipe is escaped and the breaks, in any of their three forms, become spaces; a model
 * name like "MPPT100|20" survives as text. Nothing else is touched: the cell is data, not markup.
 */
export function cell(text: string): string {
  return text
    .replace(/\r\n|\r|\n/g, " ")
    .replace(/\|/g, "\\|")
    .trim();
}
