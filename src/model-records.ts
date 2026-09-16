import type { Model } from "@origin89/equipment-schema/model";
import { withoutChemistry } from "./chemistry.ts";
import { mergeLinks } from "./dialect-links.ts";
import { matchModel } from "./specs.ts";

/** What writing one derived model did to the records. */
export type FoldOutcome = "added" | "refreshed" | "folded";

/**
 * The record a derived model becomes, given the models already held.
 *
 * A model held under the derived id is refreshed: its aliases grow, its dialect links merge, and a
 * kind the classifier gives replaces the one it had. Whatever else a person or a later step put on
 * it, a chemistry or a family, stays.
 *
 * A model held under another id that the pull would attach this name to, by name, alias or
 * the maker's name in front, is the same product spelled another way. The name becomes one of its
 * aliases and no record is minted, so a spelling folded into a model does not come back as a
 * second one (#201). Its name and kind stay: listings under one spelling do not settle what a
 * product is against a record that another spelling or a document already classified.
 *
 * A reviewed model is a person's work, and only its aliases grow, by either route.
 */
export function foldDerived(
  held: readonly Model[],
  derived: Model,
  makerNames: readonly string[] = [],
): { record: Model; outcome: FoldOutcome } {
  const same = held.find((m) => m.id === derived.id);
  if (same) {
    if (same.reviewedBy)
      return { record: withAliases(same, derived.aliases), outcome: "refreshed" };
    // A kind an earlier crawl established survives a later one that ran with no classifier:
    // absence of evidence is not evidence that the kind changed.
    const kind = derived.kind ?? same.kind;
    const refreshed: Model = {
      ...same,
      ...derived,
      ...(kind ? { kind } : {}),
      aliases: withAliases(same, derived.aliases).aliases,
      dialects: mergeLinks(same.dialects, derived.dialects),
    };
    // Only a battery carries a chemistry; a model that stops being one loses it with the kind.
    return {
      record: kind === "battery" ? refreshed : withoutChemistry(refreshed),
      outcome: "refreshed",
    };
  }
  const answering = matchModel([...held], derived.manufacturer, derived.name, makerNames);
  if (!answering) return { record: derived, outcome: "added" };
  const names = [derived.name, ...derived.aliases];
  if (answering.reviewedBy) return { record: withAliases(answering, names), outcome: "folded" };
  const kind = answering.kind ?? derived.kind;
  return {
    record: {
      ...withAliases(answering, names),
      ...(kind ? { kind } : {}),
      dialects: mergeLinks(answering.dialects, derived.dialects),
    },
    outcome: "folded",
  };
}

/**
 * The model with each name it does not already carry added as an alias. Another punctuation is
 * kept, since it is how a shop or a sheet writes the name; another case of a known name is not.
 */
function withAliases(model: Model, names: readonly string[]): Model {
  const aliases = [...model.aliases];
  const known = (name: string) =>
    [model.name, ...aliases].some((k) => k.toLowerCase() === name.toLowerCase());
  for (const name of names) if (!known(name)) aliases.push(name);
  return { ...model, aliases: aliases.sort() };
}
