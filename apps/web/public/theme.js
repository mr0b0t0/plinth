// Runs before first paint (blocking, in <head>). Applies the saved theme or the system setting.
(() => {
  var t = null;
  try {
    t = localStorage.getItem("plinth-theme");
  } catch (_e) {}
  if (t !== "light" && t !== "dark") {
    t = window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  document.documentElement.setAttribute("data-theme", t);
})();
