const STORAGE_KEY = "solana-merchant-desk-invoices-v1";
let appConfig = null;
let invoices = loadInvoices();
const byId = (id) => document.getElementById(id);

function loadInvoices() {
  try { const value = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]"); return Array.isArray(value) ? value : []; }
  catch { return []; }
}
function saveInvoices() { localStorage.setItem(STORAGE_KEY, JSON.stringify(invoices)); renderInvoices(); }
function notice(element, text, kind = "") { element.textContent = text; element.className = `status show ${kind}`; }
function escapeHtml(value) { return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]); }
function short(value) { return value.length > 20 ? `${value.slice(0, 8)}…${value.slice(-7)}` : value; }

async function initialize() {
  try {
    const response = await fetch("/api/config", { cache: "no-store" });
    if (!response.ok) throw new Error("Не удалось получить конфигурацию приложения.");
    appConfig = await response.json();
    byId("recipient").textContent = appConfig.recipient;
    if (appConfig.demoMode) {
      byId("new-invoice").innerHTML = '<div class="callout warning"><strong>Демо-режим</strong><br>Здесь можно изучить интерфейс. Создание счетов, QR и проверка платежей отключены. Чтобы включить Mainnet, разверните приложение со своим адресом продавца и RPC.</div><a class="button secondary" href="/demo">Посмотреть сценарий работы</a>';
      return;
    }
    byId("cluster-name").textContent = appConfig.cluster === "mainnet-beta" ? "MAINNET" : appConfig.cluster.toUpperCase();
    byId("amount").value = appConfig.defaultAmount;
    renderInvoices();
  } catch (error) {
    notice(byId("new-link"), `${error.message} Проверьте конфигурацию сервера.`, "error");
  }
}

function renderInvoices() {
  const list = byId("invoice-list");
  if (!list) return;
  if (!invoices.length) { list.innerHTML = '<div class="empty">Счета появятся здесь и останутся в этом браузере.</div>'; return; }
  list.innerHTML = invoices.slice().reverse().map((invoice) => `<div class="invoice-item" data-invoice-row="${escapeHtml(invoice.id)}"><div class="invoice-top"><div><div class="invoice-title">${escapeHtml(invoice.description)} · ${escapeHtml(invoice.amount)} SOL</div><div class="invoice-meta">${escapeHtml(invoice.createdAt)} · ref ${escapeHtml(invoice.id.slice(0, 12))}</div></div><span class="state ${invoice.status === "paid" ? "paid" : ""}">${invoice.status === "paid" ? "Оплачен" : "Ожидает"}</span></div><div class="invoice-tools"><button class="tiny-button" data-action="copy" data-id="${escapeHtml(invoice.id)}">Копировать ссылку</button><button class="tiny-button" data-action="select" data-id="${escapeHtml(invoice.id)}">Проверить оплату</button>${invoice.signature ? `<a class="tiny-button" href="https://explorer.solana.com/tx/${encodeURIComponent(invoice.signature)}?cluster=${encodeURIComponent(appConfig?.cluster || "mainnet-beta")}" target="_blank" rel="noopener noreferrer">Транзакция ↗</a>` : ""}</div></div>`).join("");
}

