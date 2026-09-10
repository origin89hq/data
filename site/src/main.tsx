import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("the page has no #root to render into");
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
