import { init, type WrappedPdfiumModule } from "@embedpdf/pdfium";
import { type Char, type Heading, headingsOn, markdownOf } from "./layout.ts";
import { MAX_PAGES } from "./reading.ts";

/**
 * Drawing a PDF page inside a Worker, which has no canvas.
 *
 * PDFium compiled to WebAssembly draws whatever the page is made of: the JPEG a scanner wrote, the
 * JBIG2 and CCITT fax of an office copier, JPEG 2000, and type that was turned into outlines. The
 * obvious shortcut — pull the embedded images out and show those — sees none of the last kind, and
 * a third of the scanned documents sampled had no image in them at all.
 *
 * Kept apart from the module that imports the WebAssembly, so the drawing can be tested in Node
 * with the same binary the Worker runs.
 */
export type Pdfium = WrappedPdfiumModule;
export type { Char, Heading };

/** Pixels on the long edge of a drawn page: small type in a spec table stays legible to the model. */
export const LONG_EDGE = 1600;

/** And never finer than this, so a business card is not drawn the size of a poster. */
const MAX_DPI = 150;

/** Draw form fields and annotations, and keep PDFium's image cache small: memory is the limit here. */
const RENDER_FLAGS = 0x01 | 0x200;

/** PDFium's own reasons, by the number `FPDF_GetLastError` gives. */
const LOAD_ERRORS: Record<number, string> = {
  1: "an unknown error",
  2: "a file it could not open",
  3: "not a PDF, or a damaged one",
  4: "a password",
  5: "a security handler it does not support",
  6: "a missing page",
};

/**
 * Open PDFium from its compiled module. A Worker cannot compile WebAssembly from bytes while it
 * runs, so the module arrives compiled and is only instantiated here.
 */
export async function openPdfium(module: WebAssembly.Module): Promise<Pdfium> {
  // Emscripten takes the instance through a callback and has no way to hear that it failed, so a
  // failure is raced against the load instead of leaving it waiting for ever.
  let refuse: (reason: unknown) => void = () => {};
  const refused = new Promise<never>((_, reject) => {
    refuse = reject;
  });
  const pdfium = await Promise.race([
    init({
      instantiateWasm: (
        imports: WebAssembly.Imports,
        receive: (instance: WebAssembly.Instance, module: WebAssembly.Module) => void,
      ) => {
        WebAssembly.instantiate(module, imports).then(
          (instance) => receive(instance, module),
          refuse,
        );
        return {};
      },
    } as Parameters<typeof init>[0]),
    refused,
  ]);
  pdfium.PDFiumExt_Init();
  return pdfium;
}

/** One drawn page, three bytes a pixel, rows top to bottom. */
export interface Drawn {
  width: number;
  height: number;
  rgb: Uint8Array;
  /** Pages in the whole document, which the caller may not have known. */
  pages: number;
}

/**
 * Draw one page, counted from one, with its long edge at `longEdge` pixels.
 *
 * Synchronous from opening the document to closing it, on purpose: nothing else in the isolate can
 * run in between, so however many messages arrive at once, PDFium's memory holds one document.
 */
