import assert from "node:assert/strict";
import { test } from "node:test";
import {
  discoverPages,
  type Fetched,
  fetchPage,
  type HostSeen,
  hopOrder,
  hostsToTry,
  isDocumentAnswer,
  isPage,
  MAX_CHILD_SITEMAPS,
  MAX_FRONTIER_BYTES,
  MAX_LINKS_PER_BATCH,
  MAX_PAGE_BYTES,
  MAX_RESULT_BYTES,
  nextHop,
  pageLinks,
  readPages,
  seedPages,
  trustedDocumentHosts,
  withCited,
} from "../src/discover.ts";
import { sample } from "../src/sitemap.ts";

const urlset = (...urls: string[]) =>
  `<?xml version="1.0"?><urlset>${urls.map((u) => `<url><loc>${u}</loc></url>`).join("")}</urlset>`;
const index = (...urls: string[]) =>
  `<?xml version="1.0"?><sitemapindex>${urls.map((u) => `<sitemap><loc>${u}</loc></sitemap>`).join("")}</sitemapindex>`;
const home = "<!doctype html><html><body>home</body></html>";

type Answer = string | Partial<Fetched>;

/** A site answering from a table of urls, 404 to everything else, and remembering what was asked. */
function site(answers: Record<string, Answer>) {
  const asked: string[] = [];
  const get = async (url: string): Promise<Fetched> => {
    asked.push(url);
    const answer = answers[url];
    if (answer === undefined) return { status: 404, url, text: "" };
    if (typeof answer === "string") return { status: 200, url, text: answer };
    return { status: 200, url, text: "", ...answer };
  };
  return { get, asked };
}

/** A host report with nothing unusual, for the fields a test does not care about. */
const seenAt = (over: Partial<HostSeen>): HostSeen => ({
  domain: "maker.test",
  host: "maker.test",
  status: 200,
  sitemap: "urlset",
  listed: 0,
  own: 0,
  requests: 1,
  refused: 0,
  silent: 0,
  childrenFailed: 0,
  childrenSkipped: 0,
  redirectedTo: [],
  rootRedirectedTo: [],
  listedElsewhere: [],
  listedElsewhereMore: 0,
  ...over,
});

test("a sitemap's own pages are the pages, and nothing else is knocked on", async () => {
  const { get, asked } = site({
    "https://maker.test/sitemap.xml": urlset(
      "https://maker.test/product/a",
      "https://maker.test/product/b",
      "https://reseller.test/maker-a",
    ),
  });
  const { pages, hosts } = await discoverPages(["maker.test"], get);
  assert.deepEqual(pages, ["https://maker.test/product/a", "https://maker.test/product/b"]);
  assert.deepEqual(asked, ["https://maker.test/sitemap.xml"]);
  assert.deepEqual(hosts, [seenAt({ listed: 3, own: 2, listedElsewhere: ["reseller.test"] })]);
});

test("when the bare host does not answer, the www host is asked, and its home page is the fallback", async () => {
  const { get, asked } = site({
    "https://maker.test/sitemap.xml": { status: 0 },
    "https://www.maker.test/sitemap.xml": urlset("https://www.maker.test/product/a"),
  });
  const { pages, hosts } = await discoverPages(["maker.test"], get);
  assert.deepEqual(pages, ["https://www.maker.test/product/a"]);
  assert.deepEqual(asked, ["https://maker.test/sitemap.xml", "https://www.maker.test/sitemap.xml"]);
  assert.deepEqual(hosts, [
    seenAt({ host: "www.maker.test", listed: 1, own: 1, requests: 2, silent: 1 }),
  ]);
  // A www host whose sitemap is an HTML page falls back to that host's home, not the bare one.
  const html = site({ "https://www.maker.test/sitemap.xml": home });
  assert.deepEqual((await discoverPages(["maker.test"], html.get)).pages, [
    "https://www.maker.test/",
  ]);
});

test("a sitemap that answers with no page on the maker's hosts falls back to the home page", async () => {
  // The HTML home page served at /sitemap.xml, as progressivedyn.com and southwire.com do.
  const page = site({ "https://maker.test/sitemap.xml": home });
  const served = await discoverPages(["maker.test"], page.get);
  assert.deepEqual(served.pages, ["https://maker.test/"]);
  assert.deepEqual(served.hosts, [seenAt({ sitemap: "html" })]);
  // Every location on a host the record does not claim, as pulsetech.net listing pulsetech.com.
  const moved = site({
    "https://maker.test/sitemap.xml": urlset("https://maker.example/a", "https://maker.example/b"),
  });
  const listed = await discoverPages(["maker.test"], moved.get);
  assert.deepEqual(listed.pages, ["https://maker.test/"]);
  assert.deepEqual(listed.hosts, [
    seenAt({ listed: 2, own: 0, listedElsewhere: ["maker.example"] }),
  ]);
});

