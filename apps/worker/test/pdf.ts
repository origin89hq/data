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

/** One string of a written page, placed by its left edge and its baseline, in points. */
export interface Placed {
  text: string;
  x: number;
  y: number;
  size?: number;
  /** Quarter turns anticlockwise, for a label printed up the side of a page. */
  turn?: 0 | 1 | 3;
}

/**
 * A page of real text at places a test chooses, in one of the fourteen fonts every reader has, so
 * nothing is embedded. What a datasheet does with a table — a name at the left, a value under each
 * model's heading — a test can do in four lines and then read back through PDFium.
 */
export function writtenPdf(
  pages: Placed[][],
  width = 300,
  height = 200,
  /** How much of each page a picture covers, for a page a document draws rather than tabulates. */
  drawn: number[] = [],
  /** Where each page rules its table, as the x of a line drawn down it. */
  rules: number[][] = [],
  /** Pictures placed on each page, as [x, y, width, height] in points, to overlap or hang off it. */
  pictures: [number, number, number, number][][] = [],
): Uint8Array {
  const streams = pages.map(
    (page, i) =>
      (rules[i] ?? []).map((x) => `q 0.5 w ${x} 10 m ${x} ${height - 10} l S Q\n`).join("") +
      (pictures[i] ?? [])
        .map(
          ([x, y, w, h]) =>
            `q ${w} 0 0 ${h} ${x} ${y} cm BI /W 1 /H 1 /CS /G /BPC 8 ID ${String.fromCharCode(0x80)} EI Q\n`,
        )
        .join("") +
      (drawn[i]
        ? // One grey pixel stretched over that share of the page, as a chart is placed.
          `q ${Math.round(width * (drawn[i] ?? 0))} 0 0 ${Math.round(height * 0.9)} 0 0 cm BI /W 1 /H 1 /CS /G /BPC 8 ID ${String.fromCharCode(0x80)} EI Q\n`
        : "") +
      page
        .map(({ text, x, y, size = 10, turn = 0 }) => {
          const placed =
            turn === 1
              ? `0 1 -1 0 ${x} ${y} Tm`
              : turn === 3
                ? `0 -1 1 0 ${x} ${y} Tm`
                : `${x} ${y} Td`;
          return `BT /F1 ${size} Tf ${placed} (${text.replace(/([()\\])/g, "\\$1")}) Tj ET`;
        })
        .join("\n"),
  );
  const objects: string[] = [];
  const font = 3 + streams.length * 2;
  objects.push("<< /Type /Catalog /Pages 2 0 R >>");
  objects.push(
    `<< /Type /Pages /Kids [${streams.map((_, i) => `${3 + i * 2} 0 R`).join(" ")}] /Count ${streams.length} >>`,
  );
  for (const [i, content] of streams.entries()) {
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Contents ${4 + i * 2} 0 R /Resources << /Font << /F1 ${font} 0 R >> >> >>`,
    );
    objects.push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  }
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
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