export function renderPage(
  pdfium: Pdfium,
  bytes: Uint8Array,
  page: number,
  longEdge = LONG_EDGE,
): Drawn {
  const pointer = pdfium.pdfium.wasmExports.malloc(bytes.length);
  if (!pointer) throw new Error(`PDFium could not make room for ${bytes.length} bytes`);
  try {
    // Read afresh after every call that may grow the memory: growing replaces the buffer.
    heap(pdfium).set(bytes, pointer);
    const document = pdfium.FPDF_LoadMemDocument64(pointer, bytes.length, "");
    if (!document)
      throw new Error(
        `PDFium could not open it: ${LOAD_ERRORS[pdfium.FPDF_GetLastError()] ?? "an unknown error"}`,
      );
    try {
      const pages = pdfium.FPDF_GetPageCount(document);
      if (page < 1 || page > pages) throw new Error(`there is no page ${page} in ${pages}`);
      const loaded = pdfium.FPDF_LoadPage(document, page - 1);
      if (!loaded) throw new Error(`PDFium could not load page ${page}`);
      try {
        const widthPt = pdfium.FPDF_GetPageWidthF(loaded);
        const heightPt = pdfium.FPDF_GetPageHeightF(loaded);
        if (!(widthPt > 0 && heightPt > 0)) throw new Error(`page ${page} has no size`);
        const scale = Math.min(MAX_DPI / 72, longEdge / Math.max(widthPt, heightPt));
        const width = Math.max(1, Math.round(widthPt * scale));
        const height = Math.max(1, Math.round(heightPt * scale));
        const bitmap = pdfium.FPDFBitmap_Create(width, height, 0);
        if (!bitmap) throw new Error(`PDFium could not make a ${width}×${height} bitmap`);
        try {
          pdfium.FPDFBitmap_FillRect(bitmap, 0, 0, width, height, 0xffffffff);
          pdfium.FPDF_RenderPageBitmap(bitmap, loaded, 0, 0, width, height, 0, RENDER_FLAGS);
          const stride = pdfium.FPDFBitmap_GetStride(bitmap);
          const at = pdfium.FPDFBitmap_GetBuffer(bitmap);
          const memory = heap(pdfium);
          // PDFium writes blue, green, red and an unused byte; the picture wants red, green, blue.
          const rgb = new Uint8Array(width * height * 3);
          for (let y = 0; y < height; y += 1) {
            const row = at + y * stride;
            const out = y * width * 3;
            for (let x = 0; x < width; x += 1) {
              rgb[out + x * 3] = memory[row + x * 4 + 2];
              rgb[out + x * 3 + 1] = memory[row + x * 4 + 1];
              rgb[out + x * 3 + 2] = memory[row + x * 4];
            }
          }
          return { width, height, rgb, pages };
        } finally {
          pdfium.FPDFBitmap_Destroy(bitmap);
        }
      } finally {
        pdfium.FPDF_ClosePage(loaded);
      }
    } finally {
      pdfium.FPDF_CloseDocument(document);
    }
  } finally {
    pdfium.pdfium.wasmExports.free(pointer);
  }
}

/**
 * A whole document as Markdown, one page at a time, each under the page heading the reader windows
 * on. Pages are read from where their characters sit, so a table stays a table; a page with no
 * characters is left empty, and a document of those is a scan for the page reader.
 */
export function markdownOfDocument(
  pdfium: Pdfium,
  bytes: Uint8Array,
  mostPages = MAX_PAGES,
): string {
  const pages = pageCount(pdfium, bytes);
  const out: string[] = [];
  for (let page = 1; page <= Math.min(pages, mostPages); page += 1) {
    out.push(`### Page ${page}`);
    // Said under the heading, not in it: the reader windows on the heading and would not find one
    // written any other way.
    const chars = charsOn(pdfium, bytes, page);
    // Said only where there is text to qualify. A page of pictures and nothing else has nothing to
    // read, and a notice on it would count as the document's text — an image-only PDF would then
    // be stored as converted, and never reach the reader that draws its pages.
    if (chars.length > 0 && picturesOn(pdfium, bytes, page) >= MOSTLY_DRAWN)
      out.push("_This page is mostly a picture; the text on it labels what is drawn._");
    out.push(markdownOf(chars, rulesOn(pdfium, bytes, page)));
  }
  return `${out.join("\n")}\n`;
}

/**
 * A document's outline: every heading of every page, in order, with the page it stands on. One
 * short list for a manual of eighty pages, which is what a reader can be asked about before it is
 * asked to read anything.
 */
export function outlineOf(pdfium: Pdfium, bytes: Uint8Array, mostPages = MAX_PAGES): Heading[] {
  const pages = Math.min(pageCount(pdfium, bytes), mostPages);
  const outline: Heading[] = [];
  for (let page = 1; page <= pages; page += 1)
    outline.push(...headingsOn(charsOn(pdfium, bytes, page), page));
  return outline;
}

