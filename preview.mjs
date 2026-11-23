process.env.DEMO_MODE = "true";
const server = (await import("./server.mjs")).default;
const port = Number(process.env.PORT || 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PORT must be an integer from 1 to 65535.");
server.listen(port, "0.0.0.0", () => console.log(`Solana Merchant Desk demo listening on http://localhost:${port}`));