test("a host that never answers gets both its home pages tried, and every refusal is counted", async () => {
  const none = site({
    "https://maker.test/sitemap.xml": { status: 0 },
    "https://www.maker.test/sitemap.xml": { status: 0 },
  });
  const silent = await discoverPages(["maker.test"], none.get);
  assert.deepEqual(silent.pages, ["https://maker.test/", "https://www.maker.test/"]);
  assert.deepEqual(silent.hosts, [
    seenAt({ host: "www.maker.test", status: 0, sitemap: "none", requests: 2, silent: 2 }),
  ]);
  const refusing = site({
    "https://maker.test/sitemap.xml": { status: 403 },
    "https://www.maker.test/sitemap.xml": { status: 403 },
  });
  const refused = await discoverPages(["maker.test"], refusing.get);
  assert.deepEqual(refused.hosts, [
    seenAt({ host: "www.maker.test", status: 403, sitemap: "none", requests: 2, refused: 2 }),
  ]);
  const www = site({});
  assert.deepEqual((await discoverPages(["www.maker.test"], www.get)).pages, [
    "https://www.maker.test/",
  ]);
  assert.deepEqual(www.asked, ["https://www.maker.test/sitemap.xml"]);
  // A subdomain is a site of its own; `www.` in front of it is nobody's name.
  const sub = site({});
  assert.deepEqual((await discoverPages(["power.maker.test"], sub.get)).pages, [
    "https://power.maker.test/",
  ]);
  assert.deepEqual(sub.asked, ["https://power.maker.test/sitemap.xml"]);
  assert.deepEqual(hostsToTry("maker.test"), ["maker.test", "www.maker.test"]);
  // An apex under a public second level is still an apex; a real subdomain is not.
  assert.deepEqual(hostsToTry("maker.co.uk"), ["maker.co.uk", "www.maker.co.uk"]);
  assert.deepEqual(hostsToTry("maker.com.au"), ["maker.com.au", "www.maker.com.au"]);
  assert.deepEqual(hostsToTry("power.maker.test"), ["power.maker.test"]);
  assert.deepEqual(hostsToTry("www.maker.test"), ["www.maker.test"]);
});

test("a sitemap request that lands on a host the record does not claim says where it went", async () => {
  // kohlerenergy.com answers every request with a redirect to www.rehlko.com.
  const { get } = site({
    "https://maker.test/sitemap.xml": {
      url: "https://www.newname.test/sitemap.xml",
      text: urlset("https://www.newname.test/a"),
    },
  });
  const { pages, hosts } = await discoverPages(["maker.test"], get);
  assert.deepEqual(
    pages,
    ["https://maker.test/"],
    "nothing it lists is the maker's, so the home page",
  );
  assert.deepEqual(hosts, [
    seenAt({
      listed: 1,
      own: 0,
      redirectedTo: ["www.newname.test"],
      rootRedirectedTo: ["www.newname.test"],
      listedElsewhere: ["www.newname.test"],
    }),
  ]);
});

test("an index is opened up to its cap, a child that fails is counted, and CDATA locations count", async () => {
  const children = Array.from(
    { length: MAX_CHILD_SITEMAPS + 2 },
    (_, i) => `https://maker.test/sitemap-${i}.xml`,
  );
  const answers: Record<string, Answer> = {
    "https://maker.test/sitemap.xml": index(...children),
    "https://maker.test/sitemap-0.xml": `<urlset><url><loc><![CDATA[https://maker.test/product/cdata]]></loc></url></urlset>`,
    "https://maker.test/sitemap-1.xml": { status: 403 },
  };
  for (let i = 2; i < children.length; i += 1)
    answers[children[i]] = urlset(`https://maker.test/page-${i}`);
  const { get, asked } = site(answers);
  const { pages, hosts } = await discoverPages(["maker.test"], get);
  assert.ok(pages.includes("https://maker.test/product/cdata"));
  assert.ok(pages.includes(`https://maker.test/page-${MAX_CHILD_SITEMAPS - 1}`));
  assert.ok(!pages.includes(`https://maker.test/page-${MAX_CHILD_SITEMAPS}`));
  assert.ok(asked.includes("https://maker.test/sitemap-1.xml"));
  assert.ok(!pages.includes("https://maker.test/"));
  assert.deepEqual(hosts, [
    seenAt({
      sitemap: "index",
      listed: MAX_CHILD_SITEMAPS - 1,
      own: MAX_CHILD_SITEMAPS - 1,
      requests: 1 + MAX_CHILD_SITEMAPS,
      refused: 1,
      childrenFailed: 1,
      childrenSkipped: 2,
    }),
  ]);
});