/**
 * How much of a page its pictures cover, as a fraction of it.
 *
 * A page a document draws is not a page it tabulates. EPEVER's appendix gives a conversion
 * efficiency curve a page at a time, each headed "Solar Module MPP Voltage (17V, 34V)/Nominal
 * System Voltage (13V)" — the conditions the curve was measured at, in the shape of a
 * specification. Read as a table, ten such headings in sixty figures became ratings of a
 * controller. A product photograph beside a paragraph covers a seventh of its page; these cover
 * nearly half.
 */
export function picturesOn(pdfium: Pdfium, bytes: Uint8Array, page: number): number {
  const pointer = pdfium.pdfium.wasmExports.malloc(bytes.length);
  if (!pointer) throw new Error(`PDFium could not make room for ${bytes.length} bytes`);
  try {
    heap(pdfium).set(bytes, pointer);
    const document = pdfium.FPDF_LoadMemDocument64(pointer, bytes.length, "");
    if (!document) return 0;
    try {
      const loaded = pdfium.FPDF_LoadPage(document, page - 1);
      if (!loaded) return 0;
      const box = pdfium.pdfium.wasmExports.malloc(4 * 4);
      try {
        const width = pdfium.FPDF_GetPageWidthF(loaded);
        const height = pdfium.FPDF_GetPageHeightF(loaded);
        if (!(width > 0 && height > 0) || !box) return 0;
        // What the pictures cover between them, marked on a grid over the page. Adding their areas
        // up counted a picture drawn over another one twice, and counted what hangs off the page:
        // enough of either and a page of specifications would be called a drawing, its text read as
        // labels, and its ratings left out.
        const over = new Uint8Array(GRID * GRID);
        for (let i = 0; i < pdfium.FPDFPage_CountObjects(loaded); i += 1) {
          const object = pdfium.FPDFPage_GetObject(loaded, i);
          // 3 is an image; text, paths and shading are what a table and its rules are made of.
          if (pdfium.FPDFPageObj_GetType(object) !== 3) continue;
          if (!pdfium.FPDFPageObj_GetBounds(object, box, box + 4, box + 8, box + 12)) continue;
          const at = new Float32Array(heap(pdfium).buffer, box, 4);
          const [left, bottom, right, top] = at;
          if (
            left === undefined ||
            bottom === undefined ||
            right === undefined ||
            top === undefined
          )
            continue;
          const fromX = Math.max(0, left);
          const fromY = Math.max(0, bottom);
          const toX = Math.min(width, right);
          const toY = Math.min(height, top);
          for (
            let x = Math.floor((fromX / width) * GRID);
            x < Math.ceil((toX / width) * GRID);
            x += 1
          )
            for (
              let y = Math.floor((fromY / height) * GRID);
              y < Math.ceil((toY / height) * GRID);
              y += 1
            )
              if (x >= 0 && y >= 0 && x < GRID && y < GRID) over[y * GRID + x] = 1;
        }
        let cells = 0;
        for (const cell of over) cells += cell;
        return cells / (GRID * GRID);
      } finally {
        if (box) pdfium.pdfium.wasmExports.free(box);
        pdfium.FPDF_ClosePage(loaded);
      }
    } finally {
      pdfium.FPDF_CloseDocument(document);
    }
  } finally {
    pdfium.pdfium.wasmExports.free(pointer);
  }
}

/**
 * Where a page rules its table: the x of every line drawn down it, in points.
 *
 * A ruled table says where its columns are, and reading them from the rules is exact where reading
 * them from the text is a guess. It is also the only way to see a cell drawn across two columns:
 * EPEVER's specification table merges XTRA1206N and XTRA2206N into one cell, and placed under one
 * of them the other model took the value of the model after it.
 */
