import { type ReactNode, useState } from "react";
import { type Index, kb } from "./api.ts";
import { Icon } from "./icons.tsx";
import { tablistKeys } from "./tabs.ts";

/** Written against the live origin, so a reader can copy one and it runs. */
const snippets = (
  origin: string,
): Record<"sql" | "python" | "curl", { label: string; code: string }> => ({
  sql: {
    label: "DuckDB",
    code: `-- Nothing to download. DuckDB reads the Parquet over HTTP.
-- reviewed_by is set only where a person checked the figure against its document.
SELECT m.name AS model, s.name AS figure, s.value, s.unit, s.extracted_by, s.reviewed_by
FROM read_parquet('${origin}/v1/specs.parquet') s
JOIN read_parquet('${origin}/v1/models.parquet') m ON m.id = s.model_id
WHERE s.tier = 'record' AND s.doubt IS NULL
LIMIT 20;`,
  },
  python: {
    label: "Python",
    code: `# pip install duckdb
import duckdb

df = duckdb.sql("""
  SELECT model_id, name, value, unit
  FROM read_parquet('${origin}/v1/specs.parquet')
  WHERE tier = 'record' AND unit = 'Ah'
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

const KEYWORDS = new Set([
  "SELECT",
  "FROM",
  "JOIN",
  "ON",
  "WHERE",
  "GROUP",
  "BY",
  "ORDER",
  "LIMIT",
  "AND",
  "OR",
  "IS",
  "NULL",
  "AS",
  "import",
  "print",
  "curl",
  "def",
  "return",
]);

/**
 * The draft's own tokeniser, which is three rules and enough: a comment line, a quoted string, a
 * keyword. Anything more would be a highlighting library shipped to colour thirty lines.
 */
function colour(code: string): ReactNode[] {
  return code.split("\n").map((line, row) => {
    if (line.trimStart().startsWith("--") || line.trimStart().startsWith("#")) {
      return (
        // biome-ignore lint/suspicious/noArrayIndexKey: Syntax spans are stateless fragments indexed by position within the displayed source text.
        <span key={row} className="syntax-comment">
          {line}
          {"\n"}
        </span>
      );
    }
    // Split on quoted strings first, then on word boundaries inside what is left.
    const parts = line.split(/('[^']*')/g).map((part, i) =>
      part.startsWith("'") ? (
        // biome-ignore lint/suspicious/noArrayIndexKey: Syntax spans are stateless fragments indexed by position within the displayed source text.
        <span key={i} className="syntax-string">
          {part}
        </span>
      ) : (
        part.split(/(\b[A-Za-z_]+\b)/g).map((word, j) =>
          KEYWORDS.has(word) ? (
            // biome-ignore lint/suspicious/noArrayIndexKey: Syntax spans are stateless fragments indexed by position within the displayed source text.
            <span key={j} className="syntax-key">
              {word}
            </span>
          ) : (
            word
          ),
        )
      ),
    );
    return (
      // biome-ignore lint/suspicious/noArrayIndexKey: Syntax spans are stateless fragments indexed by position within the displayed source text.
      <span key={row}>
        {parts}
        {"\n"}
      </span>
    );
  });
}

type Language = keyof ReturnType<typeof snippets>;
const LANGUAGES: readonly Language[] = ["sql", "python", "curl"];

export function Build({ index }: { index?: Index }) {
  const origin =
    typeof window === "undefined" ? "https://data.origin89.com" : window.location.origin;
  const all = snippets(origin);
  const [tab, setTab] = useState<Language>("sql");
  const [copied, setCopied] = useState(false);

  const copy = () => {
    void navigator.clipboard.writeText(all[tab].code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    });
  };

  return (
    <>
      <section id="build" className="section">
        <div className="o89-wrap open-grid">
          <div className="open-copy">
            <p className="eyebrow">05 / Built to be built on</p>
            <h2 className="h-l">
              Your stack.
              <br />
              Your next idea.
            </h2>
            <p className="lede">
              Bring the dataset into a notebook, a product catalogue, or your next integration. Open
              files, stable joins, and the tools you already use.
            </p>
            <div className="format-tags">
              <span>Parquet</span>
              <span>CSV</span>
              <span>JSON catalogue</span>
            </div>
            <a
              className="o89-text-link"
              href="https://github.com/origin89hq/offgrid-equipment"
              target="_blank"
              rel="noopener"
            >
              Read the data dictionary <Icon name="arrowUpRight" />
            </a>
            <div className="dev-license">
              <span>MIT</span>
              <p>
                Tooling and authored records are open.
                <br />
                Public feeds retain their own licences.
              </p>
            </div>
          </div>
          <div className="artifacts">
            <article className="artifact code-panel">
              <header className="code-tabs">
                {/* The copy button stays outside the tablist: a tablist holds tabs only, and the
                    arrow keys here move between languages. */}
                <div
                  className="tabs"
                  role="tablist"
                  aria-label="Code language"
                  onKeyDown={tablistKeys(LANGUAGES, tab, setTab)}
                >
                  {LANGUAGES.map((key) => (
                    <button
                      type="button"
                      key={key}
                      id={`code-tab-${key}`}
                      role="tab"
                      aria-selected={tab === key}
                      aria-controls="code-panel"
                      tabIndex={tab === key ? 0 : -1}
                      onClick={() => setTab(key)}
                    >
                      {all[key].label}
                    </button>
                  ))}
                </div>
                <button type="button" className="copy-code" onClick={copy} aria-label="Copy code">
                  {copied ? "Copied" : "Copy"} <Icon name="copy" />
                </button>
              </header>
              {/* biome-ignore lint/a11y/noNoninteractiveTabindex: The ARIA tabs pattern asks for
                  tabindex="0" on a tab panel with no focusable children, and this one scrolls
                  sideways, so without it a keyboard cannot reach the end of a long line. */}
              <pre id="code-panel" role="tabpanel" aria-labelledby={`code-tab-${tab}`} tabIndex={0}>
                <code>{colour(all[tab].code)}</code>
              </pre>
              <div className="code-footer">
                <span className="little-dot" /> Public endpoints · no authentication required
              </div>
            </article>
            <article className="artifact download-row">
              <header>
                <span className="mono">take the data with you</span>
                <b>row counts and hashes in the index</b>
              </header>
              <div className="body">
                <a className="o89-plate o89-plate-ghost o89-plate-sm" href="/v1/models.parquet">
                  <Icon name="download" /> models.parquet
                  <span>
                    {index?.files["models.parquet"] ? kb(index.files["models.parquet"].bytes) : ""}
                  </span>
                </a>
                <a className="o89-plate o89-plate-ghost o89-plate-sm" href="/v1/specs.csv">
                  <Icon name="download" /> specs.csv
                  <span>{index?.files["specs.csv"] ? kb(index.files["specs.csv"].bytes) : ""}</span>
                </a>
                <a className="o89-text-link" href="/manifest.json" target="_blank" rel="noopener">
                  View the index <Icon name="arrowUpRight" />
                </a>
              </div>
            </article>
          </div>
        </div>
      </section>

      <section className="section closing">
        <div className="o89-wrap">
          <p className="eyebrow">Made for the people building off-grid</p>
          <h2 className="h-xl">
            Start with the equipment.
            <br />
            Build from what you know.
          </h2>
          <div className="hero-actions">
            <a className="o89-plate o89-plate-action" href="#explore">
              Explore the dataset <Icon name="arrowUpRight" />
            </a>
            <a
              className="o89-text-link"
              href="https://github.com/origin89hq/offgrid-equipment/blob/main/CONTRIBUTING.md"
              target="_blank"
              rel="noopener"
            >
              Contribute a correction <Icon name="arrowUpRight" />
            </a>
          </div>
        </div>
      </section>
    </>
  );
}