test("a child that answers with a page instead of a sitemap is a child that could not be read", async () => {
  const { get } = site({
    "https://maker.test/sitemap.xml": index(
      "https://maker.test/a-sitemap.xml",
      "https://maker.test/b-sitemap.xml",
      "https://maker.test/nested-index.xml",
    ),
    "https://maker.test/a-sitemap.xml": urlset("https://maker.test/product/a"),
    // A consent page or a bot challenge, served with a 200.
    "https://maker.test/b-sitemap.xml": home,
    // An index inside the index: its two sitemaps are not pages, and are not opened.
    "https://maker.test/nested-index.xml": index(
      "https://maker.test/deep-1.xml",
      "https://maker.test/deep-2.xml",
    ),
  });
  const { pages, hosts } = await discoverPages(["maker.test"], get);
  assert.deepEqual(pages, ["https://maker.test/product/a"]);
  assert.deepEqual([hosts[0]?.childrenFailed, hosts[0]?.childrenSkipped], [1, 2]);
});

test("an index's child on a host the record does not claim is never opened, and one that moves there is reported", async () => {
  const { get, asked } = site({
    "https://maker.test/sitemap.xml": index(
      "https://cdn.other.test/maker-sitemap.xml",
      "https://maker.test/product-sitemap.xml",
      "https://maker.test/moved-sitemap.xml",
    ),
    "https://cdn.other.test/maker-sitemap.xml": urlset("https://maker.test/leaked"),
    "https://maker.test/product-sitemap.xml": urlset("https://maker.test/product/a"),
    "https://maker.test/moved-sitemap.xml": {
      url: "https://www.newname.test/sitemap.xml",
      text: urlset("https://www.newname.test/b"),
    },
  });
  const { pages, hosts } = await discoverPages(["maker.test"], get);
  assert.deepEqual(pages, ["https://maker.test/product/a"]);
  assert.ok(!asked.includes("https://cdn.other.test/maker-sitemap.xml"));
  assert.deepEqual(hosts[0]?.redirectedTo, ["www.newname.test"]);
  assert.deepEqual(hosts[0]?.rootRedirectedTo, [], "a child that moved is not the site moving");
  assert.deepEqual([hosts[0]?.requests, hosts[0]?.listed, hosts[0]?.own], [3, 2, 1]);
  assert.equal(
    hosts[0]?.childrenSkipped,
    1,
    "the child on another host is a sitemap left unopened",
  );
});

test("two domains are read one after the other, and a page listed by both is one page", async () => {
  const { get } = site({
    "https://maker.test/sitemap.xml": urlset("https://maker.test/a", "https://files.maker.test/b"),
    "https://files.maker.test/sitemap.xml": urlset("https://files.maker.test/b"),
  });
  const { pages, hosts } = await discoverPages(["maker.test", "files.maker.test"], get);
  assert.deepEqual(pages, ["https://maker.test/a", "https://files.maker.test/b"]);
  assert.deepEqual(
    hosts.map((h) => h.domain),
    ["maker.test", "files.maker.test"],
  );
});

test("pages give their own document links with the page they were on, and the rest once each by host", async () => {
  const { get } = site({
    "https://maker.test/product/a": `<a href="/files/a.pdf">datasheet</a><a href="https://cdn.shop.test/s/files/1/a-manual.pdf">manual</a><a href="https://cdn.shop.test/s/files/1/a-cert.pdf">cert</a>`,
    "https://maker.test/product/b": `<a href="https://maker.test/files/a.pdf">same datasheet</a><a href="https://cdn.shop.test/s/files/1/a-manual.pdf">manual again</a>`,
  });
  const read = await readPages(
    ["https://maker.test/product/a", "https://maker.test/product/b"],
    ["maker.test"],
    get,
  );
  assert.deepEqual(read.links, [
    {
      url: "https://maker.test/files/a.pdf",
      host: "maker.test",
      foundOn: "https://maker.test/product/a",
    },
    {
      url: "https://maker.test/files/a.pdf",
      host: "maker.test",
      foundOn: "https://maker.test/product/b",
    },
  ]);
  assert.deepEqual(
    [read.read, read.failed, read.foreign, read.redirectedTo],
    [
      2,
      {},
      {
        "cdn.shop.test": [
          "https://cdn.shop.test/s/files/1/a-cert.pdf",
          "https://cdn.shop.test/s/files/1/a-manual.pdf",
        ],
      },
      [],
    ],
  );
});

