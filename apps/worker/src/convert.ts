import { sectionsOf, withOpenings } from "./layout.ts";
import { CONVERTER, textLayer } from "./reading.ts";
import { type ConvertedPdf, convertPdf, type Pdfium } from "./render.ts";
import { partKey, type Work } from "./work.ts";

/**
 * Converting a document to the text its reader reads. Kept out of the queue handler, which imports
 * the WebAssembly, so it can be run in a test with the PDFium the tests compile.
 */

type ConvertMessage = Extract<Work, { kind: "convert" }>;

/**
 * What a PDF's conversion says of itself, beside its text: the pages the document has and the pages
 * written down. A document longer than the converter writes is read in part, and its reading says
 * so, so that the figures pull keeps what the rest of it gave before instead of taking it back.
 */
export function pageMetadata(read: Pick<ConvertedPdf, "pages" | "converted">): {
  pages: string;
  converted: string;
} {
  return { pages: String(read.pages), converted: String(read.converted) };
}

/** Pages a conversion wrote down, from what it says of itself; none for one that says nothing. */
export function pagesConverted(metadata: Record<string, string> | undefined): number {
  const converted = Number(metadata?.converted);
  return Number.isSafeInteger(converted) ? converted : 0;
}

/** Pages of a document its conversion did not write down, from what the conversion says of itself. */
export function pagesUnconverted(metadata: Record<string, string> | undefined): number {
  const pages = Number(metadata?.pages);
  const converted = Number(metadata?.converted);
  if (!Number.isSafeInteger(pages) || !Number.isSafeInteger(converted)) return 0;
  return Math.max(0, pages - converted);
}

/**
 * Convert a document and send it to be read.
 *
 * A PDF is read from where its characters sit: a table keeps its columns, and a value stays under
 * the model it belongs to. Its headings are kept beside it, so the sections it states its ratings in
 * are known without opening the document again. A PDF of pictures has no characters and gives
 * nothing here, which is what the page reader is for; `toMarkdown` writes down what it can of it,
 * and of anything that is not a PDF.
 *
 * A conversion is kept and not made twice, with one exception. A PDF converted before its
 * conversion said how many pages it wrote was written by a converter that stopped at page 80 and did
 * not say so, and 69 of wave 2's documents were cut there. Such a conversion is made again, once:
 * the pages it had come out the same, character for character, so the windows already read of them
 * still stand, and only the pages it did not have are read. Every PDF's conversion says it, a scan's
 * too, so that once is once: a scan whose conversion said nothing was looked at again at every
 * convert.
 *
 * The new conversion replaces the one kept only where it adds to it. Windows already read are taken
 * up again by their place in the text, so a text that changed before its end would have them stand
 * for words it no longer holds. A scan with a typed page past page 80 was `toMarkdown`'s then and
 * would be read from its characters now: it keeps what `toMarkdown` wrote.
 */
export async function convertDocument(
  message: ConvertMessage,
  env: Env,
  library: () => Promise<Pdfium>,
): Promise<void> {
  const markdown = partKey.markdown(message.sha256, CONVERTER);
  const already = await env.ARCHIVE.head(markdown);
  const pdf = /pdf/i.test(message.contentType);
  const unsure = already !== null && pdf && already.customMetadata?.pages === undefined;
  let size = already?.size;
  if (!already || unsure) {
    const object = await env.ARCHIVE.get(`archive/${message.sha256}`);
    if (!object) throw new Error(`archive/${message.sha256} is not in the archive`);
    const bytes = new Uint8Array(await object.arrayBuffer());
    let text: string | undefined;
    let pages: Record<string, string> | undefined;
    let outline: string | undefined;
    if (pdf) {
      const read = convertPdf(await library(), bytes);
      pages = pageMetadata(read);
      if (textLayer(read.markdown).characters > 0) {
        text = read.markdown;
        outline = `${JSON.stringify(withOpenings(text, sectionsOf(read.outline, read.pages)))}\n`;
      }
    }
    // A conversion made before stands unless this one only adds to it, and is written back with its
    // pages counted. A scan's was `toMarkdown`'s, and asking it again would only ask it again: what
    // it wrote stands, and the page reader reads the pages.
    if (unsure) {
      const before = await (await env.ARCHIVE.get(markdown))?.text();
      if (before !== undefined && !text?.startsWith(before)) {
        text = before;
        outline = undefined;
      }
    }
    if (outline !== undefined)
      await env.ARCHIVE.put(partKey.outline(message.sha256, CONVERTER), outline, {
        httpMetadata: { contentType: "application/json" },
      });
    if (text === undefined) {
      const blob = new Blob([bytes], { type: message.contentType });
      const name = new URL(message.url).pathname.split("/").pop() || message.sha256;
      const result = await env.AI.toMarkdown({ name, blob });
      const one = Array.isArray(result) ? result[0] : result;
      if (!one || one.format === "error" || typeof one.data !== "string") {
        // A scanned manual with no text layer is an answer about the maker's catalogue, not a
        // failure to retry. It is recorded and the message is done.
        await env.ARCHIVE.put(
          partKey.converted(message.manufacturer, message.run, message.sha256),
          JSON.stringify({ ...message, error: one?.error ?? "the converter returned no text" }),
          { httpMetadata: { contentType: "application/json" } },
        );
        return;
      }
      text = one.data;
    }
    const written = text ?? "";
    await env.ARCHIVE.put(markdown, written, {
      httpMetadata: { contentType: "text/markdown" },
      ...(pages ? { customMetadata: pages } : {}),
    });
    size = new TextEncoder().encode(written).length;
  }
  await env.ARCHIVE.put(
    partKey.converted(message.manufacturer, message.run, message.sha256),
    JSON.stringify({
      sha256: message.sha256,
      url: message.url,
      key: markdown,
      characters: size ?? 0,
    }),
    {
      httpMetadata: { contentType: "application/json" },
    },
  );
  // Converting and reading are two units, and the second only exists once the first has produced
  // something. Chaining them here is what makes the pipeline run without a caller.
  await env.WORK.send({
    kind: "extract",
    manufacturer: message.manufacturer,
    date: message.date,
    run: message.run,
    sha256: message.sha256,
    url: message.url,
    key: markdown,
  });
}
