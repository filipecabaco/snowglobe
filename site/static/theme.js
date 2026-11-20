// The theme toggle every page shares: the system's theme by default; the toggle pins the other
// one and remembers it. Each page's <head> applies a remembered theme before first paint.
{
  const toggle = document.getElementById("theme-toggle");
  const systemDark = matchMedia("(prefers-color-scheme: dark)");
  const isDark = () => (document.documentElement.dataset.theme || (systemDark.matches ? "dark" : "light")) === "dark";
  const labelTheme = () => {
    toggle.textContent = isDark() ? "Light" : "Dark";
    toggle.setAttribute("aria-label", `Switch to ${isDark() ? "light" : "dark"} theme`);
  };
  toggle.addEventListener("click", () => {
    const next = isDark() ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem("snowglobe-theme", next); } catch {}
    labelTheme();
  });
  systemDark.addEventListener("change", labelTheme);
  labelTheme();
}
