import { useCallback, useEffect, useRef, useState } from "react";
import { message, SessionError } from "./api.ts";
export function useResource<T>() {
  const [value, setValue] = useState<T>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [expired, setExpired] = useState(false);
  const current = useRef<AbortController | undefined>(undefined);
  const load = useCallback(async (read: (signal: AbortSignal) => Promise<T>) => {
    current.current?.abort();
    const controller = new AbortController();
    current.current = controller;
    setLoading(true);
    setError(undefined);
    setExpired(false);
    try {
      const result = await read(controller.signal);
      if (!controller.signal.aborted) setValue(result);
    } catch (error) {
      if (!controller.signal.aborted) {
        setError(message(error));
        setExpired(error instanceof SessionError);
      }
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, []);
  useEffect(() => () => current.current?.abort(), []);
  return { value, loading, error, expired, load };
}
