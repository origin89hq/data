/**
 * The front page of the dataset.
 *
 * Served to a browser; a client asking for JSON gets the index instead. It is one file with no
 * build step because it is the Worker's own response, and everything it shows it fetches from the
 * same endpoints anybody else would use: the index for the tables, `manufacturers.csv` for the
 * makers, and DuckDB reading the Parquet over HTTP ranges for the query console. Nothing here is
 * a copy of the numbers, so the page cannot drift from what is published.
 */
export const PAGE = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>offgrid-equipment — open data for off-grid power</title>
<meta name="description" content="An open dataset of off-grid power equipment: manufacturers, models, rated figures and the protocols a controller can speak to them with. MIT licensed, Parquet, CSV and JSON.">
<meta property="og:title" content="offgrid-equipment">
<meta property="og:description" content="Open data for off-grid power equipment. Manufacturers, models, rated figures, protocols. MIT.">
<style>
:root {
  color-scheme: dark;
  --bg: #0b0d10;
  --panel: #12151a;
  --panel-2: #171b21;
  --line: #232830;
  --ink: #e8ecf1;
  --dim: #94a0ae;
  --dimmer: #6b7684;
  --accent: #57d08a;
  --accent-dim: #2f7d55;
  --warn: #e0b341;
  --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
  --sans: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Inter, sans-serif;
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--ink); font-family: var(--sans); line-height: 1.6; -webkit-font-smoothing: antialiased; }
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }
.wrap { max-width: 1080px; margin: 0 auto; padding: 0 24px; }
header { border-bottom: 1px solid var(--line); padding: 56px 0 40px; }
h1 { font-size: 15px; font-weight: 600; letter-spacing: .14em; text-transform: uppercase; color: var(--accent); margin: 0 0 18px; font-family: var(--mono); }
.lede { font-size: clamp(26px, 4.4vw, 40px); line-height: 1.22; margin: 0 0 18px; max-width: 20ch; font-weight: 600; letter-spacing: -.02em; }
.sub { font-size: 17px; color: var(--dim); max-width: 62ch; margin: 0 0 28px; }
.counts { display: flex; flex-wrap: wrap; gap: 32px; margin-top: 8px; }
.count b { display: block; font-family: var(--mono); font-size: 26px; font-weight: 600; letter-spacing: -.02em; }
.count span { font-size: 12px; color: var(--dimmer); text-transform: uppercase; letter-spacing: .1em; }
section { padding: 52px 0; border-bottom: 1px solid var(--line); }
h2 { font-size: 13px; font-weight: 600; letter-spacing: .14em; text-transform: uppercase; color: var(--dimmer); margin: 0 0 24px; font-family: var(--mono); }
h3 { font-size: 17px; margin: 0 0 8px; font-weight: 600; }
p { max-width: 68ch; color: var(--dim); }
p strong { color: var(--ink); font-weight: 600; }
code, pre { font-family: var(--mono); font-size: 13px; }
code.inline { background: var(--panel-2); padding: 2px 6px; border-radius: 4px; color: var(--ink); font-size: 12.5px; }
pre { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 16px 18px; overflow-x: auto; margin: 0; line-height: 1.65; }
pre .c { color: var(--dimmer); }
pre .k { color: var(--accent); }
pre .s { color: var(--warn); }
.brands { display: grid; grid-template-columns: repeat(auto-fill, minmax(112px, 1fr)); gap: 10px; }
.brand { background: #fff; border-radius: 10px; aspect-ratio: 1; display: flex; align-items: center; justify-content: center; padding: 14px; transition: transform .15s ease; }
.brand:hover { transform: translateY(-2px); }
.brand img { max-width: 100%; max-height: 100%; object-fit: contain; }
.brand-more { background: var(--panel); border: 1px dashed var(--line); color: var(--dimmer); font-family: var(--mono); font-size: 12px; text-align: center; }
table { border-collapse: collapse; width: 100%; font-size: 14px; }
th { text-align: left; font-weight: 500; color: var(--dimmer); font-size: 11px; text-transform: uppercase; letter-spacing: .1em; padding: 0 14px 10px 0; border-bottom: 1px solid var(--line); white-space: nowrap; }
td { padding: 9px 14px 9px 0; border-bottom: 1px solid var(--line); vertical-align: top; }
td.num { font-family: var(--mono); color: var(--ink); text-align: right; }
td.name { font-family: var(--mono); }
.scroll { overflow-x: auto; }
.two { display: grid; grid-template-columns: 1fr 1fr; gap: 28px; }
.card { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 22px 24px; }
.card.yes { border-left: 2px solid var(--accent); }
.card.no { border-left: 2px solid #c4603f; }
.card ul { margin: 12px 0 0; padding-left: 18px; color: var(--dim); font-size: 14.5px; }
.card li { margin-bottom: 7px; }
.tabs { display: flex; gap: 4px; margin-bottom: 14px; flex-wrap: wrap; }
.tab { background: none; border: 1px solid var(--line); color: var(--dim); padding: 6px 13px; border-radius: 7px; cursor: pointer; font-family: var(--mono); font-size: 12.5px; }
.tab[aria-selected="true"] { background: var(--panel-2); color: var(--ink); border-color: var(--accent-dim); }
.console textarea { width: 100%; min-height: 108px; background: var(--panel); color: var(--ink); border: 1px solid var(--line); border-radius: 10px; padding: 14px 16px; font-family: var(--mono); font-size: 13px; resize: vertical; line-height: 1.6; }
.console textarea:focus { outline: none; border-color: var(--accent-dim); }
.row { display: flex; gap: 10px; align-items: center; margin: 12px 0; flex-wrap: wrap; }
button.go { background: var(--accent); color: #06210f; border: 0; padding: 9px 20px; border-radius: 8px; font-weight: 600; cursor: pointer; font-size: 14px; }
button.go:disabled { opacity: .45; cursor: default; }
.status { color: var(--dimmer); font-size: 13px; font-family: var(--mono); }
.status.err { color: #e07a5f; }
.examples { display: flex; gap: 6px; flex-wrap: wrap; }
.examples button { background: var(--panel-2); border: 1px solid var(--line); color: var(--dim); padding: 5px 11px; border-radius: 6px; cursor: pointer; font-size: 12px; font-family: var(--mono); }
.examples button:hover { color: var(--ink); border-color: var(--accent-dim); }
.result { margin-top: 16px; max-height: 460px; overflow: auto; border: 1px solid var(--line); border-radius: 10px; }
.result table { font-size: 12.5px; font-family: var(--mono); }
.result th { padding: 10px 14px; background: var(--panel-2); position: sticky; top: 0; }
.result td { padding: 7px 14px; white-space: nowrap; }
footer { padding: 44px 0 72px; color: var(--dimmer); font-size: 13.5px; }
.note { border-left: 2px solid var(--warn); padding: 2px 0 2px 16px; color: var(--dim); font-size: 14.5px; margin: 22px 0 0; max-width: 68ch; }
@media (max-width: 720px) { .two { grid-template-columns: 1fr; } .counts { gap: 22px; } }
</style>
</head>
<body>
<header>
  <div class="wrap">
    <h1>offgrid-equipment</h1>
    <p class="lede">Open data for off-grid power equipment.</p>
    <p class="sub">Manufacturers, models, the figures their datasheets state, and the protocols a controller can actually speak to them with. Every figure names the document it came from and the page it was read off, so you can disagree with it.</p>
    <div class="counts" id="counts"></div>
  </div>
</header>

<section>
  <div class="wrap">
    <h2>Makers covered</h2>
    <div class="brands" id="brands"></div>
    <p class="note">A maker's mark is its trademark, not part of the MIT grant. They are served here to identify the maker. For any other use, ask the maker.</p>
  </div>
</section>

<section>
  <div class="wrap">
    <h2>What is in it</h2>
    <div class="scroll"><table id="tables"><thead><tr><th>Table</th><th>Rows</th><th>Parquet</th><th>CSV</th></tr></thead><tbody></tbody></table></div>
  </div>
</section>

<section>
  <div class="wrap">
    <h2>Query it here</h2>
    <p>DuckDB runs in this page and reads the Parquet straight off this domain over HTTP range requests. Nothing is uploaded, nothing is proxied, and the same query works on your machine.</p>
    <div class="console">
      <div class="examples" id="examples"></div>
      <div class="row"><textarea id="sql" spellcheck="false"></textarea></div>
      <div class="row">
        <button class="go" id="run" disabled>Run</button>
        <span class="status" id="status">loading DuckDB…</span>
      </div>
      <div class="result" id="result" hidden></div>
    </div>
  </div>
</section>

<section>
  <div class="wrap">
    <h2>Use it</h2>
    <div class="tabs" id="tabs"></div>
    <pre id="snippet"></pre>
  </div>
</section>

<section>
  <div class="wrap">
    <h2>Licence</h2>
    <p><strong>MIT</strong>, for the tooling and the records alike. Attribution is welcome and not required.</p>
    <div class="two" style="margin-top:22px">
      <div class="card yes">
        <h3>You can</h3>
        <ul>
          <li>Use it commercially, in a product you sell.</li>
          <li>Copy, modify and redistribute the tables.</li>
          <li>Build a competing dataset from it.</li>
          <li>Ship it inside a closed-source application.</li>
        </ul>
      </div>
      <div class="card no">
        <h3>You cannot</h3>
        <ul>
          <li>Treat the logos as MIT. They are trademarks, served to identify a maker.</li>
          <li>Hold anyone liable. There is no warranty, and equipment ratings matter.</li>
          <li>Assume a figure is right. Most were read by a model from a maker's PDF and nobody has confirmed them.</li>
          <li>Rely on it for safety sizing without checking the source document it names.</li>
        </ul>
      </div>
    </div>
    <p class="note">Two tiers sit in one table. <code class="inline">tier = 'reviewed'</code> is read from a maker's own document and carries its source and page. <code class="inline">tier = 'feed'</code> comes from a public dataset redistributed under its own licence. Filter on it.</p>
  </div>
</section>

<footer>
  <div class="wrap">
    <p style="color:var(--dimmer)">Built by <a href="https://origin89.com">Origin89</a> · <a href="https://github.com/origin89hq/offgrid-equipment">source on GitHub</a> · <a href="mailto:hello@origin89.com">hello@origin89.com</a><br>
    Corrections are the most useful contribution. Every figure names its document, so a wrong one can be shown wrong.</p>
  </div>
</footer>

<script type="module">
const BASE = location.origin;
const $ = (id) => document.getElementById(id);
const fmt = (n) => Number(n).toLocaleString("en-US");

const index = await fetch(BASE + "/", { headers: { accept: "application/json" } }).then((r) => r.json());

// Counts come from the manifest, so the page cannot claim a number the tables do not have.
const rowsOf = (t) => index.files?.[t + ".parquet"]?.rows ?? 0;
$("counts").innerHTML = [
  [rowsOf("specs"), "rated figures"],
  [rowsOf("models"), "models"],
  [index.counts?.dialects ?? rowsOf("dialects"), "protocols"],
  [rowsOf("sources"), "source documents"],
].map(([n, label]) => '<div class="count"><b>' + fmt(n) + "</b><span>" + label + "</span></div>").join("");

const tbody = $("tables").querySelector("tbody");
tbody.innerHTML = Object.keys(index.files ?? {})
  .filter((f) => f.endsWith(".parquet"))
  .sort((a, b) => index.files[b].rows - index.files[a].rows)
  .map((f) => {
    const name = f.replace(".parquet", "");
    const csv = index.files[name + ".csv"];
    return '<tr><td class="name">' + name + '</td><td class="num">' + fmt(index.files[f].rows) + "</td>" +
      '<td><a href="' + BASE + "/v1/" + f + '">' + (index.files[f].bytes / 1024).toFixed(0) + " KB</a></td>" +
      "<td>" + (csv ? '<a href="' + BASE + "/v1/" + name + '.csv">' + (csv.bytes / 1024).toFixed(0) + " KB</a>" : "—") + "</td></tr>";
  })
  .join("");

// The logo wall reads the published table rather than a list kept here.
try {
  const csv = await fetch(BASE + "/v1/manufacturers.csv").then((r) => r.text());
  const [head, ...lines] = csv.trim().split("\n");
  const cols = head.split(",");
  const at = { id: cols.indexOf("id"), name: cols.indexOf("name"), logo: cols.indexOf("logo") };
  const cell = (line) => {
    const out = []; let field = ""; let quoted = false;
    for (let i = 0; i < line.length; i += 1) {
      const c = line[i];
      if (quoted) { if (c === '"') { if (line[i + 1] === '"') { field += '"'; i += 1; } else quoted = false; } else field += c; continue; }
      if (c === '"') quoted = true; else if (c === ",") { out.push(field); field = ""; } else field += c;
    }
    out.push(field); return out;
  };
  const makers = lines.map(cell).filter((r) => r[at.logo]);
  $("brands").innerHTML = makers
    .map((r) => '<a class="brand" href="' + BASE + "/v1/manufacturers.csv" + '" title="' + r[at.name].replace(/"/g, "&quot;") + '"><img loading="lazy" alt="' + r[at.name].replace(/"/g, "&quot;") + '" src="' + r[at.logo] + '"></a>')
    .join("") + '<div class="brand brand-more">+' + (lines.length - makers.length) + "<br>no mark</div>";
} catch { $("brands").innerHTML = '<div class="brand brand-more">makers table unavailable</div>'; }

// ---- how to use it
const SNIPPETS = {
  duckdb: '<span class="c">-- Nothing to download. DuckDB reads the Parquet over HTTP.</span>\n' +
    '<span class="k">SELECT</span> m.name, s.name, s.value, s.unit\n' +
    '<span class="k">FROM</span> read_parquet(<span class="s">\'' + BASE + '/v1/specs.parquet\'</span>) s\n' +
    '<span class="k">JOIN</span> read_parquet(<span class="s">\'' + BASE + '/v1/models.parquet\'</span>) m <span class="k">ON</span> m.id = s.model_id\n' +
    '<span class="k">WHERE</span> s.tier = <span class="s">\'reviewed\'</span> <span class="k">AND</span> s.doubt <span class="k">IS NULL</span>\n' +
    '<span class="k">LIMIT</span> 20;',
  python: '<span class="c"># pip install duckdb</span>\n' +
    '<span class="k">import</span> duckdb\n\n' +
    'df = duckdb.sql(<span class="s">"""\n' +
    '  SELECT model_id, name, value, unit\n' +
    '  FROM read_parquet(\'' + BASE + '/v1/specs.parquet\')\n' +
    '  WHERE tier = \'reviewed\' AND unit = \'Ah\'\n' +
    '"""</span>).df()\n' +
    'print(df.head())',
  pandas: '<span class="c"># pip install pandas pyarrow</span>\n' +
    '<span class="k">import</span> pandas <span class="k">as</span> pd\n\n' +
    'specs = pd.read_parquet(<span class="s">"' + BASE + '/v1/specs.parquet"</span>)\n' +
    'makers = pd.read_parquet(<span class="s">"' + BASE + '/v1/manufacturers.parquet"</span>)\n\n' +
    '<span class="c"># Which makers state a charge-controller current?</span>\n' +
    'print(specs[specs.unit == <span class="s">"A"</span>].model_id.nunique())',
  curl: '<span class="c"># the index says what is published, with a hash for every file</span>\n' +
    'curl -s <span class="s">' + BASE + '/</span> | jq <span class="s">\'.files | keys\'</span>\n\n' +
    '<span class="c"># a table</span>\n' +
    'curl -O <span class="s">' + BASE + '/v1/specs.parquet</span>\n\n' +
    '<span class="c"># a maker\'s mark, at 64, 128 or 256</span>\n' +
    'curl -O <span class="s">' + BASE + '/logos/victron-energy-128.png</span>',
  js: '<span class="c">// The tables are plain HTTP with CORS open, so a browser can read them.</span>\n' +
    '<span class="k">const</span> index = <span class="k">await</span> fetch(<span class="s">"' + BASE + '/"</span>).then((r) => r.json());\n' +
    'console.log(index.files[<span class="s">"specs.parquet"</span>].rows);\n\n' +
    '<span class="c">// Or query it with duckdb-wasm, which is what this page does.</span>',
};
const tabs = $("tabs");
tabs.innerHTML = Object.keys(SNIPPETS).map((k, i) => '<button class="tab" role="tab" aria-selected="' + (i === 0) + '" data-k="' + k + '">' + k + "</button>").join("");
const showSnippet = (k) => {
  $("snippet").innerHTML = SNIPPETS[k];
  for (const b of tabs.children) b.setAttribute("aria-selected", String(b.dataset.k === k));
};
tabs.addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) showSnippet(b.dataset.k); });
showSnippet("duckdb");

// ---- the query console
const EXAMPLES = {
  "figures by unit": "SELECT unit, count(*) AS figures\nFROM specs\nWHERE tier = 'reviewed' AND unit IS NOT NULL\nGROUP BY 1 ORDER BY 2 DESC LIMIT 15;",
  "best covered models": "SELECT m.manufacturer_id, m.name, count(*) AS figures\nFROM specs s JOIN models m ON m.id = s.model_id\nWHERE s.tier = 'reviewed'\nGROUP BY 1, 2 ORDER BY 3 DESC LIMIT 15;",
  "battery capacities": "SELECT model_id, value, unit, name\nFROM specs\nWHERE unit = 'Ah' AND tier = 'reviewed'\nORDER BY try_cast(value AS DOUBLE) DESC NULLS LAST\nLIMIT 20;",
  "protocols and drivers": "SELECT family, driver_status, count(*) AS dialects\nFROM dialects\nGROUP BY 1, 2 ORDER BY 3 DESC LIMIT 15;",
  "makers with a logo": "SELECT id, name, logo_from, logo_widths\nFROM manufacturers WHERE logo IS NOT NULL\nORDER BY id LIMIT 20;",
};
$("examples").innerHTML = Object.keys(EXAMPLES).map((k) => '<button data-q="' + k + '">' + k + "</button>").join("");
$("sql").value = EXAMPLES["figures by unit"];
$("examples").addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  $("sql").value = EXAMPLES[b.dataset.q];
  $("run").click();
});

