import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Spike } from "./Spike.tsx";
import "./spike.css";

const root = document.getElementById("root");
if (!root) throw new Error("the page has no #root to render into");
createRoot(root).render(
  <StrictMode>
    <Spike />
  </StrictMode>,
);
