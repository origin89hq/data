import assert from "node:assert/strict";
import { test } from "node:test";
import { looksForeign, withoutRedundantTranslations } from "../src/language.ts";

test("a one-word Spanish name is foreign even with no accent and no function word", () => {
  // An OutBack FLEXmax published its case as "Altura", "Ancho" and "Altura con ventilador".
  for (const name of [
    "Altura",
    "Ancho",
    "Anchura",
    "Amperaje",
    "Cilindrada",
    "Poids",
    "Largo",
    "VATIOS GASOLINA",
  ]) {
    assert.equal(looksForeign(name), true, `${name} should read as foreign`);
  }
});

test("an English name that shares a root with a foreign one is not foreign", () => {
  // The reason "motor", "phase", "charge", "tension", "dimensions" and "altitude" are off the list.
  for (const name of [
    "Power",
    "Voltage",
    "RPM",
    "AC AMPS",
    "Maximum Altitude Rating",
    "Motor rating",
    "Phase",
    "Charge current",
    "Dimensions",
    "Float Voltage",
  ]) {
    assert.equal(looksForeign(name), false, `${name} is English`);
  }
});

test("a foreign figure is dropped only when its model has English figures to fall back on", () => {
  const covered = [
    { id: "a--maximum-current", model: "a", name: "Maximum current", value: "10" },
    { id: "a--corriente-maxima", model: "a", name: "Corriente máxima", value: "10" },
  ];
  assert.deepEqual(
    withoutRedundantTranslations(covered).keep.map((s) => s.name),
    ["Maximum current"],
  );
  // The only description a model has stays, whatever language it is in.
  const alone = [{ id: "b--corriente-maxima", model: "b", name: "Corriente máxima", value: "10" }];
  assert.deepEqual(withoutRedundantTranslations(alone).keep, alone);
  assert.equal(withoutRedundantTranslations(alone).kept.length, 1);
});
