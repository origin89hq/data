import { useEffect, useState } from "react";
import { fetchIndex, fetchMakers, type Index, type Maker } from "./api.ts";
import { Console, Header, Makers, Tables } from "./sections.tsx";
import { Licence, Usage } from "./usage.tsx";

/**
 * The whole page. It holds no numbers of its own: the counts, the tables and the makers all come
 * from the endpoints anybody else would call, so what a reader sees is what is published.
 */
export function App() {
  const [index, setIndex] = useState<Index>();
  const [makers, setMakers] = useState<Maker[]>([]);
  const [failed, setFailed] = useState<string>();

  useEffect(() => {
    void fetchIndex().then(setIndex).catch((error: unknown) => setFailed(String(error)));
    void fetchMakers().then(setMakers).catch(() => setMakers([]));
  }, []);

  return (
    <>
      <Header index={index} />
      {failed && (
        <div className="mx-auto max-w-5xl px-6 py-6">
          <p className="m-0 border-l-2 border-alarm pl-4 text-muted">
            The index did not answer, so the numbers below are missing rather than wrong: {failed}
          </p>
        </div>
      )}
      {makers.length > 0 && <Makers makers={makers} />}
      <Tables index={index} />
      <Console index={index} />
      <Usage origin={window.location.origin} />
      <Licence buddy="/logos/buddy-256.png" />
      <footer className="px-6 pt-11 pb-18">
        <div className="mx-auto max-w-5xl text-[13.5px] text-faint">
          <p className="m-0">
            Built by <a className="text-link hover:underline" href="https://origin89.com">Origin89</a> ·{" "}
            <a className="text-link hover:underline" href="https://github.com/origin89hq/offgrid-equipment">source on GitHub</a> ·{" "}
            <a className="text-link hover:underline" href="mailto:hello@origin89.com">hello@origin89.com</a>
          </p>
          <p className="m-0 mt-1.5">
            Corrections are the most useful contribution. Every figure names its document, so a wrong one can be shown wrong.
          </p>
        </div>
      </footer>
    </>
  );
}
