# Saved run API (for UI)

Replay a **saved flow** in a **new Chromium**. The live browser is not used.

- No NDJSON. Start returns at once. Poll status.
- File names go in the **JSON body**. Do not put them in the URL.
- Spaces in names are fine, for example `END TO END - 01.json`.

Live agent (`POST /v1/agent`) and live chrome (`/v1/session/*`) are **unchanged**.

Base URL: `http://127.0.0.1:18732`

All start / status / stop / detail routes need:

```http
Authorization: Bearer <API_TOKEN>
Content-Type: application/json
```

`GET /v1/saved/running` and `GET /v1/history` need the Bearer token only.

---

## What the UI should do

1. User picks a saved file (from `GET /v1/saved`).
2. `POST /v1/saved/run` with that `fileName`.
3. Poll `POST /v1/history/status` with the **same** `fileName` (every 0.5–1s is enough).
4. Show `current` / `total` and each item’s `status` / `resultText` / `error`.
5. Show the latest screenshot: UI base path + `screenshotPath` (see below).
6. Optional: user hits Stop → `POST /v1/history/stop` with the same `fileName`.
7. Stop polling when run `status` is `done`, `error`, or `stopped`.

Do **not** send the timestamped history file name. Status and stop always use the **latest** run of that saved file.

---

## Endpoints

| Method | Path | Body | Success |
|---|---|---|---|
| `GET` | `/v1/saved/running` | — | **200** `{ "files": [...] }` |
| `GET` | `/v1/history` | — | **200** `{ "runs": [{ "historyFile", "status" }] }` |
| `POST` | `/v1/history/detail` | `{ "historyFile" }` | **200** prompts, results, models, screenshot paths |
| `POST` | `/v1/saved/run` | `{ "fileName" }` | **202** `{ "historyFile" }` |
| `POST` | `/v1/history/status` | `{ "fileName" }` | **200** status JSON |
| `POST` | `/v1/history/stop` | `{ "fileName" }` | **200** `{ "ok": true }` |

`fileName` is the saved flow name, for example `"END TO END - 01.json"`.

---

## Running list

In-memory only. Crash leftovers are not included. Sorted by name. Empty is `{ "files": [] }`.

```http
GET /v1/saved/running
Authorization: Bearer <API_TOKEN>
```

```bash
curl -s http://127.0.0.1:18732/v1/saved/running \
  -H "Authorization: Bearer $API_TOKEN"
```

```json
{ "files": ["alpha.json", "beta.json"] }
```

This is not `GET /v1/saved` (all saved files on disk).

---

## History list

All history files on disk. Newest first. Empty is `{ "runs": [] }`. Bad JSON is skipped.

`status` is `running`, `done`, `error`, or `stopped`. Crash leftovers that still say `"running"` are included.

```http
GET /v1/history
Authorization: Bearer <API_TOKEN>
```

```bash
curl -s http://127.0.0.1:18732/v1/history \
  -H "Authorization: Bearer $API_TOKEN"
```

```json
{
  "runs": [
    { "historyFile": "END TO END - 01-2026-08-27T15-00-00-000Z.json", "status": "done" },
    { "historyFile": "login-flow-2026-08-27T14-00-00-000Z.json", "status": "error" }
  ]
}
```

This is not `GET /v1/saved/running` (in-memory, current runs only). This is not `POST /v1/history/status` (latest run of one saved file, with items).

---

## History detail

Returns **one** history file. Body uses `historyFile` from `GET /v1/history`, not the saved flow name.

All questions are included. `resultText` is omitted when missing. `screenshots` is `[]` when that question has no shots. Paths are relative after `saved-runs/`, sorted by name.

Missing file → **404**. Bad name → **400**.

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
        "END TO END - 01-2026-08-27T15-00-00-000Z/0001-a/0001-start.webp"
      ]
    }
  ]
}
```

This is not `POST /v1/history/status` (latest run of a saved `fileName`).

---

## 1. Start

Opens a **second** browser, goes to `TARGET_URL`, then runs prompts **in order**. Each item uses its own `model`.

HTTP returns **202** as soon as the history file is created. The run continues in the background.

### Request

```http
POST /v1/saved/run
Authorization: Bearer <API_TOKEN>
Content-Type: application/json

{"fileName":"END TO END - 01.json"}
```

```bash
curl -s -X POST http://127.0.0.1:18732/v1/saved/run \
  -H "Authorization: Bearer $API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"fileName":"END TO END - 01.json"}'
