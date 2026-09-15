'use strict';
/**
 * Minimal .xlsx reader - no dependencies.
 *
 * An xlsx file is a ZIP of XML parts. This walks the central directory,
 * inflates the sheet and shared-string parts, and returns each worksheet as
 * rows of plain strings, which the invoice extractor then reads like any
 * other delimited table.
 */
const zlib = require('node:zlib');

/** Read the ZIP central directory and return { name: Buffer } for every entry. */
function unzip(buffer) {
  const files = {};
  // End of central directory record: signature 0x06054b50, within the last 64KB.
  let eocd = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65558); i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Not a ZIP/xlsx file.');

  const entryCount = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);

  for (let n = 0; n < entryCount; n += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) break;
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);

    // The local header repeats the name/extra lengths; data follows it.
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const data = buffer.subarray(dataStart, dataStart + compressedSize);

    try {
      files[name] = method === 0 ? Buffer.from(data) : zlib.inflateRawSync(data);
    } catch {
      // A part we cannot inflate is skipped rather than failing the whole file.
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return files;
}

const decodeXml = (s) => String(s)
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
  .replace(/&amp;/g, '&');

/** Shared strings table; each <si> may be split across several <t> runs. */
function sharedStrings(xml) {
  if (!xml) return [];
  return [...xml.toString('utf8').matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => {
    const runs = [...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => decodeXml(t[1]));
    return runs.join('');
  });
}

const columnIndex = (ref) => {
  const letters = String(ref || '').replace(/\d+/g, '');
  let index = 0;
  for (const ch of letters) index = index * 26 + (ch.charCodeAt(0) - 64);
  return Math.max(index - 1, 0);
};

/** Excel serial date -> ISO date. Excel's epoch is 1899-12-30 (the 1900 leap bug). */
function serialToDate(serial) {
  const ms = Math.round((Number(serial) - 25569) * 86400 * 1000);
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
}

const looksLikeDate = (n) => Number.isFinite(n) && n > 20000 && n < 80000 && Math.abs(n % 1) < 1e-6;

/** Parse one worksheet into an array of row arrays of strings. */
function parseSheet(xml, strings) {
  const rows = [];
  const sheet = xml.toString('utf8');
  for (const rowMatch of sheet.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells = [];
    // Self-closing cells must be matched first, otherwise "<c .../>" swallows
    // the following cells up to the next closing tag.
    for (const cellMatch of rowMatch[1].matchAll(/<c([^>]*?)\/>|<c([^>]*?)>([\s\S]*?)<\/c>/g)) {
      const attrs = cellMatch[1] !== undefined ? cellMatch[1] : (cellMatch[2] || '');
      const body = cellMatch[3] || '';
      const ref = (attrs.match(/r="([A-Z]+\d+)"/) || [])[1];
      const type = (attrs.match(/t="(\w+)"/) || [])[1];
      let value = '';
      if (type === 's') {
        const index = Number((body.match(/<v>([\s\S]*?)<\/v>/) || [])[1]);
        value = strings[index] || '';
      } else if (type === 'inlineStr') {
        value = [...body.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => decodeXml(t[1])).join('');
      } else {
        const raw = (body.match(/<v>([\s\S]*?)<\/v>/) || [])[1];
        if (raw !== undefined) value = decodeXml(raw);
      }
      cells[ref ? columnIndex(ref) : cells.length] = value;
    }
    for (let i = 0; i < cells.length; i += 1) if (cells[i] === undefined) cells[i] = '';
    rows.push(cells);
  }
  return rows;
}

/** Every worksheet in the workbook, as { name, rows }. */
function readWorkbook(buffer) {
  const files = unzip(buffer);
  const strings = sharedStrings(files['xl/sharedStrings.xml']);
  const sheets = Object.keys(files)
    .filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name))
    .sort();
  return sheets.map((name) => ({ name, rows: parseSheet(files[name], strings) }));
}

/**
 * Flatten a workbook to text the invoice parser can read: each row becomes a
 * pipe-delimited line, and a numeric cell next to a "date" label is rendered
 * as a date rather than an Excel serial number.
 */
function workbookToText(buffer) {
  const lines = [];
  for (const sheet of readWorkbook(buffer)) {
    for (const row of sheet.rows) {
      const hasDateLabel = row.some((c) => /date/i.test(c));
      const cells = row.map((cell) => {
        const n = Number(cell);
        if (hasDateLabel && cell !== '' && looksLikeDate(n)) return serialToDate(n);
        return String(cell).replace(/\s+/g, ' ').trim();
      });
      while (cells.length && cells[cells.length - 1] === '') cells.pop();
      while (cells.length && cells[0] === '') cells.shift();
      if (!cells.length) continue;
      lines.push(cells.length === 1 ? cells[0] : cells.join(' | '));
    }
  }
  return lines.join('\n');
}

module.exports = { unzip, readWorkbook, workbookToText, serialToDate };
