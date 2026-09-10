import { useEffect, useMemo, useRef, useState } from "react";
import { count, type Index } from "./api.ts";
import { Icon } from "./icons.tsx";
import type { State } from "./useDuckDb.ts";

type Row = Record<string, unknown>;

/** What each tab asks the published tables, and which column its filter narrows. */
const TABLES = {
  models: {
    label: "Equipment",
    // Not the models table itself, but the models table with what is known about each one. The
    // first thing a visitor saw was an ABB part number with no figures, no source and no protocol,
    // because "ORDER BY id" puts the alphabet first and the alphabet starts at abb-1666001. That
    // reads as an empty database. Leading with the best documented shows what the dataset is for.
    table: `(SELECT m.id, m.name, m.manufacturer_id, m.kind,
                    count(DISTINCT s.id) AS figures,
                    count(DISTINCT s.source_id) AS documents,
                    count(DISTINCT d.dialect_id) AS protocols,
                    m.tier
             FROM models m
             LEFT JOIN specs s ON s.model_id = m.id AND s.tier = 'reviewed'
             LEFT JOIN model_dialects d ON d.model_id = m.id
             GROUP BY 1, 2, 3, 4, 8)`,
    columns: ["id", "name", "manufacturer_id", "kind", "figures", "documents", "protocols"],
    search: ["id", "name", "manufacturer_id"],
    filter: { column: "kind", label: "All equipment types" },
    order: "figures DESC, protocols DESC, documents DESC, id",
  },
  specs: {
    label: "Specifications",
    table: "specs",
    columns: ["model_id", "coalesce(english, name) AS figure", "value", "unit", "page", "doubt"],
    search: ["model_id", "name", "value"],
    filter: { column: "unit", label: "All units" },
    // A figure somebody can act on first: a number, with a unit, and a page to check it against.
    order: "CASE WHEN doubt IS NULL AND page IS NOT NULL THEN 0 ELSE 1 END, model_id",
  },
  dialects: {
    label: "Protocols",
    table: "dialects",
    columns: ["id", "family", "driver_status", "confidence"],
    search: ["id", "family"],
    filter: { column: "family", label: "All families" },
    order:
      "CASE confidence WHEN 'vendor-doc' THEN 0 WHEN 'community-crosschecked' THEN 1 ELSE 2 END, id",
  },
} as const;

type TabName = keyof typeof TABLES;

/** The name a column answers to, which for an expression is what it was aliased as. */
const alias = (column: string): string => column.split(/\s+AS\s+/i).pop() ?? column;

const PAGE = 12;

/**
 * The explorer, reading the published tables rather than a sample baked into the page.
 *
 * The draft shipped 38 models in a JavaScript file so it could be opened from disk. Here DuckDB
 * reads the Parquet over HTTP in the reader's own browser, so a search is over everything that is
 * published and the row somebody inspects is the row anybody else would get.
 */
