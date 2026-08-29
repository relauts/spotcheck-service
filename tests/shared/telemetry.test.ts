import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createAutomationReporter,
  postSuccessfulAutomation,
} from "../../src/shared/telemetry.js";

const CONFIG = {
  installationId: "7d3cefb5-5ba9-43c3-af0c-2a1593c9f8b8",
  telemetryUrl: "https://spotcheck-telemetry.example/v1/automation",
};

const STARTED = new Date("2026-08-29T10:00:00.000Z");
const ENDED = new Date("2026-08-29T10:00:02.000Z");

function jsonResponse(status = 200): Response {
  return new Response(JSON.stringify({ accepted: true }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("postSuccessfulAutomation", () => {
  it("posts eventId, uuid, and timestamps", async () => {
    const posts: Array<{ url: string; body: unknown }> = [];
    await postSuccessfulAutomation(CONFIG, STARTED, ENDED, {
      randomUUID: () => "event-1",
      fetch: (async (url, init) => {
        posts.push({ url: String(url), body: JSON.parse(String(init?.body)) });
        return jsonResponse();
      }) as typeof fetch,
    });

    assert.deepEqual(posts, [
      {
        url: CONFIG.telemetryUrl,
        body: {
          eventId: "event-1",
          uuid: CONFIG.installationId,
          startedAt: "2026-08-29T10:00:00.000Z",
          endedAt: "2026-08-29T10:00:02.000Z",
        },
      },
    ]);
  });

  it("skips when install id or url is missing", async () => {
    let called = false;
    const fetchFn = (async () => {
      called = true;
      return jsonResponse();
    }) as typeof fetch;

    await postSuccessfulAutomation(
      { installationId: undefined, telemetryUrl: CONFIG.telemetryUrl },
      STARTED,
      ENDED,
      { fetch: fetchFn },
    );
    await postSuccessfulAutomation(
      { installationId: CONFIG.installationId, telemetryUrl: undefined },
      STARTED,
      ENDED,
      { fetch: fetchFn },
    );

    assert.equal(called, false);
  });

  it("skips when duration is under 1 second", async () => {
    let called = false;
    await postSuccessfulAutomation(CONFIG, STARTED, new Date("2026-08-29T10:00:00.999Z"), {
      fetch: (async () => {
        called = true;
        return jsonResponse();
      }) as typeof fetch,
    });
    assert.equal(called, false);
  });

  it("does not throw when telemetry fails", async () => {
    await postSuccessfulAutomation(CONFIG, STARTED, ENDED, {
      fetch: (async () => {
        throw new Error("network down");
      }) as typeof fetch,
    });
    await postSuccessfulAutomation(CONFIG, STARTED, ENDED, {
      fetch: (async () => jsonResponse(500)) as typeof fetch,
    });
  });
});

describe("createAutomationReporter", () => {
  it("does not wait for fetch", async () => {
    let fetchStarted = false;
    let resolveFetch!: (value: Response) => void;
    const fetchGate = new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    });
    const reporter = createAutomationReporter(CONFIG, {
      randomUUID: () => "event-1",
      fetch: (async () => {
        fetchStarted = true;
        return fetchGate;
      }) as typeof fetch,
    });

    const started = Date.now();
    reporter(STARTED, ENDED);
    assert.ok(Date.now() - started < 50);

    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(fetchStarted, true);
    resolveFetch(jsonResponse());
    await fetchGate;
  });
});