test("a page that will not load is counted by what it answered, and costs nothing else", async () => {
  const { get } = site({
    "https://maker.test/a": { status: 403 },
    "https://maker.test/b": { status: 0 },
    "https://maker.test/c": { status: 403 },
    "https://maker.test/d": `<a href="/d.pdf">d</a>`,
  });
  const read = await readPages(
    [
      "https://maker.test/a",
      "https://maker.test/b",
      "https://maker.test/c",
      "https://maker.test/d",
    ],
    ["maker.test"],
    get,
  );
  assert.equal(read.read, 1);
  assert.deepEqual(read.failed, { "403": 2, "0": 1 });
  assert.deepEqual(
    read.links.map((f) => f.url),
    ["https://maker.test/d.pdf"],
  );
});

test("a page that answers with a document is offered as that document, and its body is never parsed", async () => {
  const { get } = site({
    // A cited page that redirects to a PDF with no suffix in its address.
    "https://maker.test/sell-sheets/vue3": {
      url: "https://cdn.other.test/files/vue3",
      contentType: "application/pdf",
      text: '%PDF-1.7 <a href="/not/a/link.pdf">',
    },
    "https://maker.test/manual": { url: "https://maker.test/files/manual.pdf" },
    "https://maker.test/page": {
      contentType: "text/html; charset=utf-8",
      text: `<a href="/a.pdf">a</a>`,
    },
    // A download route with no suffix, answering a spreadsheet as text.
    "https://maker.test/export?id=manual": { contentType: "text/csv", text: "a,b\\n1,2" },
    // A file the host sends to be saved, whatever it calls it.
    "https://maker.test/save": { contentType: "text/html", attachment: true, text: "<p>x</p>" },
    // An image at a page-looking address is neither a page nor a document.
    "https://maker.test/logo": { contentType: "image/png", text: "PNG" },
  });
  const read = await readPages(
    [
      "https://maker.test/sell-sheets/vue3",
      "https://maker.test/manual",
      "https://maker.test/page",
      "https://maker.test/export?id=manual",
      "https://maker.test/save",
      "https://maker.test/logo",
    ],
    ["maker.test"],
    get,
  );
  assert.deepEqual(read.links, [
    {
      url: "https://maker.test/files/manual.pdf",
      host: "maker.test",
      foundOn: "https://maker.test/manual",
    },
    { url: "https://maker.test/a.pdf", host: "maker.test", foundOn: "https://maker.test/page" },
    {
      url: "https://maker.test/export?id=manual",
      host: "maker.test",
      foundOn: "https://maker.test/export?id=manual",
    },
    { url: "https://maker.test/save", host: "maker.test", foundOn: "https://maker.test/save" },
  ]);
  assert.deepEqual(read.foreign, { "cdn.other.test": ["https://cdn.other.test/files/vue3"] });
  assert.deepEqual([read.read, read.opened], [1, ["https://maker.test/page"]]);
  assert.deepEqual(
    read.answered,
    [
      "https://maker.test/sell-sheets/vue3",
      "https://maker.test/manual",
      "https://maker.test/export?id=manual",
      "https://maker.test/save",
    ],
    "the pages that answered with a document themselves, wherever the document was",
  );
  assert.deepEqual(read.failed, { "not a page (image/png)": 1 });
  assert.equal(
    isDocumentAnswer({
      status: 200,
      url: "https://maker.test/x",
      text: "",
      contentType: "image/png",
    }),
    false,
  );
  assert.equal(
    isDocumentAnswer({
      status: 200,
      url: "https://maker.test/x",
      text: "",
      contentType: "text/plain",
    }),
    true,
  );
  assert.equal(isPage({ status: 200, url: "https://maker.test/x", text: "" }), true);
  assert.equal(
    isPage({ status: 200, url: "https://maker.test/x", text: "", contentType: "application/xml" }),
    true,
  );
  assert.equal(
    isPage({ status: 200, url: "https://maker.test/x", text: "", contentType: "application/zip" }),
    false,
  );
});

test("a page that lands on another site is a site that moved, and its links belong to where it landed", async () => {
  const { get } = site({
    "https://maker.test/": {
      url: "https://www.newname.test/",
      text: `<a href="/support/manual.pdf">manual</a>`,
    },
  });
  const read = await readPages(["https://maker.test/"], ["maker.test"], get);
  assert.deepEqual(read.redirectedTo, ["www.newname.test"]);
  assert.deepEqual(read.links, [], "a relative link resolves against the page's real address");
  assert.deepEqual(read.foreign, {
    "www.newname.test": ["https://www.newname.test/support/manual.pdf"],
  });
  assert.deepEqual(read.pages, [], "and its pages are the other site's, not a hop to follow");
  assert.deepEqual(read.landed, ["https://www.newname.test/"]);
});