export function Explorer({
  index,
  tier,
  db,
}: {
  index?: Index;
  tier: "reviewed" | "all";
  db: State;
}) {
  const [tab, setTab] = useState<TabName>("models");
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("");
  const [page, setPage] = useState(0);
  const [rows, setRows] = useState<Row[]>([]);
  const [total, setTotal] = useState(0);
  const [choices, setChoices] = useState<string[]>([]);
  const [chosen, setChosen] = useState<Row>();
  const spec = TABLES[tab];

  // The reviewed tier is this project's own work; the feeds bring their own labels and would bury it.
  const scope = useMemo(
    () => (tier === "reviewed" && tab !== "dialects" ? "tier = 'reviewed'" : "TRUE"),
    [tier, tab],
  );

  const where = useMemo(() => {
    const clauses = [scope];
    if (search.trim()) {
      const needle = search.trim().replaceAll("'", "''").toLowerCase();
      clauses.push(
        `(${spec.search.map((c) => `lower(coalesce(${c}, '')) LIKE '%${needle}%'`).join(" OR ")})`,
      );
    }
    if (filter) clauses.push(`${spec.filter.column} = '${filter.replaceAll("'", "''")}'`);
    return clauses.join(" AND ");
  }, [scope, search, filter, spec]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: Changing the selected table resets its page and filter.
  useEffect(() => {
    setPage(0);
    setFilter("");
  }, [tab]);

  useEffect(() => {
    if (!db.ready) return;
    void db
      .run(`SELECT DISTINCT ${spec.filter.column} AS value FROM ${spec.table}
            WHERE ${scope} AND ${spec.filter.column} IS NOT NULL ORDER BY 1 LIMIT 40`)
      .then((answer) => setChoices(answer.rows.map((row) => String(row.value))))
      .catch(() => setChoices([]));
  }, [db, scope, spec]);

  useEffect(() => {
    if (!db.ready) return;
    let stale = false;
    void Promise.all([
      db.run(`SELECT count(*) AS n FROM ${spec.table} WHERE ${where}`),
      db.run(`SELECT ${spec.columns.join(", ")} FROM ${spec.table} WHERE ${where}
              ORDER BY ${spec.order} LIMIT ${PAGE} OFFSET ${page * PAGE}`),
    ])
      .then(([counted, listed]) => {
        if (stale) return;
        setTotal(Number(counted.rows[0]?.n ?? 0));
        setRows(listed.rows);
      })
      .catch(() => {
        if (!stale) setRows([]);
      });
    return () => {
      stale = true;
    };
  }, [db, where, page, spec]);

  const pages = Math.max(1, Math.ceil(total / PAGE));
  return (
    <div className="explorer">
      <div className="explorer-top">
        <div className="table-tabs" role="tablist" aria-label="Dataset tables">
          {(Object.keys(TABLES) as TabName[]).map((name) => (
            <button
              type="button"
              key={name}
              role="tab"
              aria-selected={tab === name}
              tabIndex={tab === name ? 0 : -1}
              onClick={() => setTab(name)}
            >
              {TABLES[name].label} <span>{count(index?.files[`${name}.parquet`]?.rows ?? 0)}</span>
            </button>
          ))}
        </div>
        <span className="sample-label">
          {db.ready
            ? "LIVE FROM THE PUBLISHED TABLES"
            : db.error
              ? "DATA UNAVAILABLE"
              : "READING THE DATA"}
        </span>
      </div>
      <div className="explorer-tools">
        <label className="search-box">
          <Icon name="search" />
          <input
            type="search"
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              setPage(0);
            }}
            placeholder="Search equipment, makers, or model IDs…"
            aria-label="Search the published records"
          />
        </label>
        <label className="sr-only" htmlFor="filter">
          Narrow the records
        </label>
        <select
          id="filter"
          value={filter}
          onChange={(event) => {
            setFilter(event.target.value);
            setPage(0);
          }}
        >
          <option value="">{spec.filter.label}</option>
          {choices.map((choice) => (
            <option key={choice} value={choice}>
              {choice}
            </option>
          ))}
        </select>
      </div>
      <div role="tabpanel">
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                {spec.columns.map((column) => (
                  <th key={column}>{alias(column).replace(/_/g, " ")}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr
                  key={JSON.stringify(row)}
                  onClick={() => setChosen(row)}
                  style={{ cursor: "pointer" }}
                >
                  {spec.columns.map((column) => {
                    const value = row[alias(column)];
                    return (
                      <td key={column}>
                        {value === null || value === undefined || value === ""
                          ? "—"
                          : String(value)}
                      </td>
                    );
                  })}
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={spec.columns.length}>
                    {db.ready
                      ? "Nothing matches that."
                      : db.error
                        ? "The data couldn’t be loaded. Reload the page to try again, or download the files below."
                        : "Reading the tables…"}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
      <div className="explorer-bottom">
        <span role="status" aria-live="polite">
          {count(total)} records
        </span>
        <div className="pagination">
          <button
            type="button"
            onClick={() => setPage((p) => Math.max(0, p - 1))}
            disabled={page === 0}
            aria-label="Previous page"
          >
            <Icon name="arrowLeft" />
          </button>
          <span>
            {page + 1} / {count(pages)}
          </span>
          <button
            type="button"
            onClick={() => setPage((p) => Math.min(pages - 1, p + 1))}
            disabled={page + 1 >= pages}
            aria-label="Next page"
          >
            <Icon name="arrowRight" />
          </button>
        </div>
      </div>
      {chosen && (
        <RecordDialog row={chosen} table={tab} db={db} onClose={() => setChosen(undefined)} />
      )}
    </div>
  );
}

/**
 * One record, told as what the thing is rather than as the columns a table happens to have.
 *
 * It used to render every column as a row, so a model showed "figures 76 / documents 1 /
 * protocols 1" as though those were properties of the product. They are counts computed to order
 * the table by. What somebody opening a record wants is what it is, what it is rated at, and where
 * that came from.
 */
function RecordDialog({
  row,
  table,
  db,
  onClose,
}: {
  row: Row;
  table: TabName;
  db: State;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    if (element && !element.open) element.showModal();
  }, []);

  const text = (key: string) => {
    const value = row[key];
    return value === null || value === undefined || value === "" ? undefined : String(value);
  };
  // The counts exist to sort the table; they are not facts about the product.
  const BOOKKEEPING = new Set(["figures", "documents", "protocols", "tier"]);

  const heading =
    table === "specs" ? (text("figure") ?? text("name") ?? "Figure") : (text("id") ?? "Record");
  const under =
    table === "specs"
      ? text("model_id")
      : table === "models"
        ? text("manufacturer_id")
        : text("family");

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: The native dialog handles Escape; its close button is keyboard accessible. This handler closes only backdrop clicks.
    <dialog
      ref={dialog}
      aria-labelledby="detail-title"
      onClose={onClose}
      onClick={(event) => event.target === dialog.current && onClose()}
    >
      <div className="dialog-top">
        <span className="eyebrow">ORIGIN89 DATA / RECORD DETAIL</span>
        <button
          type="button"
          className="close-dialog"
          aria-label="Close record details"
          onClick={onClose}
        >
          <Icon name="close" />
        </button>
      </div>
      <div id="detail-content">
        <p className="eyebrow">
          {table === "specs"
            ? "SPECIFICATION"
            : table === "dialects"
              ? "PROTOCOL DIALECT"
              : "EQUIPMENT"}
        </p>
        <h2 id="detail-title">{table === "models" ? (text("name") ?? heading) : heading}</h2>
        <p className="detail-sub">{under}</p>

        {table === "specs" && (
          <>
            <div className="big-reading">
              {text("value") ?? "—"}
              {text("unit") && <span>{text("unit")}</span>}
            </div>
            <span className="reading-label">
              {text("page")
                ? `Read from page ${text("page")} of the maker's document`
                : "No page recorded for this figure"}
            </span>
            {text("doubt") && <p className="detail-notice">{text("doubt")}</p>}
          </>
        )}

        {table === "models" && (
          <p className="detail-meta">
            {text("kind") && <span className="evidence blue">{text("kind")}</span>}
            <span>{text("figures") ?? "0"} rated figures</span>
            <span>{text("documents") ?? "0"} documents</span>
            <span>{text("protocols") ?? "0"} protocols</span>
          </p>
        )}

        {table === "dialects" && (
          <p className="detail-meta">
            {text("driver_status") && (
              <span className="evidence blue">driver {text("driver_status")}</span>
            )}
            {text("confidence") && (
              <span
                className={`evidence ${text("confidence") === "vendor-doc" ? "blue" : "amber"}`}
              >
                {text("confidence")}
              </span>
            )}
          </p>
        )}

        {/* Whatever else the row carries, minus what has already been said above it. */}
        {Object.entries(row)
          .filter(
            ([key, value]) =>
              !BOOKKEEPING.has(key) && value !== null && value !== undefined && value !== "",
          )
          .filter(
            ([key]) =>
              ![
                "id",
                "name",
                "figure",
                "model_id",
                "manufacturer_id",
                "value",
                "unit",
                "page",
                "doubt",
                "kind",
                "driver_status",
                "confidence",
                "family",
              ].includes(key),
          )
          .map(([key, value]) => (
            <div key={key} className="detail-spec">
              <header>
                <h3>{key.replace(/_/g, " ")}</h3>
                <strong>
                  {/^https?:\/\//.test(String(value)) ? (
                    <a href={String(value)} target="_blank" rel="noopener">
                      open <Icon name="arrowUpRight" />
                    </a>
                  ) : (
                    String(value)
                  )}
                </strong>
              </header>
            </div>
          ))}

        {table === "models" && <ModelFigures model={String(row.id ?? "")} db={db} />}

        <div className="detail-notice">
          This is what the dataset records. Consult the original document and its conditions before
          using any of it for equipment sizing.
        </div>
      </div>
    </dialog>
  );
}

