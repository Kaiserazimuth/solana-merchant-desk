# Security policy

## Scope

This project prepares unsigned native-SOL payment transactions and checks invoice payment evidence against a configured Solana RPC. It does not custody funds, hold signing keys, or promise protection from compromised wallets, browsers, or RPC providers.

## Safe handling

- Never provide a seed phrase or private key to this project.
- Verify the destination and amount in the wallet before signing.
- Do not put personal information in an invoice memo; on-chain data is public.
- Use HTTPS and a reputable Mainnet RPC endpoint in production.
- Keep RPC credentials out of Git and public client code. The included server reads RPC configuration server-side.
- Use a trusted reverse proxy before setting `TRUST_PROXY=true`; it must replace/normalize `X-Forwarded-For`.

## Reporting

For an exploitable issue, contact the maintainer through [X @Kaiser_Azimuth](https://x.com/Kaiser_Azimuth). Do not publish private keys, customer data, or a working exploit in a public issue.