test("a page's own links are the next hop; documents, assets and other sites are not", () => {
  const html = `
    <a href="/product-category/charge-controller/">category</a>
    <a href=/product/unquoted>unquoted</a>
    <a href="https://www.maker.test/product/xtra-n-g3/#specs">product</a>
    <a href="https://www.maker.test/product/xtra-n-g3/">same product</a>
    <a href="/wp-content/uploads/datasheet.pdf">a document</a>
    <a href="/logo.svg">an asset</a>
    <a href="/feed.xml">a feed</a>
    <a href="/site.webmanifest">a manifest</a>
    <base href="/catalog/">
    <a href="model-x">relative to the base</a>
    <a href="/fonts/brand.otf">a font</a>
    <a href="https://shop.other.test/maker">a reseller</a>
    <a href="mailto:sales@maker.test">mail</a>
    <a href="tel:+1">phone</a>`;
  assert.deepEqual(pageLinks(html, "https://www.maker.test/", ["maker.test"]), [
    "https://www.maker.test/product-category/charge-controller/",
    "https://www.maker.test/product/unquoted",
    "https://www.maker.test/product/xtra-n-g3/",
    "https://www.maker.test/catalog/model-x",
  ]);
});

test("a batch hands back at most a bounded frontier, so a link-heavy catalogue cannot sink the step", async () => {
  const many = Array.from(
    { length: MAX_LINKS_PER_BATCH + 50 },
    (_, i) => `<a href="/p/${i}">${i}</a>`,
  );
  const { get } = site({
    "https://maker.test/a": many.slice(0, 1200).join(""),
    // The product pages come last, after two thousand posts.
    "https://maker.test/b": `${many.slice(1000).join("")}<a href="/product/x">x</a><a href="/download/y">y</a>`,
  });
  const read = await readPages(
    ["https://maker.test/a", "https://maker.test/b"],
    ["maker.test"],
    get,
  );
  assert.equal(read.pages.length, MAX_LINKS_PER_BATCH);
  assert.equal(new Set(read.pages).size, MAX_LINKS_PER_BATCH, "and each link once");
  assert.deepEqual(read.pages.slice(0, 2), [
    "https://maker.test/product/x",
    "https://maker.test/download/y",
  ]);
  assert.equal(read.linksDropped, 52, "and says how many were left behind");
  assert.equal(read.read, 2, "the cap costs links, not pages");
});

test("the frontier is drawn on batch by batch, skipping what a page has since landed on", () => {
  const frontier = ["a", "b", "c", "d", "e", "f"];
  const landed = new Set(["b", "e"]);
  const first = nextHop(frontier, 0, landed, 2);
  assert.deepEqual(first, { slice: ["a", "c"], cursor: 3 });
  const second = nextHop(frontier, first.cursor, landed, 2);
  assert.deepEqual(
    second,
    { slice: ["d", "f"], cursor: 6 },
    "a skipped slot goes to the next candidate",
  );
  assert.deepEqual(nextHop(frontier, second.cursor, landed, 2), { slice: [], cursor: 6 });
  assert.deepEqual(nextHop(frontier, 0, new Set(frontier), 3), { slice: [], cursor: 6 });
  assert.deepEqual(nextHop(frontier, 0, landed, 0), { slice: [], cursor: 0 });
});

test("the frontier is bounded in bytes too, since generated addresses run long", async () => {
  const long = Array.from(
    { length: 600 },
    (_, i) => `<a href="/filter?${"x".repeat(1000)}&n=${i}">${i}</a>`,
  );
  const { get } = site({ "https://maker.test/a": long.join("") });
  const read = await readPages(["https://maker.test/a"], ["maker.test"], get);
  const bytes = read.pages.reduce((n, u) => n + u.length, 0);
  assert.ok(bytes <= MAX_FRONTIER_BYTES, `${bytes} bytes handed back`);
  assert.ok(read.pages.length < 600 && read.pages.length > 0);
  assert.equal(read.linksDropped, 600 - read.pages.length);
});

test("a candidate an earlier page in the batch landed on is not asked for again", async () => {
  const { get, asked } = site({
    "https://maker.test/a": { url: "https://maker.test/b", text: `<a href="/c">c</a>` },
    "https://maker.test/b": `<a href="/d">d</a>`,
  });
  const read = await readPages(
    ["https://maker.test/a", "https://maker.test/b"],
    ["maker.test"],
    get,
  );
  assert.deepEqual(asked, ["https://maker.test/a"]);
  assert.deepEqual([read.attempted, read.read, read.landed], [1, 1, ["https://maker.test/b"]]);
});

