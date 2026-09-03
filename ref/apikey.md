# Gemini API key (for UI)

Read and update the **Gemini** key stored in the service config file.

This is **not** the Bearer `apiToken`. The UI still sends `Authorization: Bearer <API_TOKEN>` on both calls. The body field is always `geminiApiKey`.

- No NDJSON.
- GET reads the config JSON file.
- PUT writes the config JSON file and applies the new key in memory. Later agent runs do **not** need a service restart.
- An agent run that is **already** in progress keeps the old key until it finishes.

Base URL: `http://127.0.0.1:18732`

---

## What the UI should do

1. Settings / API key screen: call `GET /v1/apikey`.
2. If `geminiApiKey` is `""`, show “not set”. Do not treat that as an error.
3. If it has a value, show a masked field (dots). Do not log the full key.
4. User pastes a new key and saves → `PUT /v1/apikey` with `{ "geminiApiKey": "..." }`.
5. **200** `{ "ok": true }` means saved. Then GET again (or keep the value the user just typed) to refresh the field.
6. Empty / whitespace save → **400**. Keep the old key on screen. Show “key is required”.

Do **not** send the Bearer token in the JSON body. Do **not** use `POST`.

---

## Auth

GET needs the Bearer token only:

```http
Authorization: Bearer <API_TOKEN>
```

PUT also needs JSON:

```http
Authorization: Bearer <API_TOKEN>
Content-Type: application/json
```

---

## Endpoints

| Method | Path | Body | Success |
|---|---|---|---|
| `GET` | `/v1/apikey` | — | **200** `{ "geminiApiKey": "..." }` |
| `PUT` | `/v1/apikey` | `{ "geminiApiKey": "..." }` | **200** `{ "ok": true }` |

Path is `/v1/apikey` (one word). Not `/v1/api-key`. Not `/v1/gemini`.

---

## 1. Get

Reads `geminiApiKey` from the config JSON file on disk.

Missing or blank in the file → `"geminiApiKey": ""`. That is still **200**.

### Request

```http
GET /v1/apikey
Authorization: Bearer <API_TOKEN>
```

```bash
curl -s http://127.0.0.1:18732/v1/apikey \
  -H "Authorization: Bearer $API_TOKEN"
```

### Response (200) — key is set

```json
{ "geminiApiKey": "AIza..." }
```

### Response (200) — key is not set

```json
{ "geminiApiKey": "" }
```

GET returns the **plain** key. Mask it in the UI.

---

## 2. Set

Writes `geminiApiKey` into the config JSON file. Other config fields stay as they are.

Also updates the running service, so the **next** `POST /v1/agent` / saved run uses the new key. No restart.

PUT success body is `{ "ok": true }`. It does **not** echo the key.

### Request

```http
PUT /v1/apikey
Authorization: Bearer <API_TOKEN>
Content-Type: application/json

{"geminiApiKey":"your-gemini-key"}
```

```bash
curl -s -X PUT http://127.0.0.1:18732/v1/apikey \
  -H "Authorization: Bearer $API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"geminiApiKey":"your-gemini-key"}'
```

### Response (200)

```json
{ "ok": true }
```

Whitespace around the key is trimmed. `"  AIza...  "` is stored as `"AIza..."`.

Empty string, only spaces, missing field, or non-string → **400**, file is **not** changed:

```json
{ "error": "geminiApiKey is required" }
```

---

## Fields

| Field | Where | Meaning |
|---|---|---|
| `geminiApiKey` | GET response, PUT body | Gemini key string. GET may be `""`. PUT must be non-empty after trim |
| `ok` | PUT response only | Always `true` on success |

There is no `masked` flag and no last-4 helper. The UI must mask on its own.

---

## Errors

Shape is always:

```json
{ "error": "message" }
```

| HTTP | When |
|---|---|
| **400** | PUT: missing body, body not a JSON object, missing `geminiApiKey`, empty, or only spaces |
| **401** | Missing or wrong Bearer token |
| **405** | Wrong method (`POST`, `DELETE`, …). Allow: `GET, PUT` |
| **500** | Config file missing or not readable/writable |

Example 400:

```json
{ "error": "geminiApiKey is required" }
```

Example 401:

```json
{ "error": "Unauthorized" }
```

---

## Suggested UI states

| You show | From |
|---|---|
| “Not set” / empty input | GET `geminiApiKey === ""` |
| Masked key field | GET `geminiApiKey` is non-empty |
| Enable Save | user typed a non-empty key |
| Disable Save | input is empty or only spaces |
| Toast “Saved” | PUT **200** `{ "ok": true }` |
| Toast “Key is required” | PUT **400** |
| Toast “Not authorized” | **401** |
| Toast “Could not save key” | **500** |

Do not clear a previously shown key on **400**. The file still has the old value.

After a successful PUT, the next agent run uses the new key. You do not need to tell the user to restart the service.

---

## Full curl example

```bash
# 1. Read
curl -s http://127.0.0.1:18732/v1/apikey \
  -H "Authorization: Bearer $API_TOKEN"

# 2. Write
curl -s -X PUT http://127.0.0.1:18732/v1/apikey \
  -H "Authorization: Bearer $API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"geminiApiKey":"your-gemini-key"}'

# 3. Confirm
curl -s http://127.0.0.1:18732/v1/apikey \
  -H "Authorization: Bearer $API_TOKEN"
```
