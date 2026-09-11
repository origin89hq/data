import { Link, RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Ops } from "./Ops.tsx";
import { createOpsRouter } from "./router.ts";
import "../design/styles.css";
import "../design/website-tokens.css";
import "../design/website.css";
import "./ops.css";

const router = createOpsRouter({
  component: Ops,
  notFoundComponent: () => (
    <div className="ops-signin">
      <h1>Workspace page not found</h1>
      <Link to="/ops/$view" params={{ view: "overview" }} search={{}}>
        Back to overview
      </Link>
    </div>
  ),
});

const root = document.getElementById("root");
if (!root) throw new Error("the page has no #root to render into");
createRoot(root).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
