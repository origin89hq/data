/** What is published, fetched from the index rather than held as a copy in this repo. */
export interface Index {
  name: string;
  description: string;
  licence: string;
  repository: string;
  contact: string;
  provenance: string;
  logos: { note: string; url: string };
  counts?: Record<string, number>;
  files: Record<string, { rows: number; bytes: number; sha256: string; url: string }>;
}

/** A manufacturer as the published table has it. Only the columns this page shows. */
export interface Maker {
  id: string;
  name: string;
  website?: string;
  logo?: string;
  logo_from?: string;
}

/** The origin the tables are served from. Same host in production; the Vite proxy in development. */
export const base = "";

export async function fetchIndex(): Promise<Index> {
  const res = await fetch(`${base}/manifest.json`);
  if (!res.ok) throw new Error(`the index answered ${res.status}`);
  return (await res.json()) as Index;
}

/**
 * A CSV row split on commas that are not inside quotes. Small and deliberate: the only file this
 * reads is one this repo builds, and a parser library for eight columns is a dependency to keep
 * up to date for no gain.
 */
function cells(line: string): string[] {
  const out: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (quoted) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          field += '"';
          i += 1;
        } else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === ",") {
      out.push(field);
      field = "";
    } else field += c;
  }
  out.push(field);
  return out;
}

/** Every manufacturer, read from the published table so the page cannot list one it does not have. */
export async function fetchMakers(): Promise<Maker[]> {
  const res = await fetch(`${base}/v1/manufacturers.csv`);
  if (!res.ok) throw new Error(`the manufacturers table answered ${res.status}`);
  const [header, ...lines] = (await res.text()).trim().split("\n");
  const columns = cells(header ?? "");
  const at = (name: string) => columns.indexOf(name);
  return lines.map((line) => {
    const row = cells(line);
    const value = (name: string) => row[at(name)] || undefined;
    return {
      id: value("id") ?? "",
      name: value("name") ?? "",
      website: value("website"),
      logo: value("logo"),
      logo_from: value("logo_from"),
    };
  });
}

/** Rows for a table in the index, or zero when it is not published. */
export const rowsOf = (index: Index | undefined, table: string): number =>
  index?.files[`${table}.parquet`]?.rows ?? 0;

export const count = (n: number): string => n.toLocaleString("en-US");
export const kb = (bytes: number): string =>
  `${Math.round(bytes / 1024).toLocaleString("en-US")} KB`;
