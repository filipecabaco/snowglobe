// A remembered theme, applied before first paint (the page's CSP allows no inline script)
try {
  const t = localStorage.getItem("snowglobe-theme");
  if (t === "dark" || t === "light") document.documentElement.dataset.theme = t;
} catch {}