test("the whole result stays under the step cap, frontier first and foreign lists after", async () => {
  const links = Array.from(
    { length: 3000 },
    (_, i) => `<a href="/p/${"y".repeat(300)}/${i}">${i}</a>`,
  );
  const foreign = Array.from(
    { length: 900 },
    (_, i) => `<a href="https://cdn.other.test/${"z".repeat(500)}/${i}.pdf">${i}</a>`,
  );
  const { get } = site({ "https://maker.test/a": links.join("") + foreign.join("") });
  const read = await readPages(["https://maker.test/a"], ["maker.test"], get);
  assert.ok(
    JSON.stringify(read).length <= MAX_RESULT_BYTES,
    `${JSON.stringify(read).length} bytes`,
  );
  assert.ok(read.pages.length > 0, "the frontier is trimmed, not emptied");
  assert.equal(read.linksDropped, 3000 - read.pages.length);
  const kept = read.foreign["cdn.other.test"]?.length ?? 0;
  assert.equal(read.foreignDropped, 900 - kept, "foreign addresses cut are counted, not lost");
});

test("href text in a script, a comment or a data attribute is not a page to follow", () => {
  const html = `<a href="/product/real">real</a>
    <script>location.href="/js/fake"; var o = {href: "/js/other"};</script>
    <!-- <a href="/old/page">gone</a> -->
    <div data-href="/data/attr">not a link</div>`;
  assert.deepEqual(pageLinks(html, "https://www.maker.test/", ["maker.test"]), [
    "https://www.maker.test/product/real",
  ]);
});

test("links are followed product and download pages first, in the order they were found", () => {
  const found = [
    "https://maker.test/blog/summer-sale",
    "https://maker.test/support/downloads/",
    "https://maker.test/about",
    "https://maker.test/product/xtra-n-g3/",
    "https://products.maker.test/careers",
    "not a url",
  ];
  assert.deepEqual(hopOrder(found), [
    "https://maker.test/support/downloads/",
    "https://maker.test/product/xtra-n-g3/",
    "https://maker.test/blog/summer-sale",
    "https://maker.test/about",
    "https://products.maker.test/careers",
    "not a url",
  ]);
  assert.deepEqual(hopOrder([]), []);
});

test("a document on a host the record names is the maker's when its own page links it, and not otherwise", async () => {
  const { get } = site({
    // A download link on the maker's site that lands on its CDN is the maker's document.
    "https://maker.test/manual": { url: "https://cdn.shop.test/s/files/1/direct.pdf" },
    // A CDN address with nothing in it to say what it is: handed back as a probe.
    "https://maker.test/product/b": `<a href="https://cdn.shop.test/download?id=manual">manual</a><a href="https://cdn.shop.test/download?id=manual">again</a>`,
    "https://cdn.shop.test/download?id=manual": { contentType: "application/pdf" },
    "https://cdn.shop.test/download?id=page": { contentType: "text/html", text: "<p>x</p>" },
    "https://maker.test/product/a": `<a href="https://cdn.shop.test/s/files/1/a-manual.pdf">manual</a><a href="https://other-cdn.test/x.pdf">elsewhere</a>`,
    "https://maker.test/moved": {
      url: "https://www.newname.test/moved",
      text: `<a href="https://cdn.shop.test/s/files/1/b-manual.pdf">manual</a><a href="https://maker.test/own.pdf">own</a>`,
    },
  });
  const read = await readPages(
    ["https://maker.test/manual", "https://maker.test/product/a", "https://maker.test/moved"],
    ["maker.test"],
    get,
    ["cdn.shop.test"],
  );
  assert.deepEqual(read.links, [
    {
      url: "https://cdn.shop.test/s/files/1/direct.pdf",
      host: "cdn.shop.test",
      foundOn: "https://maker.test/manual",
    },
    {
      url: "https://cdn.shop.test/s/files/1/a-manual.pdf",
      host: "cdn.shop.test",
      foundOn: "https://maker.test/product/a",
    },
    {
      url: "https://maker.test/own.pdf",
      host: "maker.test",
      foundOn: "https://www.newname.test/moved",
    },
  ]);
  assert.deepEqual(
    read.foreign,
    {
      "other-cdn.test": ["https://other-cdn.test/x.pdf"],
      "cdn.shop.test": ["https://cdn.shop.test/s/files/1/b-manual.pdf"],
    },
    "a page that landed elsewhere vouches for nothing on the document host",
  );
  const probed = await readPages(["https://maker.test/product/b"], ["maker.test"], get, [
    "cdn.shop.test",
  ]);
  assert.deepEqual(probed.probes, ["https://cdn.shop.test/download?id=manual"]);
  const answered = await readPages(
    ["https://cdn.shop.test/download?id=manual", "https://cdn.shop.test/download?id=page"],
    ["maker.test"],
    get,
    ["cdn.shop.test"],
  );
  assert.deepEqual(answered.links, [
    {
      url: "https://cdn.shop.test/download?id=manual",
      host: "cdn.shop.test",
      foundOn: "https://cdn.shop.test/download?id=manual",
    },
  ]);
  assert.deepEqual(answered.failed, { "a probe answered a page (text/html)": 1 });
  assert.deepEqual(
    [answered.redirectedTo, answered.read],
    [[], 0],
    "a probe is not a page read, nor a move",
  );
  const unnamed = await readPages(["https://maker.test/product/b"], ["maker.test"], get);
  assert.deepEqual(unnamed.probes, [], "with no document host named there is nothing to probe");
  const without = await readPages(["https://maker.test/product/a"], ["maker.test"], get);
  assert.deepEqual(without.links, [], "with no document host named, the CDN is still reported");
  assert.deepEqual(without.foreign, {
    "cdn.shop.test": ["https://cdn.shop.test/s/files/1/a-manual.pdf"],
    "other-cdn.test": ["https://other-cdn.test/x.pdf"],
  });
});

