/** 主题：CSS 变量多主题，data-theme 挂在 <html> 上，选择持久化到 localStorage。 */

export const THEME_KEY = "cf_theme";

export const THEMES = [
  { id: "dark", label: "深色（默认）", dark: true },
  { id: "light", label: "浅色", dark: false },
  { id: "midnight", label: "暗夜蓝", dark: true },
  { id: "forest", label: "浅绿", dark: false },
] as const;

export type ThemeId = (typeof THEMES)[number]["id"];

export function getTheme(): ThemeId {
  const saved = localStorage.getItem(THEME_KEY);
  return THEMES.find((t) => t.id === saved)?.id ?? "dark";
}

/** 应用并持久化主题（dark 为默认值，无需属性覆盖，但统一设置便于判断） */
export function setTheme(id: ThemeId): void {
  localStorage.setItem(THEME_KEY, id);
  document.documentElement.dataset.theme = id;
}
