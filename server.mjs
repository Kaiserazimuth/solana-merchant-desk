import "dotenv/config";
import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import QRCode from "qrcode";
import {
  ActionInputError,
  buildActionMetadata,
  buildActionsJson,
  createConnection,
  createUnsignedTransfer,
  corsHeaders,
  parseSol,
  readSettings,
  verifyInvoicePayment,
} from "./src/action.mjs";

const root = path.dirname(fileURLToPath(import.meta.url));
const settings = readSettings();
if (process.env.NODE_ENV === "production" && !/^https:\/\//i.test(process.env.PUBLIC_URL || "")) {
  throw new Error("In production, PUBLIC_URL must be set to the final HTTPS origin.");
}
if (process.env.NODE_ENV === "production" && !/^https:\/\//i.test(settings.rpcUrl)) {
  throw new Error("In production, SOLANA_RPC_URL must use HTTPS.");
}
const connection = createConnection(settings);
const mime = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8", ".svg": "image/svg+xml",
};
const requestWindows = new Map();

function isRateLimited(req) {
  const forwardedFor = process.env.TRUST_PROXY === "true" ? req.headers["x-forwarded-for"]?.split(",")[0]?.trim() : "";
  const key = forwardedFor || req.socket.remoteAddress || "unknown";
  const now = Date.now();
  const state = requestWindows.get(key);
  if (!state || now - state.start >= 60_000) {
    requestWindows.set(key, { start: now, count: 1 });
    if (requestWindows.size > 5_000) {
      for (const [address, item] of requestWindows) if (now - item.start > 60_000) requestWindows.delete(address);
    }
    return false;
  }
  state.count += 1;
  return state.count > 30;
}

function sendJson(res, status, body, extra = {}) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff", "Referrer-Policy": "strict-origin-when-cross-origin",
    "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
    ...(process.env.NODE_ENV === "production" ? { "Strict-Transport-Security": "max-age=31536000; includeSubDomains" } : {}),
    ...corsHeaders(), ...extra,
  });
  res.end(JSON.stringify(body));
}

function pageContentSecurityPolicy() {
  const framePolicy = process.env.NODE_ENV === "test" ? "'self'" : "'none'";
  return `default-src 'self'; img-src 'self' data:; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors ${framePolicy}; form-action 'self'`;
}

async function readJson(req, maxBytes = 16_384) {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (Buffer.byteLength(body) > maxBytes) throw new ActionInputError("Request body is too large.");
  }
  try { return JSON.parse(body || "{}"); }
  catch { throw new ActionInputError("Request body must be valid JSON."); }
}

