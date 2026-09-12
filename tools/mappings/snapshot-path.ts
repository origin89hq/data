import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export { coverageSnapshot } from "./coverage.ts";

/** Where the committed coverage snapshot lives. */
export const SNAPSHOT_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "test",
  "fixtures",
  "property-coverage.json",
);