export function rulesOn(pdfium: Pdfium, bytes: Uint8Array, page: number): number[] {
  const pointer = pdfium.pdfium.wasmExports.malloc(bytes.length);
  if (!pointer) throw new Error(`PDFium could not make room for ${bytes.length} bytes`);
  try {
    heap(pdfium).set(bytes, pointer);
    const document = pdfium.FPDF_LoadMemDocument64(pointer, bytes.length, "");
    if (!document) return [];
    try {
      const loaded = pdfium.FPDF_LoadPage(document, page - 1);
      if (!loaded) return [];
      const box = pdfium.pdfium.wasmExports.malloc(4 * 4);
      try {
        if (!box) return [];
        const down: number[] = [];
        for (let i = 0; i < pdfium.FPDFPage_CountObjects(loaded); i += 1) {
          const object = pdfium.FPDFPage_GetObject(loaded, i);
          // 2 is a path: the lines a table is ruled with, among whatever else is drawn.
          if (pdfium.FPDFPageObj_GetType(object) !== 2) continue;
          if (!pdfium.FPDFPageObj_GetBounds(object, box, box + 4, box + 8, box + 12)) continue;
          const at = new Float32Array(heap(pdfium).buffer, box, 4);
          const [left, bottom, right, top] = at;
          if (
            left === undefined ||
            bottom === undefined ||
            right === undefined ||
            top === undefined
          )
            continue;
          // A rule down the page is thin and long; a box, an arrow or a logo is neither.
          if (right - left < RULE_THIN && top - bottom > RULE_LONG) down.push((left + right) / 2);
        }
        return down.sort((a, b) => a - b);
      } finally {
        if (box) pdfium.pdfium.wasmExports.free(box);
        pdfium.FPDF_ClosePage(loaded);
      }
    } finally {
      pdfium.FPDF_CloseDocument(document);
    }
  } finally {
    pdfium.pdfium.wasmExports.free(pointer);
  }
}

/** How thin a drawn line must be to be a rule, and how long, in points. */
const RULE_THIN = 2;
const RULE_LONG = 5;

/** How finely a page is divided to measure what its pictures cover between them. */
const GRID = 64;

/** How much of a page must be picture before its text is read as labelling one. */
export const MOSTLY_DRAWN = 0.3;

/** How many pages a document has, without drawing or reading any of them. */
export function pageCount(pdfium: Pdfium, bytes: Uint8Array): number {
  const pointer = pdfium.pdfium.wasmExports.malloc(bytes.length);
  if (!pointer) throw new Error(`PDFium could not make room for ${bytes.length} bytes`);
  try {
    heap(pdfium).set(bytes, pointer);
    const document = pdfium.FPDF_LoadMemDocument64(pointer, bytes.length, "");
    if (!document)
      throw new Error(
        `PDFium could not open it: ${LOAD_ERRORS[pdfium.FPDF_GetLastError()] ?? "an unknown error"}`,
      );
    try {
      return pdfium.FPDF_GetPageCount(document);
    } finally {
      pdfium.FPDF_CloseDocument(document);
    }
  } finally {
    pdfium.pdfium.wasmExports.free(pointer);
  }
}

const heap = (pdfium: Pdfium): Uint8Array =>
  (pdfium.pdfium as unknown as { HEAPU8: Uint8Array }).HEAPU8;

/**
 * Every character of a page, with the box PDFium says it occupies, in points from the bottom left.
 *
 * The same library the page reader draws with knows where each character sits, so a table can be
 * read from the page rather than from a stream of text that lost its columns. A page drawn as
 * pictures has no characters and gives none: that is what the page reader is for.
 *
 * Synchronous from opening the document to closing it, for the reason `renderPage` is.
 */
