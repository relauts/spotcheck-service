# History list and detail API (for UI)

Past **saved-run** results on disk. Use this for a history page, not for live polling while a run is in progress.

For start / poll / stop a run, see [saved-run.md](saved-run.md).

- No NDJSON.
- Names with spaces are fine, for example `END TO END - 01-2026-08-27T15-00-00-000Z.json`.
- Put names in the **JSON body**. Do not put them in the URL.

Base URL: `http://127.0.0.1:18732`

---

## What the UI should do

1. Call `GET /v1/history`.
2. Show each row: `historyFile` + `status` (`running`, `done`, `error`, `stopped`).
3. User taps a row.
4. Call `POST /v1/history/detail` with that row’s **`historyFile`**.
5. Show each question: `sequence`, `prompt`, `model`, `resultText`.
6. Show that question’s images: UI screenshot base + each path in `screenshots`.

Do **not** send the saved flow name (`login-flow.json`) to detail. Send the timestamped **`historyFile`**.

Do **not** use `POST /v1/history/status` for this page. Status is the **latest** run of one saved file, for live polling.

---

## Auth

List needs the Bearer token only:

```http
Authorization: Bearer <API_TOKEN>
```

Detail also needs JSON:

```http
Authorization: Bearer <API_TOKEN>
Content-Type: application/json
```

---

## Endpoints

| Method | Path | Body | Success |
|---|---|---|---|
| `GET` | `/v1/history` | — | **200** `{ "runs": [{ "historyFile", "status" }] }` |
| `POST` | `/v1/history/detail` | `{ "historyFile" }` | **200** prompts, results, models, screenshot paths |

---

## 1. List

All history files on disk. Newest first. Empty folder is `{ "runs": [] }`. Bad JSON files are skipped.

`status` is `running`, `done`, `error`, or `stopped`. Crash leftovers that still say `"running"` are included.

Each row is **`historyFile` + `status` only**. No saved flow name. No prompts. No pass count.

### Request

```http
GET /v1/history
Authorization: Bearer <API_TOKEN>
```

```bash
curl -s http://127.0.0.1:18732/v1/history \
  -H "Authorization: Bearer $API_TOKEN"
```

### Response (200)

```json
{
  "runs": [
    { "historyFile": "END TO END - 01-2026-08-27T15-00-00-000Z.json", "status": "done" },
    { "historyFile": "login-flow-2026-08-27T14-00-00-000Z.json", "status": "error" }
  ]
}
```

Empty:

```json
{ "runs": [] }
```

This is not `GET /v1/saved` (saved templates).  
This is not `GET /v1/saved/running` (in-memory, currently running only).  
This is not `POST /v1/history/status` (latest run of one saved `fileName`).

---

## 2. Detail

One history file. Body uses **`historyFile`** from the list.

All questions are included (pending, skipped, done, error).  
`resultText` is omitted when missing (not `null`).  
`screenshots` is `[]` when that question has no shots.

`resultText` is the agent’s answer text, not pass/fail.

Missing file → **404**. Bad name → **400**.

### Request

```http
POST /v1/history/detail
Authorization: Bearer <API_TOKEN>
Content-Type: application/json

{"historyFile":"END TO END - 01-2026-08-27T15-00-00-000Z.json"}
```

```bash
curl -s -X POST http://127.0.0.1:18732/v1/history/detail \
  -H "Authorization: Bearer $API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"historyFile":"END TO END - 01-2026-08-27T15-00-00-000Z.json"}'
```

### Response (200)

```json
{
  "historyFile": "END TO END - 01-2026-08-27T15-00-00-000Z.json",
  "status": "done",
  "items": [
    {
      "sequence": 1,
      "prompt": "Open the site",
      "model": "gemini-3.6-flash",
      "resultText": "Homepage loaded.",
      "screenshots": [
        "END TO END - 01-2026-08-27T15-00-00-000Z/0001-a/0001-start.webp",
        "END TO END - 01-2026-08-27T15-00-00-000Z/0001-a/0002-click.webp"
      ]
    },
    {
      "sequence": 2,
      "prompt": "Click login",
      "model": "gemini-3.6-flash",
      "screenshots": []
    }
  ]
}
```

Show items in `sequence` order (`1`, `2`, `3`, …).

No `resultText` on question 2 means that question has no agent answer yet (or never had one). Hide the result, or show an empty state. Do not treat that as an API error.

---

## Fields

### Run `status` (list and detail)

| Value | Meaning |
|---|---|
| `running` | In progress (or leftover after a crash) |
| `done` | Finished |
| `error` | A prompt failed, or safety was denied |
| `stopped` | User stopped the run |

### Detail item

| Field | Always present | Meaning |
|---|---|---|
| `sequence` | yes | Question order, starting at 1 |
| `prompt` | yes | User prompt |
| `model` | yes | Model used for that prompt |
| `resultText` | no | Agent answer. Omitted when missing |
| `screenshots` | yes | Relative `.webp` paths, sorted by name. Empty array if none |

Detail does **not** return item `status`, `error`, `id`, or `costUsd`.

---

## Screenshots

Paths are **relative**, after `saved-runs/`. Not image bytes.

```
<UI screenshot base>/saved-runs/ + screenshots[n]
```

Example full path:

```
…/saved-runs/END TO END - 01-2026-08-27T15-00-00-000Z/0001-a/0001-start.webp
```

Show images **in array order**. That is shot order.

`screenshots: []` → no image for that question. Hide the gallery. Not an error.

This is **not** live `GET /v1/screenshot`. Do not mix live `imageName` with these paths.

---

## Errors

Shape is always:

```json
{ "error": "message" }
```

| HTTP | When |
|---|---|
| **400** | Missing `historyFile`, bad JSON, or a path/illegal name |
| **401** | Missing or wrong Bearer token |
| **404** | That history file is not on disk |
| **405** | Wrong method (`POST` on list, `GET` on detail) |

Example 404:

```json
{ "error": "History file not found: missing.json" }
```

---

## Full curl example

```bash
# 1. List
curl -s http://127.0.0.1:18732/v1/history \
  -H "Authorization: Bearer $API_TOKEN"

# 2. Open one row
curl -s -X POST http://127.0.0.1:18732/v1/history/detail \
  -H "Authorization: Bearer $API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"historyFile":"END TO END - 01-2026-08-27T15-00-00-000Z.json"}'
```
