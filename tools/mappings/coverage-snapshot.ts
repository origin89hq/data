import { writeFileSync } from "node:fs";
import { loadRecords } from "../../src/records.ts";
import { coverageSnapshot, SNAPSHOT_PATH } from "./snapshot-path.ts";

const snapshot = coverageSnapshot(loadRecords());
writeFileSync(SNAPSHOT_PATH, `${JSON.stringify(snapshot, null, 2)}\n`);
const makers = Object.keys(snapshot.makers).length;
const values = Object.values(snapshot.makers).reduce((n, m) => n + m.values, 0);
console.log(`wrote ${SNAPSHOT_PATH}: ${values} values across ${makers} makers`);