test("a record's document hosts count only for a run over the record's own domains", () => {
  const record = { domains: ["maker.test", "files.maker.test"], documentHosts: ["cdn.shop.test"] };
  assert.deepEqual(trustedDocumentHosts(record, ["maker.test", "files.maker.test"]), [
    "cdn.shop.test",
  ]);
  assert.deepEqual(trustedDocumentHosts(record, ["maker.test"]), ["cdn.shop.test"]);
  assert.deepEqual(
    trustedDocumentHosts(record, ["reseller.test"]),
    [],
    "a caller's own domains cannot vouch for the maker's CDN",
  );
  assert.deepEqual(trustedDocumentHosts(record, ["maker.test", "reseller.test"]), []);
  assert.deepEqual(trustedDocumentHosts({ domains: ["maker.test"] }, ["maker.test"]), []);
  assert.deepEqual(trustedDocumentHosts(undefined, ["maker.test"]), []);
});

test("cited pages are read first and the sitemap's fill what is left of the budget", () => {
  const cited = {
    documents: [],
    pages: [
      "https://maker.test/product/x",
      "https://maker.test/product/x",
      "https://other.test/maker",
      "https://maker.test/download",
    ],
  };
  const discovered = [
    "https://maker.test/a",
    "https://maker.test/product/x",
    "https://maker.test/b",
  ];
  const pick = (urls: string[], limit: number) => urls.slice(0, limit);
  assert.deepEqual(seedPages(cited, discovered, ["maker.test"], 3, pick), [
    "https://maker.test/product/x",
    "https://maker.test/download",
    "https://maker.test/a",
  ]);
  assert.deepEqual(
    seedPages(cited, discovered, ["maker.test"], 1, pick),
    ["https://maker.test/product/x"],
    "a budget smaller than the citations takes the first of them and nothing else",
  );
  // With the real sampler, whose zero means no cap: a budget the citations use up reads them alone.
  assert.deepEqual(seedPages(cited, discovered, ["maker.test"], 2, sample), [
    "https://maker.test/product/x",
    "https://maker.test/download",
  ]);
  assert.deepEqual(seedPages(cited, discovered, ["maker.test"], 0, sample), []);
  assert.deepEqual(
    seedPages({ documents: [], pages: [] }, discovered, ["maker.test"], 2, pick),
    ["https://maker.test/a", "https://maker.test/product/x"],
    "no citations is the sitemap sample as before",
  );
});

test("cited documents are offered after what the site gave, once each, and only on the maker's hosts", () => {
  const found = [
    { url: "https://maker.test/files/a.pdf", host: "maker.test", foundOn: "https://maker.test/p" },
  ];
  const cited = {
    documents: [
      "https://maker.test/files/a.pdf",
      "https://maker.test/files/b.pdf",
      "https://cdn.other.test/c.pdf",
    ],
    pages: [],
  };
  assert.deepEqual(withCited(found, cited, ["maker.test"]), [
    // Found on its page and cited by a record: both are true, and the approver sees both.
    {
      url: "https://maker.test/files/a.pdf",
      host: "maker.test",
      foundOn: "https://maker.test/p",
      cited: true,
    },
    { url: "https://maker.test/files/b.pdf", host: "maker.test", cited: true },
  ]);
  assert.deepEqual(withCited([], { documents: [], pages: [] }, ["maker.test"]), []);
  // A cited page that answered with the document: the document is the citation's.
  const answered = [
    {
      url: "https://maker.test/files/m.pdf",
      host: "maker.test",
      foundOn: "https://maker.test/manual",
    },
  ];
  const citedPages = { documents: [], pages: ["https://maker.test/manual"] };
  assert.deepEqual(
    withCited(answered, citedPages, ["maker.test"], new Set(["https://maker.test/manual"])),
    [{ ...answered[0], cited: true }],
  );
  // The same link found on the cited page when it answered with HTML is the page's find.
  assert.deepEqual(withCited(answered, citedPages, ["maker.test"], new Set()), answered);
});

