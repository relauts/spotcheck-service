# Contributing

PRs are welcome.

## Setup

See [README.md](README.md). You need Node.js `>=18.18.0`.

```bash
npm install
npx playwright install chromium
cp relauts-spotcheck-service-config.example.json ../relauts-spotcheck-service-config.json
```

Put real `apiToken` and `geminiApiKey` in the sibling config file, not in this repo.

## Checks

```bash
npm test
npm run typecheck
```

## Pull requests

- Open an issue first for large changes
- One change per PR
- Add or update tests
- Do not commit real secrets or `relauts-spotcheck-service-config.json`

## Code

- TypeScript, strict mode
- Match the existing style
- Avoid new dependencies unless they are needed

API shape is documented in [openapi.yaml](openapi.yaml). Update it when you change `/v1` routes.

## License

This project is AGPL-3.0-or-later. By sending a PR, you license your change under the same license.