```

### Response (202)

```json
{
  "historyFile": "END TO END - 01-2026-08-27T14-00-00-000Z.json"
}
```

You can ignore `historyFile`. Status and stop do not need it.

The original saved JSON is **not** changed. Results go to `HISTORY_DIR`.

---

## 2. Status (poll this)

Returns the **latest** history file for that saved name (newest file on disk). Match is by `fileName` inside the history JSON, not by a name prefix.

### Request

```http
POST /v1/history/status
Authorization: Bearer <API_TOKEN>
Content-Type: application/json

{"fileName":"END TO END - 01.json"}
```

```bash
curl -s -X POST http://127.0.0.1:18732/v1/history/status \
  -H "Authorization: Bearer $API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"fileName":"END TO END - 01.json"}'
```

### Response (200) while running

Progress is `current` / `total` (here **2 / 3**).

```json
{
  "fileName": "END TO END - 01.json",
  "historyFile": "END TO END - 01-2026-08-27T14-00-00-000Z.json",
  "screenshotPath": "END TO END - 01-2026-08-27T14-00-00-000Z/0002-b/0002-click.webp",
  "status": "running",
  "current": 2,
  "total": 3,
  "items": [
    {
      "sequence": 1,
      "id": "a",
      "prompt": "Open the site",
      "model": "gemini-3.6-flash",
      "status": "done",
      "resultText": "Homepage loaded.",
      "costUsd": 0.001
    },
    {
      "sequence": 2,
      "id": "b",
      "prompt": "Click login",
      "model": "gemini-3.6-flash",
      "status": "running"
    },
    {
      "sequence": 3,
      "id": "c",
      "prompt": "Check the dashboard",
      "model": "gemini-3.6-flash",
      "status": "pending"
    }
  ]
}
```

When finished: `"status": "done"` and `"current"` equals `"total"`.

No history for that name → **404**.

These APIs do **not** list older runs. Only the latest run is returned.

---

## 3. Stop

Aborts the **current** prompt of the latest run, closes the extra browser, writes history as `stopped`.

### Request

```http
POST /v1/history/stop
Authorization: Bearer <API_TOKEN>
Content-Type: application/json

{"fileName":"END TO END - 01.json"}
```

```bash
curl -s -X POST http://127.0.0.1:18732/v1/history/stop \
  -H "Authorization: Bearer $API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"fileName":"END TO END - 01.json"}'
