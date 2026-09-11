import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Ops } from "./Ops.tsx";
import "../design/styles.css";
import "../design/website-tokens.css";
import "../design/website.css";
import "./ops.css";

const root = document.getElementById("root");
if (!root) throw new Error("the page has no #root to render into");
createRoot(root).render(
  <StrictMode>
    <Ops />
  </StrictMode>,
);
