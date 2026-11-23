import {
  Connection,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import bs58 from "bs58";

const MEMO_PROGRAM = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");

export class ActionInputError extends Error {}

export function readSettings(env = process.env) {
  const demoMode = env.DEMO_MODE === "true";
  const recipient = env.RECIPIENT_WALLET?.trim();
  if (!recipient && !demoMode) throw new ActionInputError("Set RECIPIENT_WALLET to a public Solana address.");

  let recipientKey;
  if (recipient) {
    try {
      recipientKey = new PublicKey(recipient);
    } catch {
      throw new ActionInputError("RECIPIENT_WALLET is not a valid Solana public address.");
    }
  }

  const amount = env.DEFAULT_AMOUNT_SOL || "0.01";
  const maxAmount = env.MAX_AMOUNT_SOL || "10";
  const publicUrl = (env.PUBLIC_URL || "http://localhost:3000").replace(/\/$/, "");
  let parsedPublicUrl;
  try { parsedPublicUrl = new URL(publicUrl); }
  catch { throw new ActionInputError("PUBLIC_URL must be a valid HTTP or HTTPS origin."); }
  if (!/^https?:$/.test(parsedPublicUrl.protocol) || parsedPublicUrl.pathname !== "/" || parsedPublicUrl.search || parsedPublicUrl.hash) {
    throw new ActionInputError("PUBLIC_URL must be an origin only, without a path, query, or fragment.");
  }
  const cluster = env.SOLANA_CLUSTER || "mainnet-beta";
  if (!["mainnet-beta", "devnet", "testnet"].includes(cluster)) throw new ActionInputError("SOLANA_CLUSTER must be mainnet-beta, devnet, or testnet.");
  return {
    recipient: recipientKey || null,
    recipientText: recipientKey?.toBase58() || "DEMO MODE — платежи отключены",
    defaultAmount: parseSol(amount, maxAmount),
    maxAmount: parseSol(maxAmount, "1000000"),
    appName: (env.APP_NAME?.trim() || "Solana Merchant Desk").slice(0, 64),
    description: (env.APP_DESCRIPTION?.trim() || "Create Solana payment links with invoice references and verify finalized payments.").slice(0, 200),
    publicUrl,
    cluster,
    demoMode,
    rpcUrl: env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com",
  };
}

export function parseSol(input, maximum = "10") {
  const toLamports = (value) => {
    if (typeof value !== "string" || !/^\d+(?:\.\d{1,9})?$/.test(value)) {
      throw new ActionInputError("Enter a positive SOL amount with up to 9 decimal places.");
    }
    const [whole, fraction = ""] = value.split(".");
    return BigInt(whole) * BigInt(LAMPORTS_PER_SOL) + BigInt((fraction + "0".repeat(9)).slice(0, 9));
  };
  const lamports = toLamports(input);
  const cap = toLamports(maximum);
  if (lamports <= 0n) throw new ActionInputError("Amount must be greater than zero.");
  if (lamports > cap) throw new ActionInputError(`Amount exceeds the configured maximum of ${maximum} SOL.`);
  if (lamports > BigInt(Number.MAX_SAFE_INTEGER)) throw new ActionInputError("Amount is too large.");
  return { text: input, lamports: Number(lamports) };
}

export function buildActionMetadata(settings, preset = {}) {
  const metadata = {
    type: "action",
    icon: `${settings.publicUrl}/icon.svg`,
    title: settings.appName,
    description: preset.amount && preset.invoice
      ? `Invoice ${preset.invoice}: pay ${preset.amount} SOL to ${settings.recipientText}. Review the recipient and amount in your wallet before approving.`
      : settings.description,
    label: preset.amount && preset.invoice ? `Pay ${preset.amount} SOL` : "Pay invoice",
    disabled: false,
  };
  if (!(preset.amount && preset.invoice)) metadata.links = {
    actions: [{
        label: "Create payment",
        href: `${settings.publicUrl}/api/action?amount={amount}&invoice={invoice}`,
        parameters: [
          { name: "amount", label: "SOL amount", required: true },
          { name: "invoice", label: "Invoice reference", required: true },
        ],
    }],
  };
  return metadata;
}

export function buildActionsJson() {
  return { rules: [{ pathPattern: "/api/action", apiPath: "/api/action" }] };
}

export function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,PUT,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, Content-Encoding, Accept-Encoding",
    "Access-Control-Max-Age": "86400",
  };
}

