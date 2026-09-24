/**
 * Minimal strict RFC-4180 CSV reader/writer for dataset import/export.
 * Handles quoted fields, "" escapes, and embedded newlines/CRLF. Throws
 * ApiError.validation on malformed input — a corrupt upload refuses as a
 * typed 422, never a silent misparse.
 */
import { ApiError } from '../../common/http/api-error';

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let justClosedQuote = false;
  let i = 0;
  let fieldStart = true;
  const n = text.length;
  const fail = (what: string): never => {
    throw ApiError.validation({ csv: what });
  };
  while (i < n) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
        } else {
          inQuotes = false;
          justClosedQuote = true;
          i += 1;
        }
      } else {
        field += ch;
        i += 1;
      }
    } else if (justClosedQuote) {
      // RFC-4180: only a delimiter, EOL, or EOF may follow a closing quote.
      if (ch === ',') {
        row.push(field);
        field = '';
        fieldStart = true;
        justClosedQuote = false;
        i += 1;
      } else if (ch === '\r' || ch === '\n') {
        row.push(field);
        field = '';
        rows.push(row);
        row = [];
        fieldStart = true;
        justClosedQuote = false;
        if (ch === '\r' && text[i + 1] === '\n') i += 2;
        else i += 1;
      } else {
        fail('unexpected character after closing quote');
      }
    } else if (fieldStart && ch === '"') {
      inQuotes = true;
      fieldStart = false;
      i += 1;
    } else if (ch === '"') {
      // A quote may only open a field at its start; mid-field quotes are
      // corrupt input, not data.
      fail('misplaced quote inside unquoted field');
    } else if (ch === ',') {
      row.push(field);
      field = '';
      fieldStart = true;
      i += 1;
    } else if (ch === '\r' || ch === '\n') {
      row.push(field);
      field = '';
      rows.push(row);
      row = [];
      fieldStart = true;
      if (ch === '\r' && text[i + 1] === '\n') i += 2;
      else i += 1;
    } else {
      field += ch;
      fieldStart = false;
      i += 1;
    }
  }
  if (inQuotes) {
    fail('unterminated quoted field');
  }
  // A file ending right after a closing quote is fine.
  if (justClosedQuote || field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  // Drop a single trailing empty row produced by a final newline.
  while (rows.length > 0 && rows[rows.length - 1].length === 1 && rows[rows.length - 1][0] === '') {
    rows.pop();
  }
  return rows;
}

function escapeCell(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

export function toCsv(rows: string[][]): string {
  return rows.map((row) => row.map(escapeCell).join(',')).join('\r\n') + '\r\n';
}