let conn;
const status = (text, bad) => { const s = $("status"); s.textContent = text; s.className = "status" + (bad ? " err" : ""); };

try {
  const duckdb = await import("https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@1.29.0/+esm");
  const bundle = await duckdb.selectBundle(duckdb.getJsDelivrBundles());
  const worker = await duckdb.createWorker(bundle.mainWorker);
  const db = new duckdb.AsyncDuckDB(new duckdb.ConsoleLogger(duckdb.LogLevel.WARNING), worker);
  await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
  conn = await db.connect();
  // Each table is a view onto the published file, so a query here is the query you would write
  // anywhere else, and the data is whatever is published right now.
  const tables = Object.keys(index.files ?? {}).filter((f) => f.endsWith(".parquet")).map((f) => f.replace(".parquet", ""));
  for (const t of tables) {
    await conn.query("CREATE VIEW " + t + " AS SELECT * FROM read_parquet('" + BASE + "/v1/" + t + ".parquet')");
  }
  status(tables.length + " tables ready");
  $("run").disabled = false;
} catch (error) {
  status("DuckDB did not load: " + String(error).slice(0, 90), true);
}

$("run").addEventListener("click", async () => {
  if (!conn) return;
  const sql = $("sql").value.trim();
  if (!sql) return;
  $("run").disabled = true;
  status("running…");
  const started = performance.now();
  try {
    const table = await conn.query(sql);
    const cols = table.schema.fields.map((f) => f.name);
    const rows = table.toArray().slice(0, 500);
    const escape = (v) => String(v ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
    $("result").innerHTML =
      "<table><thead><tr>" + cols.map((c) => "<th>" + escape(c) + "</th>").join("") + "</tr></thead><tbody>" +
      rows.map((r) => "<tr>" + cols.map((c) => "<td>" + escape(r[c]) + "</td>").join("") + "</tr>").join("") +
      "</tbody></table>";
    $("result").hidden = false;
    status(rows.length + (rows.length === 500 ? "+ rows" : " rows") + " in " + (performance.now() - started).toFixed(0) + " ms");
  } catch (error) {
    $("result").hidden = true;
    status(String(error).replace(/^Error: /, "").slice(0, 160), true);
  }
  $("run").disabled = false;
});
</script>
</body>
</html>`;
