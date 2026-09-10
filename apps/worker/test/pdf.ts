import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { openPdfium, type Pdfium } from "../src/render.ts";

/**
 * A PDF written out by hand, one content stream per page, so a test can draw a page whose every
 * pixel it knows without shipping somebody's manual in the repository. Bytes, not a string: an
 * inline image carries raw bytes that UTF-8 would mangle.
 */
export function tinyPdf(pages: string[], width = 200, height = 100): Uint8Array {
  const objects: string[] = [];
  const kids = pages.map((_, i) => `${3 + i * 2} 0 R`).join(" ");
  objects.push("<< /Type /Catalog /Pages 2 0 R >>");
  objects.push(`<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`);
  for (const [i, content] of pages.entries()) {
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Contents ${4 + i * 2} 0 R /Resources << >> >>`,
    );
    objects.push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  }
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (const [i, body] of objects.entries()) {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  }
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Uint8Array.from(out, (c) => c.charCodeAt(0));
}

/** A black box, drawn as a path the way outlined type is: no image in it anywhere. */
export const BLACK_BOX = "0 0 0 rg 50 25 100 50 re f";

/** A two-pixel grey image stretched over the left half of the page, the way a scan is placed. */
export const GREY_SCAN = `q 100 0 0 100 0 0 cm BI /W 2 /H 1 /CS /G /BPC 8 ID ${String.fromCharCode(0x40, 0xc0)} EI Q`;

let opened: Promise<Pdfium> | undefined;

/** The PDFium the Worker bundles, compiled here from the same file. */
export function pdfium(): Promise<Pdfium> {
  opened ??= openPdfium(
    new WebAssembly.Module(
      readFileSync(fileURLToPath(import.meta.resolve("@embedpdf/pdfium/pdfium.wasm"))),
    ),
  );
  return opened;
}
