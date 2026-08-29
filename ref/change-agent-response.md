# Agent stream: session + screenshot name on every event

UI note: `POST /v1/agent` NDJSON events now include the same data as `GET /v1/session` and `GET /v1/screenshot`.

Existing fields are unchanged. `done` still has `browserOpen` and `sessionReset`.

## Request

```http
POST /v1/agent
Authorization: Bearer <API_TOKEN>
Content-Type: application/json

{"task":"go to https://example.com and check the page loads","model":"gemini-3.6-flash"}
```

```bash
curl -N http://127.0.0.1:18732/v1/agent \
  -H "Authorization: Bearer $API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"task":"go to https://example.com and check the page loads","model":"gemini-3.6-flash"}'
```

## Response

HTTP `200`. Body is **NDJSON**: one JSON object per line.

```
Content-Type: application/x-ndjson; charset=utf-8
```

Every event includes:

```json
{
  "session": { "open": true, "url": "https://example.com/" },
  "screenshot": { "imageName": "2026-08-27T09-49-04-485Z-0005-scroll.webp" }
}
```

- Same shape as `GET /v1/session` (`open`, `url`) and `GET /v1/screenshot` (`imageName`).
- Snapshot is taken **when that event is written** (intent/safety may show the previous page).
- No screenshot yet → `"imageName": ""`.
- Browser closed → `"open": false`, `"url": ""`.
- `imageName` is the file name under `processed/` (not base64).

## Event examples

### `intent`

```json
{
  "type": "intent",
  "label": "navigate — open site",
  "session": { "open": true, "url": "https://example.com/" },
  "screenshot": { "imageName": "2026-08-27T09-48-52-531Z-0003-scroll.webp" }
}
```

### `safety_confirm`

Stream pauses until the UI posts to `/v1/agent/safety`.

```json
{
  "type": "safety_confirm",
  "id": "6f1c2e3a-9b4d-4c11-8a22-1d2e3f4a5b6c",
  "action": "click",
  "explanation": "This may complete a purchase",
  "session": { "open": true, "url": "https://example.com/checkout" },
  "screenshot": { "imageName": "2026-08-27T09-49-04-485Z-0005-scroll.webp" }
}
```

Confirm:

```http
POST /v1/agent/safety
Authorization: Bearer <API_TOKEN>
Content-Type: application/json

{"id":"6f1c2e3a-9b4d-4c11-8a22-1d2e3f4a5b6c","confirmed":true}
```

Response (JSON, not NDJSON):

```json
{ "ok": true }
```

Then the agent stream continues.

### `done`

```json
{
  "type": "done",
  "text": "Checkout page loaded. Buy button is visible.",
  "sessionReset": false,
  "browserOpen": true,
  "costUsd": 0.000093,
  "session": { "open": true, "url": "https://example.com/checkout" },
  "screenshot": { "imageName": "2026-08-27T09-49-14-479Z-0006-scroll.webp" }
}
```

### `error`

Still HTTP `200`. Failure is an `error` event in the stream.

```json
{
  "type": "error",
  "error": "Gemini interaction failed",
  "costUsd": 0.000093,
  "session": { "open": true, "url": "https://example.com/" },
  "screenshot": { "imageName": "2026-08-27T09-49-04-485Z-0005-scroll.webp" }
}
```

## Full stream (success)

```ndjson
{"type":"intent","label":"navigate — open site","session":{"open":true,"url":"https://example.com/"},"screenshot":{"imageName":"2026-08-27T09-48-52-531Z-0003-scroll.webp"}}
{"type":"intent","label":"click — submit","session":{"open":true,"url":"https://example.com/checkout"},"screenshot":{"imageName":"2026-08-27T09-49-04-485Z-0005-scroll.webp"}}
{"type":"safety_confirm","id":"6f1c2e3a-9b4d-4c11-8a22-1d2e3f4a5b6c","action":"click","explanation":"This may complete a purchase","session":{"open":true,"url":"https://example.com/checkout"},"screenshot":{"imageName":"2026-08-27T09-49-04-485Z-0005-scroll.webp"}}
{"type":"done","text":"Checkout page loaded. Buy button is visible.","sessionReset":false,"browserOpen":true,"costUsd":0.000093,"session":{"open":true,"url":"https://example.com/checkout"},"screenshot":{"imageName":"2026-08-27T09-49-14-479Z-0006-scroll.webp"}}
```

## UI notes

- Keep reading the stream. Do not treat HTTP 200 as success until you see `done` or `error`.
- You can render `session` and `screenshot.imageName` from each event. Separate `GET /v1/session` and `GET /v1/screenshot` are optional now for live agent runs.
- `imageName` is a webp file name, not image bytes.
