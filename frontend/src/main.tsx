import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { getTheme } from "./theme";
import "./styles.css";

// 渲染前应用已保存的主题，避免暗/亮闪变
document.documentElement.dataset.theme = getTheme();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
