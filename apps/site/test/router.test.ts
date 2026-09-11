import assert from "node:assert/strict";
import { test } from "node:test";
import { createMemoryHistory } from "@tanstack/react-router";
import { createOpsRouter, validateOpsSearch } from "../src/ops/router.ts";

test("legacy view links redirect to a section and preserve filters", async () => {
  const router = createOpsRouter({
    history: createMemoryHistory({ initialEntries: ["/ops?view=makers&filter=review&q=Rolls"] }),
  });
  await router.load();
  // Node resolves TanStack's server entry: the redirect is returned to its host.
  const result = router._serverResult;
  assert.equal(result?.type, "redirect");
  if (result?.type !== "redirect") throw Error("Expected a legacy-link redirect");
  assert.equal(result.redirect.headers.get("location"), "/ops/makers?filter=review&q=Rolls");
});

test("direct links select the section and validate URL state", async () => {
  const router = createOpsRouter({
    history: createMemoryHistory({ initialEntries: ["/ops/sellers?sort=name&page=2&q=solar"] }),
  });
  await router.load();
  const match = router.state.matches.at(-1);
  assert.equal(match?.status, "success");
  assert.equal(match?.params.view, "sellers");
  assert.deepEqual(match?.search, { sort: "name", page: 2, q: "solar" });
});

test("section navigation and search changes survive browser history", async () => {
  const history = createMemoryHistory({ initialEntries: ["/ops/makers?filter=review"] });
  const router = createOpsRouter({ history });
  await router.load();
  await router.navigate({ to: "/ops/$view", params: { view: "files" }, search: { q: "specs" } });
  await router.load();
  assert.equal(router.state.location.pathname, "/ops/files");
  history.back();
  await router.load();
  assert.equal(router.state.location.pathname, "/ops/makers");
  assert.equal(router.state.matches.at(-1)?.search.filter, "review");
  history.forward();
  await router.load();
  assert.equal(router.state.location.search.q, "specs");
});

test("unknown sections are not silently shown as the overview", async () => {
  const router = createOpsRouter({
    history: createMemoryHistory({ initialEntries: ["/ops/not-a-section"] }),
  });
  await router.load();
  assert.equal(router.state.matches.at(-1)?.status, "notFound");
});

test("invalid search input is bounded and discarded", () => {
  assert.deepEqual(
    validateOpsSearch({
      filter: "bogus",
      q: {},
      sort: "random",
      page: -3,
      release: "../../secret",
    }),
    {},
  );
  assert.deepEqual(validateOpsSearch({ page: 1.5 }), {});
  assert.deepEqual(validateOpsSearch({ page: 999999, q: "x".repeat(250) }), {
    page: 100000,
    q: "x".repeat(200),
  });
  assert.deepEqual(validateOpsSearch({ release: "a".repeat(64) }), { release: "a".repeat(64) });
});
