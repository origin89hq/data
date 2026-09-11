import { useEffect, useState } from "react";
import { observeQueries, type QueryState } from "./query-state.ts";
import type { State } from "./useDuckDb.ts";

/** A result belongs to its database, SQL, and retry attempt, even before effects run. */
export function useQuery(db: State, ...statements: string[]) {
  const key = JSON.stringify(statements);
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{
    db: State;
    key: string;
    attempt: number;
    value: QueryState;
  }>();

  useEffect(() => {
    if (!db.ready) return;
    return observeQueries(db.run, JSON.parse(key), (value) => {
      setResult({ db, key, attempt, value });
    });
  }, [db, key, attempt]);

  const state: QueryState =
    !db.ready && db.error
      ? { status: "error" }
      : result?.db === db && result.key === key && result.attempt === attempt
        ? result.value
        : { status: "loading" };
  const retry = () => {
    if (!db.ready) db.retry?.();
    else setAttempt((value) => value + 1);
  };
  return { ...state, retry };
}