/** Every figure a model has, with the page each was read off. */
function ModelFigures({ model, db }: { model: string; db: State }) {
  const [figures, setFigures] = useState<Row[]>([]);
  useEffect(() => {
    if (!db.ready || !model) return;
    void db
      .run(`SELECT coalesce(english, name) AS figure, value, unit, page, doubt
            FROM specs WHERE model_id = '${model.replaceAll("'", "''")}' AND tier = 'reviewed'
            ORDER BY CASE WHEN doubt IS NULL THEN 0 ELSE 1 END, figure LIMIT 60`)
      .then((answer) => setFigures(answer.rows))
      .catch(() => setFigures([]));
  }, [db, model]);

  if (figures.length === 0) return null;
  return (
    <>
      <p className="eyebrow" style={{ marginTop: "26px" }}>
        RATED FIGURES
      </p>
      {figures.map((figure) => (
        <div key={JSON.stringify(figure)} className="detail-spec">
          <header>
            <h3>{String(figure.figure)}</h3>
            <strong>
              {String(figure.value)}
              {figure.unit ? ` ${String(figure.unit)}` : ""}
            </strong>
          </header>
          <div className="detail-meta">
            {figure.page !== null && figure.page !== undefined && (
              <span>page {String(figure.page)}</span>
            )}
            {figure.doubt !== null && figure.doubt !== undefined && (
              <span className="amber-text">{String(figure.doubt)}</span>
            )}
          </div>
        </div>
      ))}
    </>
  );
}