test("pages read give their links once each, never themselves, and a page that failed gives none", async () => {
  const { get } = site({
    "https://maker.test/a": `<a href="/product/x">x</a><a href="/product/y">y</a><a href="/a">self</a>`,
    // Asked for without the slash, answered with it, and linking its canonical self.
    "https://maker.test/b": {
      url: "https://maker.test/b/",
      text: `<a href="/product/y">y again</a><a href="/blog">blog</a><a href="/b/">canonical</a>`,
    },
    "https://maker.test/c": { status: 403, text: `<a href="/product/z">hidden</a>` },
  });
  const read = await readPages(
    ["https://maker.test/a", "https://maker.test/b", "https://maker.test/c"],
    ["maker.test"],
    get,
  );
  assert.deepEqual(read.pages, [
    "https://maker.test/product/x",
    "https://maker.test/product/y",
    "https://maker.test/blog",
  ]);
  assert.deepEqual(read.landed, ["https://maker.test/a", "https://maker.test/b/"]);
});

test("a sitemap served as plain text is read, while a plain-text download is not", async (t) => {
  const answers: Record<string, [string, string]> = {
    "https://maker.test/sitemap.xml": ["text/plain", urlset("https://maker.test/a")],
    "https://maker.test/export?id=manual": ["text/plain", "a,b\n1,2"],
    "https://maker.test/page": ["text/html", "<p>hi</p>"],
  };
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const [type, body] = answers[url] ?? ["text/plain", ""];
    return new Response(body, { status: 200, headers: { "content-type": type } });
  });
  assert.match((await fetchPage("https://maker.test/sitemap.xml")).text, /<urlset>/);
  assert.equal((await fetchPage("https://maker.test/export?id=manual")).text, "");
  assert.equal((await fetchPage("https://maker.test/page")).text, "<p>hi</p>");
});

test("a page's own document links are cut last, and counted, when a batch would not fit the step", async () => {
  const docs = Array.from(
    { length: 6000 },
    (_, i) => `<a href="/files/${"d".repeat(120)}/${i}.pdf">${i}</a>`,
  );
  const { get } = site({ "https://maker.test/a": docs.join("") });
  const read = await readPages(["https://maker.test/a"], ["maker.test"], get);
  assert.ok(JSON.stringify(read).length <= MAX_RESULT_BYTES);
  assert.ok(read.links.length > 0 && read.links.length < 6000);
  assert.equal(read.documentsDropped, 6000 - read.links.length);
});

test("a listed page an earlier batch landed on is not asked for again", async () => {
  const { get, asked } = site({ "https://maker.test/b": `<a href="/c">c</a>` });
  const read = await readPages(
    ["https://maker.test/b"],
    ["maker.test"],
    get,
    new Set(["https://maker.test/b"]),
  );
  assert.deepEqual(asked, []);
  assert.deepEqual([read.attempted, read.read], [0, 0]);
});

test("only anchors and areas navigate; a head link or an href inside another attribute does not", () => {
  const html = `<link rel="alternate" type="application/rss+xml" href="/feed/">
    <a href="/product/real">real</a>
    <area href="/product/area" shape="rect">
    <img alt="see href=/not/a/link" src="/x.png">`;
  assert.deepEqual(pageLinks(html, "https://www.maker.test/", ["maker.test"]), [
    "https://www.maker.test/product/real",
    "https://www.maker.test/product/area",
  ]);
});

test("a page is read up to a bound, and what a typeless endpoint sends beyond it is left unread", async (t) => {
  const huge = "x".repeat(MAX_PAGE_BYTES + 100_000);
  let cancelled = false;
  t.mock.method(globalThis, "fetch", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const bytes = new TextEncoder().encode(huge);
        for (let i = 0; i < bytes.length; i += 65536)
          controller.enqueue(bytes.subarray(i, i + 65536));
        controller.close();
      },
      cancel() {
        cancelled = true;
      },
    });
    // No content type at all, as some download endpoints answer.
    return new Response(stream, { status: 200 });
  });
  const answer = await fetchPage("https://maker.test/download?id=1");
  assert.equal(answer.text.length, MAX_PAGE_BYTES);
  assert.equal(answer.truncated, true);
  assert.equal(cancelled, true, "the rest of the body is cancelled, not drained");
});

test("a result over the cap keeps shrinking its foreign lists until it fits", async () => {
  const hosts = Array.from({ length: 300 }, (_, h) =>
    Array.from(
      { length: 20 },
      (_, i) => `<a href="https://cdn-${h}.other.test/${"z".repeat(300)}/${i}.pdf">${i}</a>`,
    ).join(""),
  );
  const { get } = site({ "https://maker.test/a": hosts.join("") });
  const read = await readPages(["https://maker.test/a"], ["maker.test"], get);
  assert.ok(new TextEncoder().encode(JSON.stringify(read)).length <= MAX_RESULT_BYTES);
  assert.ok(read.foreignDropped > 0);
});
