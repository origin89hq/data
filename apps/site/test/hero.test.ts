import assert from "node:assert/strict";
import { test } from "node:test";
import { heroFigure } from "../src/hero.ts";

/** A row as `HERO_QUERY` returns it for a generator. */
const generator = {
  model_id: "champion-power-100304",
  kind: "generator",
  value: 22000,
  unit: "W",
  fuel: "lpg",
  page: 27,
  basis: "extracted",
  maker: "Champion Power Equipment",
  logo: "https://data.origin89.com/logos/champion-power-128.png",
};

test("a generator leads with its running power, the fuel it holds for, and its maker's mark", () => {
  assert.deepEqual(heroFigure(generator), {
    model: "champion-power-100304",
    kind: "generator",
    label: "Running power",
    condition: "LPG",
    value: "22,000",
    unit: "W",
    page: 27,
    basis: "Extracted",
    maker: "Champion Power Equipment",
    logo: "https://data.origin89.com/logos/champion-power-128.png",
  });
});

test("a battery leads with its capacity; a decimal keeps one place and a maker without a mark shows none", () => {
  const battery = heroFigure({
    ...generator,
    model_id: "acme-lfp-100",
    kind: "battery",
    value: 98.76,
    unit: "Ah",
    fuel: null,
    maker: null,
    logo: null,
  });
  assert.equal(battery?.label, "Capacity");
  assert.equal(battery?.value, "98.8");
  assert.equal(battery?.unit, "Ah");
  assert.equal(battery?.condition, undefined);
  assert.equal(battery?.maker, undefined);
  assert.equal(battery?.logo, undefined);
});

test("a basis or fuel the card has no name for is shown as published, never as reviewed", () => {
  assert.equal(heroFigure({ ...generator, basis: "feed" })?.basis, "Public feed");
  assert.equal(heroFigure({ ...generator, basis: "model" })?.basis, "model");
  assert.equal(heroFigure({ ...generator, fuel: "natural-gas" })?.condition, "natural gas");
  assert.equal(heroFigure({ ...generator, fuel: "diesel" })?.condition, "diesel");
});

test("a row the card cannot show is no figure at all", () => {
  assert.equal(heroFigure(undefined), undefined);
  assert.equal(heroFigure({ ...generator, kind: "appliance" }), undefined);
  assert.equal(heroFigure({ ...generator, value: "22000" }), undefined);
  assert.equal(heroFigure({ ...generator, value: Number.NaN }), undefined);
  assert.equal(heroFigure({ ...generator, page: null }), undefined);
  assert.equal(heroFigure({ ...generator, model_id: null }), undefined);
});
