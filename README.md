# Solana Merchant Desk

**Open-source, non-custodial Solana checkout for small sellers.** Create SOL payment links with a unique invoice memo, let the buyer approve the transfer in their wallet, and verify the finalized transaction against the exact invoice, amount, and merchant address.

This project targets one practical workflow: a seller needs a simple payment request and a reliable way to distinguish a real, matching on-chain payment from a screenshot or an unrelated transfer. It is a lightweight starter, not a hosted payment processor or accounting product.

## What it does

- Creates shareable `solana-action:` payment links and Solana Actions metadata.
- Generates a downloadable, self-hosted QR code for each unique payment link (no external QR service).
- Returns an **unsigned** SOL transfer plus a unique invoice Memo. The buyer's wallet remains responsible for review, signing, fees, and submission.
- Verifies transaction signature, successful execution, exact recipient, exact SOL amount, invoice Memo, and `finalized` commitment before marking an invoice paid. It also rejects extra top-level instructions and any inner instructions.
- Saves the invoice list only in the seller's browser and exports it to CSV.
- Installs as a small PWA. Static screens can be cached for offline access; creating links and checking payments require the server and Solana RPC.
- Has no user accounts, database, file uploads, custody, or platform fee.

## Requirements

- Node.js 20 or newer.
- A public merchant wallet address (public address only; never a seed phrase or private key).
- A Solana RPC URL. The public Mainnet RPC is used by default but is rate-limited and has no production SLA. Configure a provider you control for reliable use.
- A Node.js host that can run the included server or Docker container. GitHub stores the source; GitHub Pages alone cannot run this API.

The app includes a **read-only demo mode** for public previews. Run `npm run preview` or set `DEMO_MODE=true` when starting the server to serve the interface without enabling invoice creation, QR generation, transaction building, or payment verification. This is suitable for a preview deployment; it is not a payment environment.

## Quick start (Mainnet default)

```bash
cp .env.example .env
# Edit .env and set RECIPIENT_WALLET to the merchant's receiving address.
npm ci
npm start
```

On Windows PowerShell:

```powershell
Copy-Item .env.example .env
notepad .env
npm ci
npm start
```

Open `http://localhost:3000`. Set `RECIPIENT_WALLET` before starting. The example deliberately contains a placeholder and the server will refuse to start until it is replaced with a valid merchant public key.

## Configuration

| Variable | Required | Purpose |
|---|---:|---|
| `RECIPIENT_WALLET` | Yes | Merchant's public receiving address. Must be a valid Solana public key. |
| `SOLANA_RPC_URL` | No | RPC endpoint. Defaults to `https://api.mainnet-beta.solana.com`; use a dedicated endpoint in production. |
| `SOLANA_CLUSTER` | No | Display label and explorer cluster; defaults to `mainnet-beta`. Use `devnet` only for test deployments. |
| `PUBLIC_URL` | Production | Canonical public HTTPS URL, without trailing slash. Used by Actions metadata. |
| `APP_NAME` | No | Action title. |
| `APP_DESCRIPTION` | No | Action description. |
| `DEFAULT_AMOUNT_SOL` | No | Prefilled amount; defaults to `0.01`. |
| `MAX_AMOUNT_SOL` | No | Server-enforced maximum amount; defaults to `10`. |
| `PORT` | No | HTTP listen port; defaults to `3000`. |
| `DEMO_MODE` | No | Set `true` for a public UI preview with all payment APIs disabled. Do not use it for merchant checkout. |

All amounts are native SOL, limited to nine decimal places. The platform never takes a fee. The receiving wallet may be different from the developer's voluntary support address on the About page.

## Verify before mainnet launch

1. Set the merchant address and verify it character by character in a trusted wallet.
2. Set `SOLANA_RPC_URL` to a production RPC endpoint and `PUBLIC_URL` to the final HTTPS domain.
3. Visit `/healthz`, `/actions.json`, and `/api/action`. Confirm `actions.json` and Action endpoints return `Access-Control-Allow-Origin: *`.
4. Create one small invoice and inspect the generated transfer in a wallet. Confirm destination, amount, and invoice memo before signing.
5. After sending, copy the transaction signature and verify it. It should only show **Оплачен** when the transaction is successful, finalized, and matches the invoice and recipient exactly.
6. Export CSV, check the entries, install the PWA on a phone, and verify layout/navigation at mobile width.
7. Try malformed amounts, an invalid signature, a signature for another invoice, a wrong amount, and a pending/unconfirmed transaction.