async function handler(req, res) {
  const url = new URL(req.url, settings.publicUrl);
  if (url.pathname === "/healthz") {
    if (req.method !== "GET") return sendJson(res, 405, { message: "Use GET." }, { Allow: "GET" });
    return sendJson(res, 200, { status: "ok", cluster: settings.cluster });
  }
  if (url.pathname === "/api/config") {
    if (req.method !== "GET") return sendJson(res, 405, { message: "Use GET." }, { Allow: "GET" });
    return sendJson(res, 200, {
      appName: settings.appName,
      description: settings.description,
      recipient: settings.recipientText,
      defaultAmount: settings.defaultAmount.text,
      maxAmount: settings.maxAmount.lamports / 1_000_000_000,
      cluster: settings.cluster,
      demoMode: settings.demoMode,
    });
  }
  if (settings.demoMode && url.pathname.startsWith("/api/")) {
    return sendJson(res, 503, { message: "Демонстрационный режим: платёжные функции отключены. Для работы подключите свой адрес продавца и RPC." });
  }
  if (url.pathname === "/api/qr") {
    if (req.method !== "GET") return sendJson(res, 405, { message: "Use GET." }, { Allow: "GET" });
    if (isRateLimited(req)) return sendJson(res, 429, { message: "Rate limit reached. Wait a minute and try again." }, { "Retry-After": "60" });
    const data = url.searchParams.get("data") || "";
    if (data.length > 2048 || !data.startsWith("solana-action:")) return sendJson(res, 400, { message: "Provide a valid, short Solana Action link." });
    try {
      const actionUrl = new URL(decodeURIComponent(data.slice("solana-action:".length)));
      const requestOrigin = `${req.headers["x-forwarded-proto"] || "http"}://${req.headers.host}`;
      const expectedOrigin = process.env.NODE_ENV === "production" ? settings.publicUrl : requestOrigin;
      if (actionUrl.origin !== expectedOrigin || actionUrl.pathname !== "/api/action" || !actionUrl.searchParams.get("amount") || !actionUrl.searchParams.get("invoice")) {
        return sendJson(res, 400, { message: "QR codes can only be generated for this app's complete invoice links." });
      }
      const svg = await QRCode.toString(data, { type: "svg", errorCorrectionLevel: "M", margin: 2, width: 260, color: { dark: "#101725", light: "#ffffff" } });
      res.writeHead(200, { "Content-Type": "image/svg+xml; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox" });
      return res.end(svg);
    } catch {
      return sendJson(res, 400, { message: "Could not create a QR code for this link." });
    }
  }
  if (url.pathname === "/api/action") {
    if (req.method === "OPTIONS") return sendJson(res, 200, buildActionMetadata(settings));
    if (req.method === "GET") {
      const amount = url.searchParams.get("amount");
      const invoice = url.searchParams.get("invoice");
      if (amount || invoice) {
        try {
          if (!amount || !invoice || !/^[a-zA-Z0-9_-]{8,64}$/.test(invoice)) throw new ActionInputError("This payment link is incomplete or has an invalid invoice reference.");
          const validAmount = parseSol(amount, String(settings.maxAmount.lamports / 1_000_000_000));
          return sendJson(res, 200, buildActionMetadata(settings, { amount: validAmount.text, invoice }));
        } catch (error) {
          return sendJson(res, 400, { message: error.message });
        }
      }
      return sendJson(res, 200, buildActionMetadata(settings));
    }
    if (req.method === "POST") {
      if (isRateLimited(req)) return sendJson(res, 429, { message: "Rate limit reached. Wait a minute and try again." }, { "Retry-After": "60" });
      try {
        const body = await readJson(req);
        const result = await createUnsignedTransfer({
          account: body.account,
          amountText: url.searchParams.get("amount") || settings.defaultAmount.text,
          invoice: url.searchParams.get("invoice"),
          settings,
          connection,
        });
        return sendJson(res, 200, result);
      } catch (error) {
        const status = error instanceof ActionInputError ? 400 : 503;
        const message = error instanceof ActionInputError ? error.message : "Could not reach Solana RPC. Check SOLANA_RPC_URL and try again.";
        return sendJson(res, status, { message });
      }
    }
    return sendJson(res, 405, { message: "Use GET, POST, or OPTIONS." }, { Allow: "GET, POST, OPTIONS" });
  }

  if (url.pathname === "/api/verify") {
    if (req.method === "OPTIONS") return sendJson(res, 200, { ok: true });
    if (req.method !== "POST") return sendJson(res, 405, { message: "Use POST or OPTIONS." }, { Allow: "POST, OPTIONS" });
    if (isRateLimited(req)) return sendJson(res, 429, { message: "Rate limit reached. Wait a minute and try again." }, { "Retry-After": "60" });
    try {
      const body = await readJson(req);
      if (typeof body.signature !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{80,100}$/.test(body.signature)) {
        throw new ActionInputError("Enter a valid Solana transaction signature.");
      }
      const statusResult = await connection.getSignatureStatuses([body.signature], { searchTransactionHistory: true });
      const signatureStatus = statusResult.value[0];
      const parsedTransaction = signatureStatus
        ? await connection.getParsedTransaction(body.signature, { commitment: "finalized", maxSupportedTransactionVersion: 0 })
        : null;
      const result = verifyInvoicePayment({
        invoice: body.invoice,
        amountText: body.amount,
        signature: body.signature,
        settings,
        parsedTransaction,
        signatureStatus,
      });
      return sendJson(res, 200, result);
    } catch (error) {
      const status = error instanceof ActionInputError ? 400 : 503;
      const message = error instanceof ActionInputError ? error.message : "Could not verify with Solana RPC. Check SOLANA_RPC_URL and try again.";
      return sendJson(res, status, { message });
    }
  }

  if (url.pathname === "/actions.json") {
    if (req.method === "OPTIONS") return sendJson(res, 200, buildActionsJson());
    if (req.method !== "GET") return sendJson(res, 405, { message: "Use GET or OPTIONS." }, { Allow: "GET, OPTIONS" });
    return sendJson(res, 200, buildActionsJson());
  }

  if (req.method !== "GET" && req.method !== "HEAD") return sendJson(res, 405, { message: "Method not allowed." });
  let pathname = url.pathname === "/" ? "/index.html" : url.pathname;
  if (pathname === "/demo") pathname = "/demo.html";
  if (pathname === "/support") pathname = "/support.html";
  let decodedPath;
  try { decodedPath = decodeURIComponent(pathname); }
  catch { return sendJson(res, 400, { message: "Malformed URL path." }); }
  const publicRoot = path.resolve(root, "public");
  const relativePath = decodedPath.replace(/^[/\\]+/, "");
  const file = path.resolve(publicRoot, relativePath);
  if (file !== publicRoot && !file.startsWith(`${publicRoot}${path.sep}`)) return sendJson(res, 404, { message: "Not found." });
  try {
    const contents = await readFile(file);
    res.writeHead(200, {
      "Content-Type": mime[path.extname(file)] || "application/octet-stream",
      "Cache-Control": pathname.endsWith(".html") ? "no-cache" : "public, max-age=3600",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "strict-origin-when-cross-origin",
      "Content-Security-Policy": pageContentSecurityPolicy(),
      ...(process.env.NODE_ENV === "production" ? { "Strict-Transport-Security": "max-age=31536000; includeSubDomains" } : {}),
      ...(pathname === "/icon.svg" ? { "Access-Control-Allow-Origin": "*" } : {}),
    });
    if (req.method === "HEAD") return res.end();
    return res.end(contents);
  } catch {
    return sendJson(res, 404, { message: "Not found." });
  }
}

const server = http.createServer((req, res) => {
  handler(req, res).catch(() => {
    if (!res.headersSent) sendJson(res, 500, { message: "Unexpected server error." });
    else res.destroy();
  });
});
export default server;
if (process.env.DEMO_MODE !== "true") {
  const port = Number(process.env.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PORT must be an integer from 1 to 65535.");
  server.listen(port, "0.0.0.0", () => console.log(`Solana Merchant Desk listening on http://localhost:${port}`));
}
