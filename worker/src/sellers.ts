import { Seller } from "../../schema/sighting.ts";
import raw from "../sellers.json" with { type: "json" };

/** The committed seller list, parsed once at module load so a bad entry fails the deploy, not a crawl. */
export const sellers: Seller[] = raw.map((s) => Seller.parse(s));