The built-in tests use mocked transaction/RPC data and do not send real transactions. They validate protocol handling, not live wallet compatibility or Mainnet settlement. Never test by sending a transaction you cannot afford to lose.

## Endpoints

- `GET|OPTIONS /api/action` — Actions metadata with amount and invoice inputs.
- `GET|OPTIONS /api/action?amount=...&invoice=...` — metadata for a specific invoice link.
- `POST /api/action?amount=...&invoice=...` — returns an unsigned base64 transaction to be reviewed and signed by the wallet.
- `POST|OPTIONS /api/verify` — checks the transaction signature and invoice match against the configured RPC.
- `GET /actions.json` — maps `/api/action` for Actions clients.
- `GET /healthz` — process health and configured cluster label; does not perform a chain check.

## Deployment

Build and run the included container on a Node/Docker host:

```bash
docker build -t solana-merchant-desk .
docker run --rm -p 3000:3000 \
  -e RECIPIENT_WALLET=YOUR_MERCHANT_PUBLIC_KEY \
  -e SOLANA_RPC_URL=YOUR_MAINNET_RPC_URL \
  -e SOLANA_CLUSTER=mainnet-beta \
  -e PUBLIC_URL=https://your-domain.example \
  solana-merchant-desk
```

Store these values in the hosting provider's secret/environment settings. `RECIPIENT_WALLET`, RPC URLs, and `PUBLIC_URL` are configuration, but never put a private key or seed phrase into the app. Use HTTPS. GitHub Pages serves static files only and cannot run the transaction-building/verifying server.

For a non-payment preview, deploy the same container with `DEMO_MODE=true`, `NODE_ENV=production`, and `PUBLIC_URL` set to the deployment's HTTPS origin. Do not set a merchant address for a demo deployment. The UI will load, while payment APIs return `503` and cannot create or verify transactions. The included `preview.mjs` can also be used as a host start command (`node preview.mjs`).

## Data and security boundaries

- No wallet connection or signature is requested by the website itself. The wallet or Blink client displays and authorizes each transfer.
- The server creates only unsigned transactions. It never receives secret keys or signs payments.
- Invoice records and transaction signatures are stored in the browser's local storage. Clearing browser data or changing devices loses this local list; export backups regularly.
- Payment URLs can be paid more than once. The app does not reserve funds, enforce one-time checkout, issue refunds, or synchronize invoices across staff devices.
- Payment verification waits for `finalized`; that is safer for settlement but can take longer than the initial wallet confirmation.
- RPC providers can rate-limit, fail, or return delayed history. A successful `/healthz` response does not mean the Solana RPC is healthy.
- A small in-memory per-IP request throttle is included. It is not distributed abuse protection; add an edge/WAF rate limit before a high-traffic public launch.
- The transaction and invoice memo are public on-chain. Do not place names, email addresses, order details, or other personal information in an invoice reference.
- The app is not an auditor, tax ledger, or guarantee against wallet warnings, malicious links, or compromised devices. Buyers should check the wallet's transaction preview.

## Local development and tests

```bash
npm ci
npm test
npm run check
```

Tests cover SOL decimal conversion and limits, metadata/CORS, the exact unsigned transfer and memo, invalid configuration, and finalized-payment matching. No real wallet is needed for unit tests.

## Support and attribution

Created by **Kaiser Azimuth** · [X @Kaiser_Azimuth](https://x.com/Kaiser_Azimuth)

Voluntary Solana Mainnet support: `9o7hmfqRusxnNj5Ssx9sCmQ52jaDq1NcqAtggK2n6jYu`

Support is optional and separate from merchant checkout. The MIT license allows reuse and modification.

## License

MIT. See [LICENSE](LICENSE).
