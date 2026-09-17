import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Site } from "./Site.tsx";
import "./design/theme.css";
import "./design/chrome.css";
import "./design/data.css";
import "./design/site.css";

const root = document.getElementById("root");
if (!root) throw new Error("the page has no #root to render into");
createRoot(root).render(
  <StrictMode>
    <Site />
  </StrictMode>,
);
