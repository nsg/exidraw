import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Full OFL and MIT bodies were extracted once from installed font metadata;
// accompanying notices and source records are checked in alongside them.
// Build-time work needs no font decoder, network, or dependency.
export function writeFontNotices(fontsDirectory) {
  const read = (filename) => readFileSync(new URL(`./notices/${filename}`, import.meta.url), "utf8");
  const text = [
    read("FONT-NOTICES.txt"),
    "SIL OPEN FONT LICENSE 1.1 — full text (Virgil nameID 13)",
    read("OFL-1.1.txt"),
    "COMIC SHANNS — full MIT license (nameID 0)",
    read("ComicShanns-MIT.txt"),
    read("LIBERATION-NOTICE.txt"),
  ].join("\n\n");
  writeFileSync(join(fontsDirectory, "LICENSES.txt"), `${text}\n`, "utf8");
}
