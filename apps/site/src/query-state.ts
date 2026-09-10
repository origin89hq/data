import type { Query } from "./useDuckDb.ts";

export type QueryState =
  | { status: "loading" }
  | { status: "ready"; data: Query[] }
  | { status: "error" };

/** Keep a superseded or unmounted query from publishing results or errors. */
export function observeQueries(
  run: (sql: string) => Promise<Query>,
  statements: string[],
  publish: (state: QueryState) => void,
): () => void {
  let active = true;
  publish({ status: "loading" });
  void (async () => {
    try {
      const data = await Promise.all(statements.map(run));
      if (active) publish({ status: "ready", data });
    } catch {
      if (active) publish({ status: "error" });
    }
  })();
  return () => {
    active = false;
  };
}