export async function createUnsignedTransfer({ account, amountText, invoice, settings, connection }) {
  let payer;
  try {
    payer = new PublicKey(account);
  } catch {
    throw new ActionInputError("The wallet address sent by the client is invalid.");
  }
  if (payer.toBase58() !== account) throw new ActionInputError("The wallet address must be base58 encoded.");
  if (typeof invoice !== "string" || !/^[a-zA-Z0-9_-]{8,64}$/.test(invoice)) {
    throw new ActionInputError("Invoice reference must contain 8–64 letters, digits, underscores, or hyphens.");
  }

  const amount = parseSol(amountText || settings.defaultAmount.text, String(settings.maxAmount.lamports / LAMPORTS_PER_SOL));
  if (payer.equals(settings.recipient)) throw new ActionInputError("Sender and recipient wallet must be different.");

  const { blockhash } = await connection.getLatestBlockhash("confirmed");
  const transaction = new Transaction({ feePayer: payer, recentBlockhash: blockhash })
    .add(SystemProgram.transfer({ fromPubkey: payer, toPubkey: settings.recipient, lamports: amount.lamports }))
    .add(new TransactionInstruction({ programId: MEMO_PROGRAM, keys: [], data: Buffer.from(`blink-merchant:${invoice}`, "utf8") }));
  return {
    transaction: transaction.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64"),
    message: `Invoice ${invoice}: transfer ${amount.text} SOL to ${settings.recipientText}. Review and approve in your wallet.`,
  };
}

export function verifyInvoicePayment({ invoice, amountText, signature, settings, parsedTransaction, signatureStatus }) {
  if (typeof invoice !== "string" || !/^[a-zA-Z0-9_-]{8,64}$/.test(invoice)) throw new ActionInputError("Invalid invoice reference.");
  const expectedAmount = parseSol(amountText, String(settings.maxAmount.lamports / LAMPORTS_PER_SOL));
  let signatureBytes;
  try { signatureBytes = bs58.decode(signature || ""); } catch { throw new ActionInputError("Enter a valid Solana transaction signature."); }
  if (signatureBytes.length !== 64) throw new ActionInputError("Enter a valid Solana transaction signature.");
  if (!signatureStatus || !["confirmed", "finalized"].includes(signatureStatus.confirmationStatus)) {
    return { paid: false, state: "pending", message: "No confirmed transaction found yet. Wait for confirmation and check again." };
  }
  if (signatureStatus.err) return { paid: false, state: "failed", message: "The transaction failed on-chain." };
  if (!parsedTransaction) return { paid: false, state: "pending", message: "Transaction is not available from the RPC yet. Try again shortly." };
  if (parsedTransaction.meta?.err) return { paid: false, state: "failed", message: "The transaction failed on-chain." };
  if (signatureStatus.confirmationStatus !== "finalized") {
    return { paid: false, state: "pending", message: "Transaction is confirmed but not finalized yet. Check again shortly." };
  }

  const topLevelInstructions = parsedTransaction.transaction?.message?.instructions || [];
  const innerInstructions = parsedTransaction.meta?.innerInstructions || [];
  if (topLevelInstructions.length !== 2 || innerInstructions.some((group) => (group.instructions || []).length > 0)) {
    return { paid: false, state: "unmatched", message: "The transaction contains extra instructions and cannot be matched safely to this invoice." };
  }
  const instructions = topLevelInstructions;
  const memos = instructions.map((ix) => {
    if (ix.program === "spl-memo" || ix.program === "spl-memo-v2") {
      if (typeof ix.parsed === "string") return ix.parsed;
      if (typeof ix.parsed?.info === "string") return ix.parsed.info;
    }
    return decodeMemoInstruction(ix);
  }).filter(Boolean);
  if (memos.length !== 1 || memos[0] !== `blink-merchant:${invoice}`) {
    return { paid: false, state: "unmatched", message: "The transaction does not contain this invoice reference." };
  }

  let received = 0n;
  let transferCount = 0;
  for (const ix of instructions) {
    if (ix.programId?.toBase58?.() !== SystemProgram.programId.toBase58()) continue;
    try {
      if (ix.program === "system" && ix.parsed?.type === "transfer") {
        transferCount += 1;
        if (ix.parsed.info.destination === settings.recipientText) received += BigInt(ix.parsed.info.lamports);
        continue;
      }
      const decoded = SystemProgram.decodeInstructionType(ix);
      if (decoded !== "Transfer") continue;
      const info = SystemProgram.decodeTransfer(ix);
      transferCount += 1;
      if (info.toPubkey.equals(settings.recipient)) received += BigInt(info.lamports);
    } catch { /* Ignore unrelated or malformed System Program instructions. */ }
  }
  if (transferCount !== 1 || received !== BigInt(expectedAmount.lamports)) {
    return { paid: false, state: "unmatched", message: "The confirmed transaction amount or recipient does not match this invoice." };
  }
  return { paid: true, state: "paid", message: `Payment verified: ${expectedAmount.text} SOL received for invoice ${invoice}.` };
}

export function decodeMemoInstruction(instruction) {
  if (instruction?.programId?.toBase58?.() !== MEMO_PROGRAM.toBase58()) return null;
  try { return Buffer.from(bs58.decode(instruction.data)).toString("utf8"); } catch { return null; }
}

export function createConnection(settings) {
  return new Connection(settings.rpcUrl, "confirmed");
}
