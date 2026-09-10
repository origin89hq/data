import wasm from "@embedpdf/pdfium/pdfium.wasm";
import { openPdfium, type Pdfium } from "./render.ts";

let opened: Promise<Pdfium> | undefined;

/**
 * PDFium, once per isolate. The module is compiled when the Worker is uploaded; instantiating it
 * costs tens of milliseconds, so it happens on the first page anybody asks to see and is kept. A
 * failure is not kept: the next page tries again rather than inheriting a broken library.
 */
export function pdfium(): Promise<Pdfium> {
  opened ??= openPdfium(wasm).catch((error: unknown) => {
    opened = undefined;
    throw error;
  });
  return opened;
}
