import { useState } from "react";
import { kb, type Index } from "./api.ts";

/** Written against the live origin, so a reader can copy one and it runs. */
const snippets = (origin: string): Record<string, { label: string; code: string }> => ({
  sql: {
    label: "DuckDB",
    code: `-- Nothing to download. DuckDB reads the Parquet over HTTP.
SELECT m.name AS model, s.name AS figure, s.value, s.unit
FROM read_parquet('${origin}/v1/specs.parquet') s
JOIN read_parquet('${origin}/v1/models.parquet') m ON m.id = s.model_id
WHERE s.tier = 'reviewed' AND s.doubt IS NULL
LIMIT 20;`,
  },
  python: {
    label: "Python",
    code: `# pip install duckdb
import duckdb

df = duckdb.sql("""
  SELECT model_id, name, value, unit
  FROM read_parquet('${origin}/v1/specs.parquet')
  WHERE tier = 'reviewed' AND unit = 'Ah'
""").df()
print(df.head())`,
  },
  curl: {
    label: "cURL",
    code: `# the index says what is published, with a hash for every file
curl -s ${origin}/manifest.json | jq '.files | keys'

# a table
curl -O ${origin}/v1/specs.parquet

# a maker's mark, at 64, 128 or 256
curl -O ${origin}/logos/victron-energy-128.png`,
  },
});

export function Build({ index }: { index?: Index }) {
  const origin = typeof window === "undefined" ? "https://data.origin89.com" : window.location.origin;
  const all = snippets(origin);
  const [tab, setTab] = useState("sql");
  const [copied, setCopied] = useState(false);

  const copy = () => {
    void navigator.clipboard.writeText(all[tab]!.code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    });
  };

  return (
    <>
      <section id="build" className="section wrap">
        <div className="developer-grid">
          <div className="developer-story">
            <p className="eyebrow">05 / BUILT TO BE BUILT ON</p>
            <h2>Your stack.<br />Your next idea.</h2>
            <p>Bring the dataset into a notebook, a product catalogue, or your next integration. Open files, stable joins, and the tools you already use.</p>
            <div className="format-tags"><span>PARQUET</span><span>CSV</span><span>JSON CATALOGUE</span></div>
            <a className="text-link" href="https://github.com/origin89hq/offgrid-equipment" target="_blank" rel="noopener">
              Read the data dictionary <span>↗</span>
            </a>
            <div className="dev-license">
              <span>MIT</span>
              <p>Tooling and authored records are open.<br />Public feeds retain their own licences.</p>
            </div>
          </div>
          <div className="code-panel">
            <div className="code-tabs" role="tablist" aria-label="Code language">
              {Object.entries(all).map(([key, snippet]) => (
                <button
                  key={key}
                  role="tab"
                  aria-selected={tab === key}
                  tabIndex={tab === key ? 0 : -1}
                  onClick={() => setTab(key)}
                >
                  {snippet.label}
                </button>
              ))}
              <button className="copy-code" onClick={copy} aria-label="Copy code">
                {copied ? "Copied" : "Copy"} <span>⧉</span>
              </button>
            </div>
            <pre role="tabpanel"><code>{all[tab]!.code}</code></pre>
            <div className="code-footer"><span className="little-dot" /> Public endpoints · no authentication required</div>
          </div>
        </div>
        <div className="download-row">
          <div>
            <h3>Take the data with you.</h3>
            <p>Published files, with row counts and content hashes in the index.</p>
          </div>
          <a className="button small" href="/v1/models.parquet">
            models.parquet <span>↓ {index?.files["models.parquet"] ? kb(index.files["models.parquet"].bytes) : ""}</span>
          </a>
          <a className="button small" href="/v1/specs.csv">
            specs.csv <span>↓ {index?.files["specs.csv"] ? kb(index.files["specs.csv"].bytes) : ""}</span>
          </a>
          <a className="text-link" href="/manifest.json" target="_blank" rel="noopener">View the index <span>↗</span></a>
        </div>
      </section>

      <section className="closing wrap">
        <p className="eyebrow">MADE FOR THE PEOPLE BUILDING OFF-GRID.</p>
        <h2>Start with the equipment.<br />Build from what you know.</h2>
        <div className="hero-actions">
          <a className="button primary" href="#explore">Explore the dataset <span>↗</span></a>
          <a className="button quiet" href="https://github.com/origin89hq/offgrid-equipment/blob/main/CONTRIBUTING.md" target="_blank" rel="noopener">
            Contribute a correction <span>↗</span>
          </a>
        </div>
      </section>
    </>
  );
}
