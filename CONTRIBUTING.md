# Contributing

Keep changes focused on the small merchant workflow. Before opening a pull request:

1. Explain the user problem and the behavior being changed.
2. Run `npm run check` and include the result.
3. Never include private keys, seed phrases, RPC credentials, personal data, or real customer invoices.
4. For payment changes, include tests for destination, amount, invoice reference, and failure/pending states.
5. Do not add telemetry, platform fees, or external storage without documenting them clearly and obtaining explicit maintainer review.

## Security reports

Do not post exploitable vulnerabilities or private customer data in a public issue. Contact the maintainer through the public profile linked in the README and share only the minimum details needed to reproduce.
