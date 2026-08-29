# Anonymous Usage Metrics API

Small Go service for aggregate automation usage. It stores only a random install UUID and automation timing.

## Privacy

We do not collect your browser activity, websites or URLs, automation prompts, page content, cookies, screenshots, or automation data. We collect a randomly generated installation identifier and automation timing to measure aggregate product usage.

The API does not authenticate users. UUIDs are not login credentials.

## What is stored

| Collection | When |
| --- | --- |
| `installations/{uuid}` | Created by `POST /v1/install`. Last run also stores `lastStartedAt` / `lastEndedAt`. |
| `anonymous/{uuid}` | Used when an automation UUID is not in `installations` |
| `events/{eventId}` | One row per automation: `uuid`, `startedAt`, `endedAt`, `durationSeconds`. Also used so retries are not counted twice. |

## API

### `GET /health`

Does not call Firestore.

```json
{"status": "ok"}
```

### `POST /v1/install`

No body. Server creates a UUID v4.

`201 Created`

```json
{"uuid": "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx"}
```

### `POST /v1/automation`

```json
{
  "eventId": "unique-event-uuid",
  "uuid": "installation-uuid",
  "startedAt": "2026-08-29T10:00:00Z",
  "endedAt": "2026-08-29T10:15:00Z"
}
```

`200 OK`

```json
{"accepted": true}
```

Retry with the same `eventId`:

```json
{"accepted": true, "duplicate": true}
```

Duration is computed on the server. Client duration is ignored.

Limits:

- Duration: 1 second to 24 hours
- Body: 16 KB max
- Unknown JSON fields are rejected

Errors:

```json
{
  "error": {
    "code": "INVALID_REQUEST",
    "message": "Invalid automation timestamps."
  }
}
```

Codes: `INVALID_REQUEST` (400), `RATE_LIMITED` (429), `INTERNAL_ERROR` (500), `UNAVAILABLE` (503).

## Local run

```bash
go test ./...
export GOOGLE_CLOUD_PROJECT=your-project
export FIRESTORE_EMULATOR_HOST=localhost:8080
go run ./cmd/server
```

## Cloud Run

The container uses the Cloud Run service account. Do not put GCP keys in the app or image.

```bash
gcloud run deploy usage-metrics \
  --source . \
  --region YOUR_REGION \
  --set-env-vars GOOGLE_CLOUD_PROJECT=your-project
```

Grant the service account Firestore access (least privilege). Set a 30-day TTL on `events.createdAt` if you want old event IDs deleted.

## Environment

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `8080` | Listen port (Cloud Run sets this) |
| `GOOGLE_CLOUD_PROJECT` | empty | GCP project |
| `FIRESTORE_DATABASE` | `(default)` | Firestore database |
| `CORS_ORIGINS` | empty | Comma-separated allowed origins |
| `MAX_BODY_BYTES` | `16384` | Max request size |
| `MIN_DURATION_SECONDS` | `1` | Min automation length |
| `MAX_DURATION_SECONDS` | `86400` | Max automation length |
| `INSTALL_RATE_LIMIT` | `10` | Installs per window per IP |
| `AUTOMATION_RATE_LIMIT_IP` | `60` | Automations per window per IP |
| `AUTOMATION_RATE_LIMIT_UUID` | `60` | Automations per window per UUID |

IP addresses are used only in memory for rate limits. They are not stored as usage data.

## Metrics language

Do not call UUID counts "authenticated users". Use unique installations, anonymous users, active installations, automation hours, completed automations.
