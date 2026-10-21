/**
 * A CSV cell.
 *
 * A text cell that starts with `= + - @`, a tab or a carriage return would run as a formula when
 * the file is opened in a spreadsheet, so it gets a leading `'`. Numbers and booleans are not
 * text, are never formulas, and are written as they are — a negative number must stay a number.
 * Any other value is written as its JSON.
 */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  let text: string;
  if (typeof value === 'string') {
    text = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  } else if (typeof value === 'number' || typeof value === 'boolean') {
    text = String(value);
  } else {
    // Structured values are JSON, which starts with `{`, `[` or `"` and cannot be a formula.
    text = JSON.stringify(value);
  }
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/** One CSV row, newline-terminated. */
export const csvRow = (cells: readonly unknown[]): string => `${cells.map(csvCell).join(',')}\n`;