byId("invoice-form")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!appConfig) return notice(byId("new-link"), "Серверная конфигурация ещё не загружена.", "error");
  const amount = byId("amount").value.trim().replace(",", ".");
  if (!/^\d+(?:\.\d{1,9})?$/.test(amount) || Number(amount) <= 0 || Number(amount) > Number(appConfig.maxAmount)) {
    return notice(byId("new-link"), `Введите сумму от 0 до ${appConfig.maxAmount} SOL, максимум 9 знаков после точки.`, "error");
  }
  const description = byId("description").value.trim();
  if (!description) return notice(byId("new-link"), "Добавьте описание или номер заказа.", "error");
  const randomId = crypto.randomUUID ? crypto.randomUUID().replaceAll("-", "") : Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, "0")).join("");
  const id = `inv_${randomId}`;
  const url = new URL("/api/action", window.location.origin);
  url.searchParams.set("amount", amount);
  url.searchParams.set("invoice", id);
  const invoice = { id, amount, description, url: url.toString(), status: "pending", createdAt: new Date().toLocaleString(), signature: "" };
  invoices.push(invoice);
  saveInvoices();
  const encodedAction = `solana-action:${encodeURIComponent(url.toString())}`;
  const result = byId("new-link");
  const qrUrl = `/api/qr?data=${encodeURIComponent(encodedAction)}`;
  result.innerHTML = `<strong>Счёт создан.</strong><div class="helper">Ссылка для кошелька / Blink:</div><div class="wallet-address" style="margin:8px 0">${escapeHtml(encodedAction)}</div><div class="invoice-tools"><button class="tiny-button" id="copy-payment-link">Скопировать ссылку</button><button class="tiny-button" id="copy-action-url">Копировать HTTPS адрес</button><a class="tiny-button" href="${escapeHtml(url.toString())}" target="_blank" rel="noopener noreferrer">Открыть предпросмотр</a><a class="tiny-button" href="${escapeHtml(qrUrl)}" download="invoice-${escapeHtml(id)}.svg">Скачать QR</a></div><div style="margin-top:12px"><img src="${escapeHtml(qrUrl)}" width="180" height="180" alt="QR-код платёжной ссылки" style="display:block;background:#fff;border-radius:10px;padding:8px;max-width:100%"></div><div class="helper">Покупатель должен сверить адрес и сумму в кошельке до подтверждения. Номер счёта записан в Memo.</div>`;
  result.className = "status show";
  byId("copy-payment-link").onclick = () => copyText(encodedAction, byId("copy-payment-link"));
  byId("copy-action-url").onclick = () => copyText(url.toString(), byId("copy-action-url"));
  byId("verify-invoice").value = id;
  byId("signature").focus();
});

async function copyText(text, button) {
  try { await navigator.clipboard.writeText(text); button.textContent = "Скопировано"; }
  catch { window.prompt("Скопируйте ссылку:", text); }
  setTimeout(() => { button.textContent = "Копировать ссылку"; }, 1800);
}

byId("invoice-list")?.addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  const invoice = invoices.find((item) => item.id === button.dataset.id);
  if (!invoice) return;
  if (button.dataset.action === "copy") return copyText(`solana-action:${encodeURIComponent(invoice.url)}`, button);
  byId("verify-invoice").value = invoice.id;
  byId("signature").value = invoice.signature || "";
  byId("signature").focus();
  byId("verify-form").scrollIntoView({ behavior: "smooth", block: "center" });
});

byId("verify-form")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const invoice = invoices.find((item) => item.id === byId("verify-invoice").value.trim());
  if (!invoice) return notice(byId("verify-result"), "Счёт не найден в локальном журнале этого браузера.", "error");
  const button = event.submitter;
  button.disabled = true;
  notice(byId("verify-result"), "Проверяю подпись, сумму, получателя, номер счёта и финальность в Solana…");
  try {
    const response = await fetch("/api/verify", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ invoice: invoice.id, amount: invoice.amount, signature: byId("signature").value.trim() }) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.message || "Проверка не удалась.");
    const kind = result.paid ? "" : result.state === "pending" ? "pending" : "error";
    notice(byId("verify-result"), result.message, kind);
    if (result.paid) {
      invoice.status = "paid";
      invoice.signature = byId("signature").value.trim();
      invoice.paidAt = new Date().toLocaleString();
      saveInvoices();
    }
  } catch (error) { notice(byId("verify-result"), error.message, "error"); }
  finally { button.disabled = false; }
});

byId("export-csv")?.addEventListener("click", () => {
  const rows = [["Invoice", "Description", "Amount SOL", "Status", "Created", "Paid at", "Signature"], ...invoices.map((i) => [i.id, i.description, i.amount, i.status, i.createdAt, i.paidAt || "", i.signature || ""])];
  const csv = rows.map((row) => row.map((cell) => {
    const value = String(cell);
    const safeCell = /^[\u0000-\u0020]*[=+\-@]/.test(value) ? `'${value}` : value;
    return `"${safeCell.replaceAll('"', '""')}"`;
  }).join(",")).join("\r\n");
  const blob = new Blob(["\ufeff", csv], { type: "text/csv;charset=utf-8" });
  const link = document.createElement("a"); link.href = URL.createObjectURL(blob); link.download = `solana-invoices-${new Date().toISOString().slice(0, 10)}.csv`; link.click(); URL.revokeObjectURL(link.href);
});
byId("clear-data")?.addEventListener("click", () => {
  if (!confirm("Удалить локальную историю счетов из этого браузера? Экспортируйте CSV заранее, если он нужен.")) return;
  invoices = []; saveInvoices(); notice(byId("verify-result"), "Локальная история счетов очищена.");
});

if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
initialize();
