import type { MakerState, Pipeline, RunStatus, SellerState } from "./api.ts";
export type View = "overview" | "makers" | "sellers" | "records" | "files" | "supervisor";
export type Filter = "all" | "review" | "active" | "attention" | "readings";
export interface RunRow {
  key: string;
  kind: "maker" | "seller";
  entity: string;
  date?: string;
  maker?: MakerState;
  seller?: SellerState;
  run?: RunStatus;
  category: Filter;
  next: string;
}
export const active = (status?: string) =>
  ["queued", "running", "waiting", "paused", "waitingForPause"].includes(status ?? "");
export const broken = (status?: string) =>
  ["errored", "terminated", "unknown"].includes(status ?? "");
export const needsApproval = (maker: MakerState) =>
  maker.waitingOn === "somebody to approve the download" &&
  !maker.approvedBy &&
  (maker.offered ?? 0) > 0;
export function runRows(data: Pipeline): RunRow[] {
  const makers: RunRow[] = data.makers.map((maker) => {
    const run = data.runs.get(`maker:${maker.maker}`);
    return {
      key: `maker:${maker.maker}`,
      kind: "maker",
      entity: maker.maker,
      date: maker.date,
      maker,
      run,
      category: broken(run?.status)
        ? "attention"
        : needsApproval(maker)
          ? "review"
          : active(run?.status)
            ? "active"
            : (maker.read ?? 0) + (maker.seen ?? 0) > 0
              ? "readings"
              : "all",
      next: maker.waitingOn === "nothing" ? "No next step reported" : maker.waitingOn,
    };
  });
  const sellers: RunRow[] = data.sellers.map((seller) => {
    const run = data.runs.get(`seller:${seller.seller}`);
    return {
      key: `seller:${seller.seller}`,
      kind: "seller",
      entity: seller.seller,
      date: seller.date,
      seller,
      run,
      category: broken(run?.status) ? "attention" : active(run?.status) ? "active" : "all",
      next: seller.classified
        ? `${seller.classified.written} of ${seller.classified.parts} classification parts written`
        : seller.sightings === undefined
          ? "Waiting for crawl results"
          : "No classification result reported",
    };
  });
  return [...makers, ...sellers];
}
export const displayName = (id: string) =>
  id
    .split("-")
    .map((part) => (part ? part[0]?.toUpperCase() + part.slice(1) : ""))
    .join(" ");
export function selectRows(
  rows: RunRow[],
  view: View,
  filter: Filter,
  search: string,
  sort: "attention" | "name" | "recent",
): RunRow[] {
  const needle = search.trim().toLowerCase();
  const rank: Record<Filter, number> = { attention: 0, review: 1, active: 2, readings: 3, all: 4 };
  return rows
    .filter(
      (row) =>
        (view !== "makers" || row.kind === "maker") &&
        (view !== "sellers" || row.kind === "seller"),
    )
    .filter((row) => filter === "all" || row.category === filter)
    .filter((row) =>
      [
        row.entity,
        displayName(row.entity),
        row.date,
        row.run?.instance,
        row.run?.status,
        row.next,
        row.maker?.approvedBy,
      ].some((value) => value?.toLowerCase().includes(needle)),
    )
    .sort(
      (a, b) =>
        (sort === "attention"
          ? rank[a.category] - rank[b.category]
          : sort === "recent"
            ? (b.date ?? "").localeCompare(a.date ?? "")
            : 0) || a.entity.localeCompare(b.entity),
    );
}
export function readView(search: string): { view: View; filter: Filter; query: string } {
  const params = new URLSearchParams(search);
  const value = params.get("view");
  const filter = params.get("filter");
  return {
    view:
      value === "makers" ||
      value === "sellers" ||
      value === "records" ||
      value === "files" ||
      value === "supervisor"
        ? value
        : "overview",
    filter:
      filter === "review" || filter === "active" || filter === "attention" || filter === "readings"
        ? filter
        : "all",
    query: params.get("q") ?? "",
  };
}
export function viewSearch(view: View, filter: Filter, query: string): string {
  const params = new URLSearchParams({ view });
  if (filter !== "all") params.set("filter", filter);
  if (query.trim()) params.set("q", query.trim());
  return `?${params}`;
}
export function csv(rows: RunRow[]): string {
  const cell = (value: unknown) => {
    let text = value == null ? "" : String(value);
    if (/^[\s]*[=+@-]/.test(text)) text = `'${text}`;
    return `"${text.replaceAll('"', '""')}"`;
  };
  const fields = [
    "type",
    "entity",
    "date",
    "workflow",
    "waiting_on",
    "approved_by",
    "offered",
    "fetched",
    "converted",
    "read",
    "sightings",
  ];
  const values = rows.map((row) => [
    row.kind,
    row.entity,
    row.date,
    row.run?.status,
    row.next,
    row.maker?.approvedBy,
    row.maker?.offered,
    row.maker?.fetched,
    row.maker?.converted,
    row.maker?.read,
    row.seller?.sightings,
  ]);
  return `${[fields, ...values].map((row) => row.map(cell).join(",")).join("\r\n")}\r\n`;
}
export function download(filename: string, content: string, type = "text/plain") {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export const count = (value: number | undefined) =>
  value === undefined ? "—" : value.toLocaleString("en-US");
export const bytes = (value: number | undefined) =>
  value === undefined
    ? "Size unknown"
    : value < 1024
      ? `${value} B`
      : value < 1024 ** 2
        ? `${(value / 1024).toFixed(1)} KB`
        : `${(value / 1024 ** 2).toFixed(1)} MB`;
export const when = (value: string | Date) =>
  new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(new Date(value));
