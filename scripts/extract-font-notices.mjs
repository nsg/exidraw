// Maintenance helper, not part of builds. Reads the untransformed OpenType
// name table directly from a WOFF2 stream using only Node's Brotli support.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { brotliDecompressSync } from "node:zlib";

const tags = [
  "cmap", "head", "hhea", "hmtx", "maxp", "name", "OS/2", "post",
  "cvt ", "fpgm", "glyf", "loca", "prep", "CFF ", "VORG", "EBDT",
  "EBLC", "gasp", "hdmx", "kern", "LTSH", "PCLT", "VDMX", "vhea",
  "vmtx", "BASE", "GDEF", "GPOS", "GSUB", "EBSC", "JSTF", "MATH",
  "CBDT", "CBLC", "COLR", "CPAL", "SVG ", "sbix", "acnt", "avar",
  "bdat", "bloc", "bsln", "cvar", "fdsc", "feat", "fmtx", "fvar",
  "gvar", "hsty", "just", "lcar", "mort", "morx", "opbd", "prop",
  "trak", "Zapf", "Silf", "Glat", "Gloc", "Feat", "Sill",
];

export function extractNameRecords(filename) {
  const font = readFileSync(filename);
  if (font.length < 48 || font.toString("ascii", 0, 4) !== "wOF2") {
    throw new Error(`${filename}: not a WOFF2 font`);
  }
  if (font.readUInt32BE(4) === 0x74746366) {
    throw new Error("WOFF2 collections are not supported");
  }
  let cursor = 48;
  function uintBase128() {
    let value = 0;
    for (let byte = 0; byte < 5; byte++) {
      const next = font.readUInt8(cursor++);
      if ((byte === 0 && next === 0x80) || value > 0x1ffffff) {
        throw new Error("Invalid WOFF2 UIntBase128");
      }
      value = value * 128 + (next & 0x7f);
      if (!(next & 0x80)) return value;
    }
    throw new Error("Invalid WOFF2 UIntBase128");
  }
  let offset = 0;
  let nameTable;
  for (let i = 0; i < font.readUInt16BE(12); i++) {
    const flags = font.readUInt8(cursor++);
    const tagIndex = flags & 0x3f;
    let tag = tags[tagIndex];
    if (tagIndex === 63) {
      tag = font.toString("ascii", cursor, cursor + 4);
      cursor += 4;
    }
    const originalLength = uintBase128();
    const version = flags >> 6;
    const transformed = tag === "glyf" || tag === "loca"
      ? version !== 3
      : version !== 0;
    const length = transformed ? uintBase128() : originalLength;
    if (tag === "name") {
      if (transformed) throw new Error("Transformed name table is not supported");
      nameTable = { offset, length };
    }
    offset += length;
  }
  const compressedSize = font.readUInt32BE(20);
  if (cursor + compressedSize > font.length) throw new Error("Truncated WOFF2 stream");
  const stream = brotliDecompressSync(font.subarray(cursor, cursor + compressedSize));
  if (stream.length !== offset || !nameTable) throw new Error("Invalid WOFF2 table stream");
  const table = stream.subarray(nameTable.offset, nameTable.offset + nameTable.length);
  const count = table.readUInt16BE(2);
  const storageOffset = table.readUInt16BE(4);
  if (6 + count * 12 > table.length) throw new Error("Truncated name records");
  const records = [];
  for (let i = 0; i < count; i++) {
    const start = 6 + i * 12;
    const platform = table.readUInt16BE(start);
    const encoding = table.readUInt16BE(start + 2);
    const language = table.readUInt16BE(start + 4);
    const nameID = table.readUInt16BE(start + 6);
    const length = table.readUInt16BE(start + 8);
    const offset = storageOffset + table.readUInt16BE(start + 10);
    if (offset + length > table.length) throw new Error("Truncated name string");
    const bytes = table.subarray(offset, offset + length);
    let text;
    if (platform === 0 || (platform === 3 && [0, 1, 10].includes(encoding))) {
      if (length % 2) throw new Error("Invalid UTF-16 name string");
      text = Buffer.from(bytes).swap16().toString("utf16le");
    } else if (platform === 1 && encoding === 0) {
      text = new TextDecoder("macintosh", { fatal: true }).decode(bytes);
    } else {
      continue;
    }
    records.push({ platform, encoding, language, nameID, text });
  }
  return records;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const option = args[0]?.match(/^--name-id=(\d+)$/);
  const nameID = option ? Number(args.shift().split("=")[1]) : 13;
  if (!args.length) throw new Error("Usage: node scripts/extract-font-notices.mjs [--name-id=13] FONT.woff2 [...]");
  for (const filename of args) {
    console.log(JSON.stringify({ filename, records: extractNameRecords(filename).filter((record) => record.nameID === nameID) }, null, 2));
  }
}
