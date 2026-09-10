import { useEffect, useMemo, useState } from "react";
import { count, type Index } from "./api.ts";
import { useDuckDb } from "./useDuckDb.ts";

type Row = Record<string, unknown>;

/** What each tab asks the published tables, and which column its filter narrows. */
const TABLES = {
  models: {
    label: "Equipment",
    table: "models",
    columns: ["id", "name", "manufacturer_id", "kind", "variant"],
    search: ["id", "name", "manufacturer_id"],
    filter: { column: "kind", label: "All equipment types" },
  },
  specs: {
    label: "Specifications",
    table: "specs",
    columns: ["model_id", "name", "value", "unit", "page", "confidence", "doubt"],
    search: ["model_id", "name", "value"],
    filter: { column: "unit", label: "All units" },
  },
  dialects: {
    label: "Protocols",
    table: "dialects",
    columns: ["id", "family", "driver_status", "confidence"],
    search: ["id", "family"],
    filter: { column: "family", label: "All families" },
  },
} as const;

type TabName = keyof typeof TABLES;
const PAGE = 12;

/**
 * The explorer, reading the published tables rather than a sample baked into the page.
 *
 * The draft shipped 38 models in a JavaScript file so it could be opened from disk. Here DuckDB
 * reads the Parquet over HTTP in the reader's own browser, so a search is over everything that is
 * published and the row somebody inspects is the row anybody else would get.
 */
export function Explorer({ index, tier }: { index?: Index; tier: "reviewed" | "all" }) {
  const db = useDuckDb(index);
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
  const scope = useMemo(() => (tier === "reviewed" && tab !== "dialects" ? "tier = 'reviewed'" : "TRUE"), [tier, tab]);

  const where = useMemo(() => {
    const clauses = [scope];
    if (search.trim()) {
      const needle = search.trim().replaceAll("'", "''").toLowerCase();
      clauses.push(`(${spec.search.map((c) => `lower(coalesce(${c}, '')) LIKE '%${needle}%'`).join(" OR ")})`);
    }
    if (filter) clauses.push(`${spec.filter.column} = '${filter.replaceAll("'", "''")}'`);
    return clauses.join(" AND ");
  }, [scope, search, filter, spec]);

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
  }, [db, tab, scope, spec]);

  useEffect(() => {
    if (!db.ready) return;
    let stale = false;
    void Promise.all([
      db.run(`SELECT count(*) AS n FROM ${spec.table} WHERE ${where}`),
      db.run(`SELECT ${spec.columns.join(", ")} FROM ${spec.table} WHERE ${where}
              ORDER BY 1 LIMIT ${PAGE} OFFSET ${page * PAGE}`),
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
              key={name}
              role="tab"
              aria-selected={tab === name}
              tabIndex={tab === name ? 0 : -1}
              onClick={() => setTab(name)}
            >
              {TABLES[name].label} <span>{count(index?.files[`${TABLES[name].table}.parquet`]?.rows ?? 0)}</span>
            </button>
          ))}
        </div>
        <span className="sample-label">{db.ready ? "LIVE FROM THE PUBLISHED TABLES" : "LOADING DUCKDB"}</span>
      </div>
      <div className="explorer-tools">
        <label className="search-box">
          <span aria-hidden>⌕</span>
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
        <label className="sr-only" htmlFor="filter">Narrow the records</label>
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
            <option key={choice} value={choice}>{choice}</option>
          ))}
        </select>
      </div>
      <div role="tabpanel">
        <div className="table-scroll">
          <table>
            <thead>
              <tr>{spec.columns.map((column) => <th key={column}>{column.replace(/_/g, " ")}</th>)}</tr>
            </thead>
            <tbody>
              {rows.map((row, i) => (
                <tr key={i} onClick={() => setChosen(row)} style={{ cursor: "pointer" }}>
                  {spec.columns.map((column) => (
                    <td key={column}>{row[column] === null || row[column] === undefined ? "—" : String(row[column])}</td>
                  ))}
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={spec.columns.length}>{db.ready ? "Nothing matches that." : "Reading the tables…"}</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
      <div className="explorer-bottom">
        <span role="status" aria-live="polite">{count(total)} records</span>
        <div className="pagination">
          <button onClick={() => setPage((p) => Math.max(0, p - 1))} disabled={page === 0} aria-label="Previous page">←</button>
          <span>{page + 1} / {count(pages)}</span>
          <button onClick={() => setPage((p) => Math.min(pages - 1, p + 1))} disabled={page + 1 >= pages} aria-label="Next page">→</button>
        </div>
      </div>
      {chosen && <RecordDialog row={chosen} onClose={() => setChosen(undefined)} />}
    </div>
  );
}

/** One record, every column it has, with nothing summarised away. */
function RecordDialog({ row, onClose }: { row: Row; onClose: () => void }) {
  useEffect(() => {
    const escape = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [onClose]);
  return (
    <div className="record-dialog-backdrop" role="presentation" onClick={onClose}>
      <div className="record-dialog" role="dialog" aria-modal="true" aria-label="Record detail" onClick={(event) => event.stopPropagation()}>
        <div className="panel-cap">
          <span>RECORD</span>
          <button onClick={onClose} aria-label="Close">✕</button>
        </div>
        <dl>
          {Object.entries(row).map(([key, value]) => (
            <div key={key}>
              <dt>{key.replace(/_/g, " ")}</dt>
              <dd>
                {value === null || value === undefined || value === "" ? (
                  <span className="amber-text">not recorded</span>
                ) : /^https?:\/\//.test(String(value)) ? (
                  <a href={String(value)} target="_blank" rel="noopener">{String(value)}</a>
                ) : (
                  String(value)
                )}
              </dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  );
}
