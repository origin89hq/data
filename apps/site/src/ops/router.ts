import {
  createRootRoute,
  createRoute,
  createRouter,
  notFound,
  type RouteComponent,
  type RouterHistory,
  redirect,
} from "@tanstack/react-router";
import { type Filter, readView, type View } from "./workspace.ts";

export interface OpsSearch {
  filter?: Filter;
  q?: string;
  sort?: "attention" | "name" | "recent";
  page?: number;
  release?: string;
  view?: View;
}

export function validateOpsSearch(input: Record<string, unknown>): OpsSearch {
  const result: OpsSearch = {};
  const legacy = readView(
    new URLSearchParams({
      view: typeof input.view === "string" ? input.view : "",
      filter: typeof input.filter === "string" ? input.filter : "",
    }).toString(),
  );
  if (input.view !== undefined) result.view = legacy.view;
  if (legacy.filter !== "all") result.filter = legacy.filter;
  if (typeof input.q === "string" && input.q) result.q = input.q.slice(0, 200);
  if (input.sort === "name" || input.sort === "recent") result.sort = input.sort;
  if (typeof input.page === "number" && Number.isSafeInteger(input.page) && input.page > 0)
    result.page = Math.min(input.page, 100000);
  if (typeof input.release === "string" && /^[a-f0-9]{64}$/.test(input.release))
    result.release = input.release;
  return result;
}

/** One route identity keeps the loaded workspace alive when changing sections. */
export function createOpsRouter(
  options: {
    history?: RouterHistory;
    component?: RouteComponent;
    notFoundComponent?: RouteComponent;
  } = {},
) {
  const root = createRootRoute({ notFoundComponent: options.notFoundComponent });
  const index = createRoute({
    getParentRoute: () => root,
    path: "/ops",
    validateSearch: validateOpsSearch,
    beforeLoad: ({ search }) => {
      const { view, ...rest } = search;
      throw redirect({
        to: "/ops/$view",
        params: { view: view ?? "overview" },
        search: rest,
        replace: true,
      });
    },
  });
  const section = createRoute({
    getParentRoute: () => root,
    path: "/ops/$view",
    params: {
      parse: ({ view }) => {
        const parsed = readView(new URLSearchParams({ view }).toString()).view;
        if (parsed !== view) throw notFound();
        return { view: parsed };
      },
    },
    validateSearch: validateOpsSearch,
    component: options.component,
  });
  return createRouter({
    routeTree: root.addChildren([index, section]),
    history: options.history,
    trailingSlash: "never",
  });
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof createOpsRouter>;
  }
}
