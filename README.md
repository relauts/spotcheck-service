# @relauts/spotcheck-service

Local HTTP API that runs a Gemini computer-use agent in a Playwright Chromium session.

No UI. The server always binds to `127.0.0.1`. Callers send a Bearer token. You can save flows, replay them, and read run history.

License: AGPL-3.0-or-later. See [LICENSE](LICENSE) and [NOTICE](NOTICE).

## Requirements

- Node.js `>=18.18.0`
- Chromium for Playwright: `npx playwright install chromium`

## Setup

Config is a JSON file **next to this repo**, not inside it:

```
parent/
  relauts-spotcheck-service/
  relauts-spotcheck-service-config.json
```

```bash
cp relauts-spotcheck-service-config.example.json ../relauts-spotcheck-service-config.json
```

Set at least `apiToken` and `geminiApiKey` in that sibling file. Do not commit the sibling file. It holds secrets.

A dummy template lives in this repo: [relauts-spotcheck-service-config.example.json](relauts-spotcheck-service-config.example.json).

## Run

```bash
npm install
npx playwright install chromium
npm run dev
```

Or:

```bash
npm start
```

The service listens on `http://127.0.0.1:18732` by default.

CLI after build: `spotcheck-service`.

## Auth

All `/v1/*` routes require:

```http
Authorization: Bearer <apiToken>
```

Exception: `GET /v1/health` (no auth).

Token compare uses SHA-256 digests + `timingSafeEqual`.

## Endpoints

| Method | Path | Auth | Body / notes |
|---|---|---|---|
| `GET` | `/v1/health` | no | `{ "ok": true }` |
| `GET` | `/v1/models` | yes | model list from `files/model.json` |
| `POST` | `/v1/agent` | yes | `{ "task", "model" }` → NDJSON stream |
| `POST` | `/v1/agent/safety` | yes | `{ "id", "confirmed" }` |
| `GET` | `/v1/session` | yes | `{ "open", "url" }` |
| `POST` | `/v1/session/back` | yes | navigate back |
| `POST` | `/v1/session/forward` | yes | navigate forward |
| `POST` | `/v1/session/reload` | yes | reload |
| `GET` | `/v1/screenshot` | yes | `{ "imageName": "..." }` |
| `GET` | `/v1/saved` | yes | `{ "files": [...] }` |
| `GET` | `/v1/saved/running` | yes | `{ "files": [...] }` currently running saved runs |
| `POST` | `/v1/saved` | yes | `{ "fileName", "items" }` |
| `GET` | `/v1/saved/:fileName` | yes | saved flow |
| `PUT` | `/v1/saved/:fileName` | yes | `{ "items" }` |
| `DELETE` | `/v1/saved/:fileName` | yes | delete |
| `GET` | `/v1/saved/create-default.json` | yes | create-tab default |
| `PUT` | `/v1/saved/create-default.json` | yes | `{ "items" }` |
| `GET` | `/v1/history` | yes | `{ "runs": [{ "historyFile", "status" }] }` all history runs |
| `POST` | `/v1/history/detail` | yes | `{ "historyFile" }` prompts, results, models, screenshots |
| `POST` | `/v1/saved/run` | yes | `{ "fileName" }` start a saved run |
| `POST` | `/v1/history/status` | yes | `{ "fileName" }` latest run status |
| `POST` | `/v1/history/stop` | yes | `{ "fileName" }` stop latest run |

Errors: `{ "error": "message" }` with HTTP status.

Agent NDJSON events match the original Spotcheck UI contract (`intent`, `safety_confirm`, `done`, `error`).

Full request and response shapes: [openapi.yaml](openapi.yaml).

## Curl examples

Health:

```bash
curl -s http://127.0.0.1:18732/v1/health
```

Models:

```bash
curl -s http://127.0.0.1:18732/v1/models \
  -H "Authorization: Bearer <apiToken>"
```

Screenshot:

```bash
curl -s http://127.0.0.1:18732/v1/screenshot \
  -H "Authorization: Bearer <apiToken>"
```

Run agent:

```bash
curl -N http://127.0.0.1:18732/v1/agent \
  -H "Authorization: Bearer <apiToken>" \
  -H "Content-Type: application/json" \
  -d '{"task":"go to https://example.com and check the page loads","model":"gemini-3.6-flash"}'
```

## CORS

Set `corsOrigins` in the sibling JSON to an allow list. No credentials. Preflight: `OPTIONS`.

## Develop

```bash
npm test
npm run typecheck
```

How to send a PR: [CONTRIBUTING.md](CONTRIBUTING.md).

This git repo is the source. The npm package is marked `private` and is not published to the public registry.

Local run data (`saved/`, `processed/`, `history/`) stays on disk and is gitignored.

## License

Spotcheck is free software: you can redistribute it and/or modify it under
the terms of the GNU Affero General Public License as published by the
Free Software Foundation, either version 3 of the License, or (at your
option) any later version.

See `LICENSE` and `NOTICE`.

The names Relauts and Spotcheck are trademarks of Relauts Pvt. Ltd.
