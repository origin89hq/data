import assert from "node:assert/strict";
import { test } from "node:test";
import { crc32, inflateSync } from "node:zlib";
import { type Drawn, LONG_EDGE, png, pngDataUrl, renderPage } from "../src/render.ts";
import { BLACK_BOX, GREY_SCAN, pdfium, tinyPdf } from "./pdf.ts";

/** The pixel at (x, y), as [r, g, b]. */
const at = (drawn: Drawn, x: number, y: number): number[] => [
  ...drawn.rgb.subarray((y * drawn.width + x) * 3, (y * drawn.width + x) * 3 + 3),
];

/** Undo the encoder: chunks, checksums, inflate, and the Up filter, back to RGB rows. */
function decode(bytes: Uint8Array): { width: number; height: number; rgb: Uint8Array } {
  assert.deepEqual(
    [...bytes.subarray(0, 8)],
    [137, 80, 78, 71, 13, 10, 26, 10],
    "a PNG starts with its signature",
  );
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 8;
  let width = 0;
  let height = 0;
  const data: Uint8Array[] = [];
  while (offset < bytes.length) {
    const length = view.getUint32(offset);
    const type = new TextDecoder().decode(bytes.subarray(offset + 4, offset + 8));
    const body = bytes.subarray(offset + 8, offset + 8 + length);
    assert.equal(
      view.getUint32(offset + 8 + length),
      crc32(bytes.subarray(offset + 4, offset + 8 + length)),
      `the ${type} checksum holds`,
    );
    if (type === "IHDR") {
      width = new DataView(body.buffer, body.byteOffset).getUint32(0);
      height = new DataView(body.buffer, body.byteOffset).getUint32(4);
      assert.deepEqual([body[8], body[9]], [8, 2], "eight bits a channel, RGB");
    }
    if (type === "IDAT") data.push(body);
    offset += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(data));
  const row = width * 3;
  const rgb = new Uint8Array(row * height);
  for (let y = 0; y < height; y += 1) {
    assert.equal(raw[y * (row + 1)], 2, "every row uses the Up filter");
    for (let x = 0; x < row; x += 1)
      rgb[y * row + x] = (raw[y * (row + 1) + 1 + x] + (y > 0 ? rgb[(y - 1) * row + x] : 0)) & 0xff;
  }
  return { width, height, rgb };
}

test("a page drawn with paths comes out as those paths, which pulling images out of the file would miss", async () => {
  const drawn = renderPage(await pdfium(), tinyPdf([BLACK_BOX]), 1);
  // 200 × 100 points at 150 dpi.
  assert.deepEqual([drawn.width, drawn.height, drawn.pages], [417, 208, 1]);
  assert.deepEqual(at(drawn, 208, 104), [0, 0, 0], "the middle of the box is black");
  assert.deepEqual(at(drawn, 10, 10), [255, 255, 255], "the paper around it is white");
  assert.deepEqual(at(drawn, 400, 200), [255, 255, 255]);
});

test("a placed image is drawn the way a scanned page is, grey where the scan is grey", async () => {
  const drawn = renderPage(await pdfium(), tinyPdf([GREY_SCAN]), 1);
  const [left] = at(drawn, 50, 104);
  const [right] = at(drawn, 150, 104);
  assert.ok(Math.abs(left - 0x40) <= 8, `the dark half is about 0x40, not ${left}`);
  assert.ok(Math.abs(right - 0xc0) <= 8, `the light half is about 0xc0, not ${right}`);
  assert.deepEqual(
    at(drawn, 300, 104),
    [255, 255, 255],
    "the half the image does not cover stays paper",
  );
});

test("a page is drawn with its long edge capped, and never finer than 150 dpi", async () => {
  const poster = renderPage(await pdfium(), tinyPdf([BLACK_BOX], 2000, 1000), 1);
  assert.deepEqual(
    [poster.width, poster.height],
    [LONG_EDGE, LONG_EDGE / 2],
    "a poster is shrunk to fit",
  );
  const card = renderPage(await pdfium(), tinyPdf([BLACK_BOX], 10, 10), 1);
  assert.deepEqual([card.width, card.height], [21, 21], "a card is not blown up to fill the edge");
});

test("pages are counted from one, and the second page is the second page", async () => {
  const drawn = renderPage(await pdfium(), tinyPdf(["", BLACK_BOX]), 2);
  assert.equal(drawn.pages, 2);
  assert.deepEqual(at(drawn, 208, 104), [0, 0, 0], "page two has the box");
  assert.deepEqual(
    at(renderPage(await pdfium(), tinyPdf(["", BLACK_BOX]), 1), 208, 104),
    [255, 255, 255],
    "page one is blank",
  );
});

test("a page that is not there, or a file that is not a PDF, is refused with the reason", async () => {
  const library = await pdfium();
  assert.throws(() => renderPage(library, tinyPdf([BLACK_BOX]), 2), /no page 2 in 1/);
  assert.throws(() => renderPage(library, tinyPdf([BLACK_BOX]), 0), /no page 0 in 1/);
  assert.throws(
    () => renderPage(library, new TextEncoder().encode("PK a zip of logos"), 1),
    /not a PDF, or a damaged one/,
  );
  assert.throws(() => renderPage(library, new Uint8Array(), 1), /could not/);
  // And the library still works after refusing: nothing it allocated was left behind in a bad state.
  assert.deepEqual(at(renderPage(library, tinyPdf([BLACK_BOX]), 1), 208, 104), [0, 0, 0]);
});

test("the PNG decodes back to exactly the pixels it was given", async () => {
  const rgb = Uint8Array.from({ length: 5 * 3 * 3 }, (_, i) => (i * 37) & 0xff);
  const decoded = decode(await png(5, 3, rgb));
  assert.deepEqual([decoded.width, decoded.height], [5, 3]);
  assert.deepEqual([...decoded.rgb], [...rgb]);
});

test("a drawn page survives the round trip through PNG, and a one-pixel picture is still a picture", async () => {
  const drawn = renderPage(await pdfium(), tinyPdf([BLACK_BOX]), 1);
  assert.deepEqual(
    [...decode(await png(drawn.width, drawn.height, drawn.rgb)).rgb],
    [...drawn.rgb],
  );
  assert.deepEqual([...decode(await png(1, 1, new Uint8Array([1, 2, 3]))).rgb], [1, 2, 3]);
});

test("pixels that do not make the picture they claim to are refused rather than encoded", async () => {
  await assert.rejects(png(2, 2, new Uint8Array(11)), /11 bytes are not a 2×2 RGB picture/);
});

test("the data URL carries the PNG whole, even past the size a spread can take", () => {
  const bytes = Uint8Array.from({ length: 200_000 }, (_, i) => i & 0xff);
  const url = pngDataUrl(bytes);
  assert.ok(url.startsWith("data:image/png;base64,"));
  assert.deepEqual(
    [...Buffer.from(url.slice("data:image/png;base64,".length), "base64")],
    [...bytes],
  );
  assert.equal(pngDataUrl(new Uint8Array()), "data:image/png;base64,");
});
