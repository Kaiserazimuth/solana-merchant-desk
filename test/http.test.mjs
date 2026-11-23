import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import bs58 from "bs58";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const merchant = new PublicKey("9o7hmfqRusxnNj5Ssx9sCmQ52jaDq1NcqAtggK2n6jYu");
const payer = new PublicKey("11111111111111111111111111111111");
const memoProgram = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
const signature = bs58.encode(Buffer.alloc(64, 9));

async function freePort() {
  const server = createNetServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test("HTTP smoke: PWA, Actions CORS, unsigned transfer, and finalized verification", { timeout: 20_000 }, async (t) => {
  const rpc = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const call = JSON.parse(body);
    let result;
    if (call.method === "getLatestBlockhash") result = { context: { slot: 1 }, value: { blockhash: payer.toBase58(), lastValidBlockHeight: 100 } };
    else if (call.method === "getSignatureStatuses") result = { context: { slot: 9 }, value: [{ slot: 9, confirmations: null, err: null, confirmationStatus: "finalized" }] };
    else if (call.method === "getTransaction") result = {
      slot: 9, blockTime: 1_700_000_000, version: "legacy",
      transaction: { signatures: [signature], message: {
        recentBlockhash: payer.toBase58(),
        accountKeys: [
          { pubkey: payer.toBase58(), signer: true, writable: true, source: "transaction" },
          { pubkey: merchant.toBase58(), signer: false, writable: true, source: "transaction" },
          { pubkey: SystemProgram.programId.toBase58(), signer: false, writable: false, source: "transaction" },
          { pubkey: memoProgram.toBase58(), signer: false, writable: false, source: "transaction" },
        ],
        instructions: [
          { program: "system", programId: SystemProgram.programId.toBase58(), parsed: { type: "transfer", info: { source: payer.toBase58(), destination: merchant.toBase58(), lamports: "10000000" } } },
          { program: "spl-memo", programId: memoProgram.toBase58(), parsed: "blink-merchant:inv_12345678" },
        ],
      } },
      meta: { err: null, fee: 5000, innerInstructions: [], logMessages: [], preBalances: [1, 0, 1, 1], postBalances: [1, 10_000_000, 1, 1], rewards: null, status: { Ok: null } },
    };
    else { res.writeHead(200, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ jsonrpc: "2.0", id: call.id, error: { code: -32601, message: "method not mocked" } })); }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: call.id, result }));
  });
  rpc.listen(0, "127.0.0.1");
  await once(rpc, "listening");
  const rpcPort = rpc.address().port;
  t.after(() => new Promise((resolve) => rpc.close(resolve)));

  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: root,
    env: { ...process.env, NODE_ENV: "test", PORT: String(port), RECIPIENT_WALLET: merchant.toBase58(), SOLANA_RPC_URL: `http://127.0.0.1:${rpcPort}`, SOLANA_CLUSTER: "devnet", PUBLIC_URL: base, DEFAULT_AMOUNT_SOL: "0.01", MAX_AMOUNT_SOL: "10" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  child.stdout.setEncoding("utf8").on("data", (data) => { logs += data; });
  child.stderr.setEncoding("utf8").on("data", (data) => { logs += data; });
  t.after(() => { child.kill(); });

  let response;
  for (let attempt = 0; attempt < 60; attempt++) {
    if (child.exitCode !== null) throw new Error(`Server exited early: ${logs}`);
    try { response = await fetch(`${base}/healthz`); if (response.ok) break; } catch { /* wait until the port is accepting requests */ }
    await delay(100);
  }
  assert.equal(response?.status, 200, `Server did not start: ${logs}`);
  assert.equal((await response.json()).status, "ok");

  response = await fetch(`${base}/api/action`, { method: "OPTIONS" });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("access-control-allow-origin"), "*");
  response = await fetch(`${base}/actions.json`);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).rules[0].apiPath, "/api/action");

  response = await fetch(`${base}/api/action?amount=0.05&invoice=inv_12345678`);
  const specificMetadata = await response.json();
  assert.equal(response.status, 200);
  assert.equal(specificMetadata.links, undefined, "A specific invoice link should render one direct action, not ask for new fields.");
  assert.match(specificMetadata.description, /0\.05 SOL/);
  const actionLink = `solana-action:${encodeURIComponent(`${base}/api/action?amount=0.05&invoice=inv_12345678`)}`;
  response = await fetch(`${base}/api/qr?data=${encodeURIComponent(actionLink)}`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /image\/svg\+xml/);
  assert.match(await response.text(), /<svg/);

  response = await fetch(`${base}/api/action?amount=0.01&invoice=inv_12345678`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ account: payer.toBase58() }),
  });
  const transferResponse = await response.json();
  assert.equal(response.status, 200, JSON.stringify(transferResponse));
  const transaction = Transaction.from(Buffer.from(transferResponse.transaction, "base64"));
  assert.equal(transaction.instructions.length, 2);
  assert.equal(transaction.instructions[0].keys[1].pubkey.toBase58(), merchant.toBase58());

  response = await fetch(`${base}/api/verify`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ invoice: "inv_12345678", amount: "0.01", signature }),
  });
  const verification = await response.json();
  assert.equal(response.status, 200, JSON.stringify(verification));
  assert.equal(verification.paid, true, JSON.stringify(verification));
});