```

### Response (200)

```json
{ "ok": true }
```

Then poll status. Run `status` will be `"stopped"`. The in-progress item may still say `"running"` (no result). Later items stay `"pending"`.

This does **not** stop the live `/v1/agent`.

---

## Fields

### Run `status`

| Value | Meaning |
|---|---|
| `running` | In progress |
| `done` | All prompts finished (skips count as finished) |
| `error` | A prompt failed, or safety was denied. Later prompts were not run |
| `stopped` | User stopped the run |

### Item `status`

| Value | Meaning | Extra fields |
|---|---|---|
| `pending` | Not started | — |
| `running` | This prompt is in progress | — |
| `done` | This prompt finished | `resultText`, `costUsd` |
| `error` | This prompt failed | `error`, maybe `costUsd` |
| `skipped` | Empty prompt, skipped | — |

`resultText` is the agent summary (often JSON text). `error` is a string. `costUsd` is a number.

Optional item fields are omitted when unused (not `null`).

### Screenshots

Status returns **`screenshotPath`**: the newest `.webp` for that run. Relative path **after** `saved-runs/`. Not image bytes.

```
<PROCESSED_DIR>/saved-runs/ + screenshotPath
```

Example:

```
…/screenshot/saved-runs/END TO END - 01-2026-08-27T14-00-00-000Z/0002-b/0002-click.webp
```

No screenshot yet → `""`. Do not treat that as an error.

Shots on disk (one folder per question):

```
<PROCESSED_DIR>/saved-runs/<historyFile without .json>/<sequence>-<id>/
```

`sequence` is 4 digits (`1` → `0001`). `id` keeps letters, numbers, `_`, and `-`. Other characters become `-`. Empty id → `id`.

Files inside:

```
{time}-{0001}-{action}.webp
```

Sort by name for shot order. Skipped prompts create no folder. Old runs may still have files directly in the run folder.

This is **not** live `GET /v1/screenshot`. Live shots stay under the live processed folder.

---

## Errors

Shape is always:

```json
{ "error": "message" }
```

| HTTP | When |
|---|---|
| **400** | Missing `fileName`, bad JSON, bad name, or `create-default.json` on start |
| **401** | Missing or wrong Bearer token |
| **404** | Saved file missing (start), no history yet (status/stop), or nothing actually running (stop leftover) |
| **409** | Same file already running, saved-run cap reached, or latest run already finished (stop) |
| **405** | Wrong method |

Start while that same file is already running:

```json
{ "error": "Saved run already running for this file" }
```

Start when `MAX_SAVED_RUNS` files are already running (default **2**):

```json
{ "error": "Saved run limit reached" }
```

Stop when the latest run is already `done` / `error` / `stopped`:

```json
{ "error": "Saved run already finished" }
```

Different files can run **at the same time**, each in its **own** Chromium, up to `MAX_SAVED_RUNS`. The same file cannot. Live agent and saved runs **can** run at the same time.

---

## Live vs saved run

| | Live | Saved run |
|---|---|---|
| Start | `POST /v1/agent` (NDJSON) | `POST /v1/saved/run` (202 + poll) |
| Browser | Shared live Chromium | New Chromium |
| Session chrome | `/v1/session/back` etc. | Do not use for the saved run |
| Screenshot | `GET /v1/screenshot` → `imageName` | Status `screenshotPath` |
| Safety popup | `safety_confirm` + `/v1/agent/safety` | No popup. Confirm is denied; that step errors and the run stops |

Live agent and saved runs **can** run at the same time.

Live Back / Forward / Reload still only move the **live** browser.

Do not mix live screenshot `imageName` with saved-run `screenshotPath`.

---

## Run behaviour (so the UI is not surprised)

- Prompts run in `sequence` order.
- Empty prompt → item `skipped`, run continues.
- One prompt fails → item `error`, run `error`, rest stay `pending`.
- Gemini safety confirm → treated as denied → item `error`, run `error`.
- `create-default.json` cannot be started (**400**).
- Extra Chromium closes on `done`, `error`, and `stop`.
- Different files can run at the same time, each in a new Chromium, up to `MAX_SAVED_RUNS` (default 2). The same file cannot.
- Stop one fileName; other saved runs keep going.
- If the service crashes mid-run, the history file may stay `"running"`. Status will show that file. Stop may return **404** (process is gone). Next start is a new history file.

---

## Suggested UI states

| You show | From status |
|---|---|
| Progress bar / “2 of 3” | `current` and `total` |
| Per-row spinner | item `status === "running"` |
| Result text | item `resultText` |
| Red row | item `status === "error"` + `error` |
| Grey row | item `status === "skipped"` |
| Preview image | UI base + `screenshotPath` (hide image if `""`) |
| Enable Stop | run `status === "running"` |
| Disable Start for that file | last status for that file was `running`, or last start for it returned 409 “already running for this file” |
| Disable Start for all files | last start returned 409 “Saved run limit reached” |

Poll until run `status` is not `running`. Then stop the timer.

HTTP **202** on start is **not** “the flow passed”. Wait for `"status": "done"` (or `error` / `stopped`).

---

## Full curl example

```bash
# 0. History runs on disk
curl -s http://127.0.0.1:18732/v1/history \
  -H "Authorization: Bearer $API_TOKEN"

# 0a. One history file (prompts, results, screenshots)
curl -s -X POST http://127.0.0.1:18732/v1/history/detail \
  -H "Authorization: Bearer $API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"historyFile":"END TO END - 01-2026-08-27T15-00-00-000Z.json"}'

# 0b. Who is running now
curl -s http://127.0.0.1:18732/v1/saved/running \
  -H "Authorization: Bearer $API_TOKEN"

# 1. Start
curl -s -X POST http://127.0.0.1:18732/v1/saved/run \
  -H "Authorization: Bearer $API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"fileName":"END TO END - 01.json"}'

# 2. Poll
curl -s -X POST http://127.0.0.1:18732/v1/history/status \
  -H "Authorization: Bearer $API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"fileName":"END TO END - 01.json"}'

# 3. Stop (optional)
curl -s -X POST http://127.0.0.1:18732/v1/history/stop \
  -H "Authorization: Bearer $API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"fileName":"END TO END - 01.json"}'
```
