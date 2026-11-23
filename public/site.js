document.querySelectorAll("[data-copy]").forEach((button) => button.addEventListener("click", async () => {
  const text = document.getElementById(button.dataset.copy)?.textContent || "";
  try { await navigator.clipboard.writeText(text); button.textContent = "Скопировано"; }
  catch { window.prompt("Скопируйте адрес вручную:", text); }
  setTimeout(() => { button.textContent = "Скопировать"; }, 1800);
}));
if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
fetch("/api/config", { cache: "no-store" }).then((response) => response.ok ? response.json() : null).then((config) => {
  const cluster = document.getElementById("cluster-name");
  if (cluster && config) cluster.textContent = config.cluster === "mainnet-beta" ? "MAINNET" : config.cluster.toUpperCase();
}).catch(() => {});
