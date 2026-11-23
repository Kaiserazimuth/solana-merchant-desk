import test from "node:test";
import assert from "node:assert/strict";
import bs58 from "bs58";
import { PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import {
  ActionInputError, buildActionMetadata, buildActionsJson, corsHeaders,
  createUnsignedTransfer, parseSol, readSettings,
} from "../src/action.mjs";

const wallet = new PublicKey("9o7hmfqRusxnNj5Ssx9sCmQ52jaDq1NcqAtggK2n6jYu");
const payer = new PublicKey("11111111111111111111111111111111");
const settings = readSettings({ RECIPIENT_WALLET: wallet.toBase58(), DEFAULT_AMOUNT_SOL: "0.01", MAX_AMOUNT_SOL: "10", PUBLIC_URL: "https://example.test/" });

test("parses precise SOL amounts and enforces boundaries", () => {
  assert.deepEqual(parseSol("0.000000001"), { text: "0.000000001", lamports: 1 });
  assert.throws(() => parseSol("0"), ActionInputError);
  assert.throws(() => parseSol("1e-3"), ActionInputError);
  assert.throws(() => parseSol("1.0000000001"), ActionInputError);
  assert.throws(() => parseSol("11", "10"), ActionInputError);
});

test("metadata uses HTTPS-ready action URL and input amount", () => {
  const metadata = buildActionMetadata(settings);
  assert.equal(metadata.type, "action");
  assert.equal(metadata.links.actions[0].href, "https://example.test/api/action?amount={amount}&invoice={invoice}");
  assert.equal(metadata.links.actions[0].parameters[0].name, "amount");
  assert.equal(buildActionsJson().rules[0].apiPath, "/api/action");
  assert.equal(corsHeaders()["Access-Control-Allow-Origin"], "*");
});

test("creates an unsigned transfer to configured recipient for the requested amount", async () => {
  const response = await createUnsignedTransfer({
    account: payer.toBase58(), amountText: "0.125", invoice: "inv_12345678", settings,
    connection: { getLatestBlockhash: async () => ({ blockhash: payer.toBase58() }) },
  });
  assert.match(response.transaction, /^[A-Za-z0-9+/]+=*$/);
  assert.match(response.message, /0\.125 SOL/);
  assert.match(response.message, /inv_12345678/);
  assert.match(response.message, new RegExp(wallet.toBase58()));
  const tx = Transaction.from(Buffer.from(response.transaction, "base64"));
  assert.equal(tx.feePayer.toBase58(), payer.toBase58());
  assert.equal(tx.instructions.length, 2);
  assert.equal(tx.instructions[0].keys[0].pubkey.toBase58(), payer.toBase58());
  assert.equal(tx.instructions[0].keys[1].pubkey.toBase58(), wallet.toBase58());
  assert.equal(tx.instructions[0].data.readBigUInt64LE(4), 125_000_000n);
  assert.equal(tx.instructions[1].programId.toBase58(), "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
  assert.equal(tx.instructions[1].data.toString(), "blink-merchant:inv_12345678");
});

test("rejects invalid payer and self-payment", async () => {
  const connection = { getLatestBlockhash: async () => ({ blockhash: payer.toBase58() }) };
  await assert.rejects(createUnsignedTransfer({ account: "bad", amountText: "0.01", invoice: "inv_12345678", settings, connection }), ActionInputError);
  await assert.rejects(createUnsignedTransfer({ account: wallet.toBase58(), amountText: "0.01", invoice: "inv_12345678", settings, connection }), ActionInputError);
  await assert.rejects(createUnsignedTransfer({ account: payer.toBase58(), amountText: "0.01", invoice: "bad", settings, connection }), ActionInputError);
});

test("verifies only finalized matching invoice payments", async () => {
  const signature = bs58.encode(Buffer.alloc(64, 7));
  const parsedTransaction = {
    transaction: { message: { instructions: [
      { program: "system", programId: SystemProgram.programId, parsed: { type: "transfer", info: { source: payer.toBase58(), destination: wallet.toBase58(), lamports: "10000000" } } },
      { program: "spl-memo", programId: new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"), parsed: "blink-merchant:inv_12345678" },
    ] } },
    meta: { err: null, innerInstructions: [] },
  };
  const args = { invoice: "inv_12345678", amountText: "0.01", signature, settings, parsedTransaction, signatureStatus: { confirmationStatus: "finalized", err: null } };
  assert.equal(verifyInvoicePayment(args).paid, true);
  assert.equal(verifyInvoicePayment({ ...args, invoice: "inv_different" }).state, "unmatched");
  assert.equal(verifyInvoicePayment({ ...args, amountText: "0.02" }).state, "unmatched");
  assert.equal(verifyInvoicePayment({ ...args, parsedTransaction: { ...parsedTransaction, transaction: { message: { instructions: [...parsedTransaction.transaction.message.instructions, { program: "memo", programId: new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"), parsed: "extra" }] } } } }).state, "unmatched");
  assert.equal(verifyInvoicePayment({ ...args, signatureStatus: { confirmationStatus: "confirmed", err: null } }).state, "pending");
  assert.equal(verifyInvoicePayment({ ...args, signatureStatus: { confirmationStatus: "finalized", err: { InstructionError: [0, "error"] } } }).state, "failed");
});

import { verifyInvoicePayment } from "../src/action.mjs";

test("requires a valid public recipient configuration", () => {
  assert.throws(() => readSettings({}), /RECIPIENT_WALLET/);
  assert.throws(() => readSettings({ RECIPIENT_WALLET: "not-a-wallet" }), /valid Solana public address/);
});