export function charsOn(pdfium: Pdfium, bytes: Uint8Array, page: number): Char[] {
  const pointer = pdfium.pdfium.wasmExports.malloc(bytes.length);
  if (!pointer) throw new Error(`PDFium could not make room for ${bytes.length} bytes`);
  try {
    heap(pdfium).set(bytes, pointer);
    const document = pdfium.FPDF_LoadMemDocument64(pointer, bytes.length, "");
    if (!document)
      throw new Error(
        `PDFium could not open it: ${LOAD_ERRORS[pdfium.FPDF_GetLastError()] ?? "an unknown error"}`,
      );
    try {
      const pages = pdfium.FPDF_GetPageCount(document);
      if (page < 1 || page > pages) throw new Error(`there is no page ${page} in ${pages}`);
      const loaded = pdfium.FPDF_LoadPage(document, page - 1);
      if (!loaded) throw new Error(`PDFium could not load page ${page}`);
      try {
        const text = pdfium.FPDFText_LoadPage(loaded);
        if (!text) throw new Error(`PDFium could not read the text of page ${page}`);
        try {
          // Four doubles, written by PDFium and read back after every call: left, right, bottom, top.
          const box = pdfium.pdfium.wasmExports.malloc(8 * 4);
          if (!box) throw new Error("PDFium could not make room for a character box");
          try {
            const chars: Char[] = [];
            const count = pdfium.FPDFText_CountChars(text);
            for (let index = 0; index < count; index += 1) {
              if (!pdfium.FPDFText_GetCharBox(text, index, box, box + 8, box + 16, box + 24))
                continue;
              const at = new Float64Array(heap(pdfium).buffer, box, 4);
              const code = pdfium.FPDFText_GetUnicode(text, index);
              const [left, right, bottom, top] = at;
              if (
                left === undefined ||
                right === undefined ||
                bottom === undefined ||
                top === undefined
              )
                continue;
              // Which way the character faces. A label printed up the side of a page is a line of
              // its own, and read as though it were upright its letters fall one into each row it
              // passes: a Progressive Dynamics manual came out as "OOCCACC/RERRTREVNERMINRTELE".
              const angle = pdfium.FPDFText_GetCharAngle(text, index);
              // The size it is set in, which is how a section's heading is told from its text.
              const size = pdfium.FPDFText_GetFontSize(text, index);
              chars.push({
                text: String.fromCodePoint(code),
                left,
                right,
                bottom,
                top,
                ...(Number.isFinite(angle) && Math.abs(angle) > 0.01 ? { angle } : {}),
                ...(Number.isFinite(size) && size > 0 ? { size } : {}),
              });
            }
            return chars;
          } finally {
            pdfium.pdfium.wasmExports.free(box);
          }
        } finally {
          pdfium.FPDFText_ClosePage(text);
        }
      } finally {
        pdfium.FPDF_ClosePage(loaded);
      }
    } finally {
      pdfium.FPDF_CloseDocument(document);
    }
  } finally {
    pdfium.pdfium.wasmExports.free(pointer);
  }
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(parts: Uint8Array[]): number {
  let c = 0xffffffff;
  for (const part of parts) for (const byte of part) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const name = new TextEncoder().encode(type);
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(name, 4);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32([name, data]));
  return out;
}

/**
 * RGB pixels as a PNG. The runtime already has a zlib compressor, so a PNG is a header, the rows
 * each filtered against the row above (paper is mostly the same white as the line before it), and
 * a checksum — no library.
 */
export async function png(width: number, height: number, rgb: Uint8Array): Promise<Uint8Array> {
  if (rgb.length !== width * height * 3)
    throw new Error(`${rgb.length} bytes are not a ${width}×${height} RGB picture`);
  const row = width * 3;
  const filtered = new Uint8Array((row + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const at = y * (row + 1);
    const from = y * row;
    filtered[at] = 2;
    for (let x = 0; x < row; x += 1)
      filtered[at + 1 + x] = (rgb[from + x] - (y > 0 ? rgb[from - row + x] : 0)) & 0xff;
  }
  const compressed = new Uint8Array(
    await new Response(
      new Blob([filtered]).stream().pipeThrough(new CompressionStream("deflate")),
    ).arrayBuffer(),
  );
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header[8] = 8;
  header[9] = 2;
  const parts = [
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", compressed),
    pngChunk("IEND", new Uint8Array()),
  ];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** A picture as the data URL a model's `image_url` takes. Built in slices: a spread of a megabyte overflows the stack. */
export function pngDataUrl(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:image/png;base64,${btoa(binary)}`;
}
