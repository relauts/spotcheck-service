#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import http from "node:http";
import path from "node:path";
import { AgentRunError, runAgent, type AgentRunExtras, type AgentRunResult } from "../computer-use/index.js";
import { confirmSafetyForWeb } from "../computer-use/safety.js";
import type { SafetyConfirmer } from "../computer-use/types.js";
import { launchLightChromium } from "../playwright/chromium.js";
import {
  getLatestWebpPath,
  getSavedRunItemScreenshotRelPaths,
  getSavedRunScreenshotRelPath,
} from "../playwright/processed.js";
import {
  BrowserClosedError,
  createBrowserSession,
  type BrowserSession,
  type SessionStatus,
} from "../playwright/session.js";
import { loadConfig, requireApiToken, type AppConfig } from "../shared/config.js";
import { computeCostUsd, EMPTY_USAGE } from "../shared/cost.js";
import { logger } from "../shared/logger.js";
import { isMainModule } from "../shared/main-module.js";
import {
  assertAllowedModel,
  getModelEntry,
  loadModels,
  type ModelEntry,
} from "../shared/models.js";
import { createAutomationReporter, type AutomationReporter } from "../shared/telemetry.js";
import { isAuthorized } from "./auth.js";
import { findLatestHistory, listHistoryRuns, readHistoryFile, serializeHistoryDetailItem } from "./history.js";
import {
  CREATE_DEFAULT_FILE,
  SavedExistsError,
  SavedNameError,
  SavedNotFoundError,
  deleteSavedFile,
  ensureCreateDefaultFile,
  isCreateDefaultFileName,
  listSavedFiles,
  normalizeSavedFileName,
  overwriteSavedFile,
  parseCreateItems,
  parseSavedItems,
  readSavedFile,
  upsertSavedFile,
  writeSavedFile,
} from "./saved.js";
import {
  SavedRunBusyError,
  SavedRunFinishedError,
  SavedRunLimitError,
  SavedRunNotRunningError,
  createSavedRunManager,
  type SavedRunManager,
  type SavedRunTask,
} from "./saved-run.js";

const MAX_AGENT_BODY_BYTES = 16_384;
const MAX_CREATE_BODY_BYTES = 262_144;

export type AgentRunner = (
  task: string,
  model: string,
  extras?: AgentRunExtras,
) => Promise<AgentRunResult>;

export interface ServiceServerDeps {
  readonly runTask?: AgentRunner;
  readonly session?: BrowserSession;
  readonly savedDir?: string;
  readonly processedDir?: string;
  readonly historyDir?: string;
  readonly savedRunTask?: SavedRunTask;
  readonly createSavedRunSession?: (screenshotDir: string) => BrowserSession;
  readonly apiToken?: string;
  readonly corsOrigins?: readonly string[];
  readonly config?: AppConfig;
  readonly reportAutomation?: AutomationReporter;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const serverSessions = new WeakMap<http.Server, BrowserSession>();
const serverSavedRuns = new WeakMap<http.Server, SavedRunManager>();
let activeServer: http.Server | undefined;
let shuttingDown = false;

const pendingSafetyConfirmations = new Map<string, (confirmed: boolean) => void>();

async function loadAgentStreamExtras(
  session: BrowserSession,
  processedDir: string,
): Promise<{
  session: { open: boolean; url: string };
  screenshot: { imageName: string };
}> {
  const status = session.getStatus();
  let imageName = "";
  try {
    const filePath = await getLatestWebpPath(processedDir);
    if (filePath) {
      imageName = path.basename(filePath);
    }
  } catch {
    // Same as GET /v1/screenshot with no file: do not fail the event.
  }

  return {
    session: { open: status.open, url: status.url },
    screenshot: { imageName },
  };
}

async function writeAgentEvent(
  response: http.ServerResponse,
  session: BrowserSession,
  processedDir: string,
  body: Record<string, unknown>,
): Promise<void> {
  writeNdjson(response, {
    ...body,
    ...(await loadAgentStreamExtras(session, processedDir)),
  });
}

/**
 * Builds a per-request SafetyConfirmer that pushes a "safety_confirm" event down
 * the open NDJSON stream and waits for POST /v1/agent/safety.
 */
function createWebSafetyConfirmer(
  response: http.ServerResponse,
  signal: AbortSignal,
  session: BrowserSession,
  processedDir: string,
): SafetyConfirmer {
  return async (explanation, actionName) => {
    const extras = await loadAgentStreamExtras(session, processedDir);
    return new Promise<boolean>((resolve) => {
      const id = randomUUID();

      function onAbort(): void {
        pendingSafetyConfirmations.delete(id);
        resolve(false);
      }

      function settle(confirmed: boolean): void {
        if (signal.aborted) {
          pendingSafetyConfirmations.delete(id);
          signal.removeEventListener("abort", onAbort);
          resolve(false);
          return;
        }
        signal.removeEventListener("abort", onAbort);
        resolve(confirmed);
      }

      pendingSafetyConfirmations.set(id, settle);
      signal.addEventListener("abort", onAbort);
      writeNdjson(response, {
        type: "safety_confirm",
        id,
        action: actionName,
        explanation,
        ...extras,
      });
    });
  };
}

function requestPath(request: http.IncomingMessage): string {
  return new URL(request.url ?? "/", "http://localhost").pathname;
}

function send(
  response: http.ServerResponse,
  status: number,
  body: Buffer | string,
  headers: http.OutgoingHttpHeaders,
): void {
  response.writeHead(status, headers);
  response.end(body);
}

function sendJson(
  response: http.ServerResponse,
  status: number,
  body: Record<string, unknown>,
  extraHeaders: http.OutgoingHttpHeaders = {},
): void {
  send(response, status, JSON.stringify(body), {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...extraHeaders,
  });
}

function sendMethodNotAllowed(
  response: http.ServerResponse,
  allow: string,
  cors: http.OutgoingHttpHeaders,
): void {
  send(response, 405, "Method not allowed", {
    "Content-Type": "text/plain; charset=utf-8",
    Allow: allow,
    ...cors,
  });
}

function beginNdjson(response: http.ServerResponse, extraHeaders: http.OutgoingHttpHeaders = {}): void {
  response.writeHead(200, {
    "Content-Type": "application/x-ndjson; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Accel-Buffering": "no",
    ...extraHeaders,
  });
  response.flushHeaders();
}

function writeNdjson(response: http.ServerResponse, body: Record<string, unknown>): void {
  if (response.writableEnded || response.destroyed) {
    return;
  }

  response.write(`${JSON.stringify(body)}\n`);
}

function endNdjson(response: http.ServerResponse): void {
  if (!response.writableEnded && !response.destroyed) {
    response.end();
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function corsHeadersFor(
  request: http.IncomingMessage,
  allowedOrigins: readonly string[],
): http.OutgoingHttpHeaders {
  const origin = request.headers.origin;
  if (!origin || !allowedOrigins.includes(origin)) {
    return {};
  }

  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function applyCors(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  allowedOrigins: readonly string[],
): http.OutgoingHttpHeaders {
  const headers = corsHeadersFor(request, allowedOrigins);
  for (const [key, value] of Object.entries(headers)) {
    if (value !== undefined) {
      response.setHeader(key, value);
    }
  }
  return headers;
}

async function readJsonBody(
  request: http.IncomingMessage,
  maxBytes = MAX_AGENT_BODY_BYTES,
): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBytes) {
      request.destroy();
      throw new HttpError(413, "Request body too large");
    }
    chunks.push(buffer);
  }

  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) {
    throw new HttpError(400, "Request body is required");
  }

  try {
    return JSON.parse(raw);
  } catch {
    throw new HttpError(400, "Body must be valid JSON");
  }
}

function parseSavedItemsBody(
  body: unknown,
  models: readonly ModelEntry[],
): ReturnType<typeof parseSavedItems> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new HttpError(400, "Body must be a JSON object");
  }

  try {
    return parseSavedItems((body as { items?: unknown }).items).map((item) => ({
      ...item,
      model: assertAllowedModel(item.model, models),
    }));
  } catch (error: unknown) {
    throw new HttpError(400, errorMessage(error));
  }
}

function parseSavedRequest(
  body: unknown,
  models: readonly ModelEntry[],
): { fileName: string; items: ReturnType<typeof parseSavedItems> } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new HttpError(400, "Body must be a JSON object");
  }

  const payload = body as { fileName?: unknown; items?: unknown };
  if (typeof payload.fileName !== "string" || !payload.fileName.trim()) {
    throw new HttpError(400, "fileName is required");
  }

  const items = parseSavedItemsBody(body, models);
  return { fileName: payload.fileName.trim(), items };
}

async function handleSavedList(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  savedDir: string,
  cors: http.OutgoingHttpHeaders,
): Promise<void> {
  if (request.method !== "GET") {
    sendMethodNotAllowed(response, "GET, POST", cors);
    return;
  }

  const files = (await listSavedFiles(savedDir)).filter(
    (name) => name.toLowerCase() !== CREATE_DEFAULT_FILE,
  );
  sendJson(response, 200, { files }, cors);
}

async function handleSavedItem(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  pathname: string,
  savedDir: string,
  cors: http.OutgoingHttpHeaders,
): Promise<void> {
  const rawName = decodeURIComponent(pathname.slice("/v1/saved/".length));

  if (request.method === "GET") {
    try {
      sendJson(response, 200, await readSavedFile(rawName, savedDir), cors);
    } catch (error: unknown) {
      if (error instanceof SavedNotFoundError) {
        throw new HttpError(404, error.message);
      }
      if (error instanceof SavedNameError) {
        throw new HttpError(400, error.message);
      }
      throw error;
    }
    return;
  }

  if (request.method === "PUT") {
    const models = await loadModels();
    const items = parseSavedItemsBody(await readJsonBody(request), models);
    try {
      const name = await overwriteSavedFile(rawName, items, savedDir);
      sendJson(response, 200, { fileName: name }, cors);
    } catch (error: unknown) {
      if (error instanceof SavedNotFoundError) {
        throw new HttpError(404, error.message);
      }
      if (error instanceof SavedNameError) {
        throw new HttpError(400, error.message);
      }
      throw error;
    }
    return;
  }

  if (request.method === "DELETE") {
    try {
      const name = await deleteSavedFile(rawName, savedDir);
      sendJson(response, 200, { fileName: name }, cors);
    } catch (error: unknown) {
      if (error instanceof SavedNotFoundError) {
        throw new HttpError(404, error.message);
      }
      if (error instanceof SavedNameError) {
        throw new HttpError(400, error.message);
      }
      throw error;
    }
    return;
  }

  sendMethodNotAllowed(response, "GET, PUT, DELETE", cors);
}

async function handleSavedCreate(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  savedDir: string,
  cors: http.OutgoingHttpHeaders,
): Promise<void> {
  if (request.method !== "POST") {
    sendMethodNotAllowed(response, "GET, POST", cors);
    return;
  }

  const models = await loadModels();
  const { fileName, items } = parseSavedRequest(await readJsonBody(request), models);
  try {
    if (isCreateDefaultFileName(fileName)) {
      throw new SavedNameError(`${CREATE_DEFAULT_FILE} is reserved`);
    }
    const name = await writeSavedFile(fileName, items, savedDir);
    sendJson(response, 201, { fileName: name }, cors);
  } catch (error: unknown) {
    if (error instanceof SavedExistsError) {
      throw new HttpError(409, error.message);
    }
    if (error instanceof SavedNameError) {
      throw new HttpError(400, error.message);
    }
    throw error;
  }
}

function parseCreateRequest(
  body: unknown,
  models: readonly ModelEntry[],
): ReturnType<typeof parseCreateItems> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new HttpError(400, "Body must be a JSON object");
  }

  try {
    return parseCreateItems((body as { items?: unknown }).items).map((item) => ({
      ...item,
      model: assertAllowedModel(item.model, models),
    }));
  } catch (error: unknown) {
    throw new HttpError(400, errorMessage(error));
  }
}

async function handleCreateDefault(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  savedDir: string,
  cors: http.OutgoingHttpHeaders,
): Promise<void> {
  if (request.method === "GET") {
    try {
      sendJson(response, 200, await readSavedFile(CREATE_DEFAULT_FILE, savedDir), cors);
    } catch (error: unknown) {
      if (error instanceof SavedNotFoundError) {
        sendJson(response, 200, { fileName: CREATE_DEFAULT_FILE, items: [] }, cors);
        return;
      }
      if (error instanceof SavedNameError) {
        throw new HttpError(400, error.message);
      }
      throw error;
    }
    return;
  }

  if (request.method !== "PUT") {
    sendMethodNotAllowed(response, "GET, PUT", cors);
    return;
  }

  const models = await loadModels();
  const items = parseCreateRequest(await readJsonBody(request, MAX_CREATE_BODY_BYTES), models);
  const name = await upsertSavedFile(CREATE_DEFAULT_FILE, items, savedDir);
  sendJson(response, 200, { fileName: name }, cors);
}

function parseAgentRequest(
  body: unknown,
  models: readonly ModelEntry[],
): { task: string; model: string } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new HttpError(400, "Body must be a JSON object");
  }

  const payload = body as { task?: unknown; model?: unknown };
  const task = payload.task;
  if (typeof task !== "string" || !task.trim()) {
    throw new HttpError(400, "task is required");
  }

  if (typeof payload.model !== "string" || !payload.model.trim()) {
    throw new HttpError(400, "model is required");
  }

  try {
    return {
      task: task.trim(),
      model: assertAllowedModel(payload.model, models),
    };
  } catch (error: unknown) {
    throw new HttpError(400, errorMessage(error));
  }
}

async function handleModelsRequest(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  cors: http.OutgoingHttpHeaders,
): Promise<void> {
  if (request.method !== "GET") {
    sendMethodNotAllowed(response, "GET", cors);
    return;
  }

  const models = await loadModels();
  send(response, 200, JSON.stringify(models), {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...cors,
  });
}

async function handleScreenshotRequest(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  processedDir: string,
  cors: http.OutgoingHttpHeaders,
): Promise<void> {
  if (request.method !== "GET") {
    sendMethodNotAllowed(response, "GET", cors);
    return;
  }

  const filePath = await getLatestWebpPath(processedDir);
  if (!filePath) {
    throw new HttpError(404, "No processed webp yet");
  }

  sendJson(response, 200, { imageName: path.basename(filePath) }, cors);
}

async function handleAgentRequest(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  runTask: AgentRunner,
  session: BrowserSession,
  busy: { current: boolean },
  processedDir: string,
  cors: http.OutgoingHttpHeaders,
  reportAutomation: AutomationReporter,
): Promise<void> {
  if (request.method !== "POST") {
    sendMethodNotAllowed(response, "POST", cors);
    return;
  }

  if (busy.current) {
    throw new HttpError(409, "Agent already running");
  }

  busy.current = true;
  try {
    const models = await loadModels();
    const { task, model } = parseAgentRequest(await readJsonBody(request), models);
    const prices = getModelEntry(model, models);
    const abort = new AbortController();
    let finished = false;
    const stopOnDisconnect = (): void => {
      if (!finished) {
        abort.abort();
      }
    };
    response.once("close", stopOnDisconnect);
    beginNdjson(response, cors);
    try {
      const startedAt = new Date();
      const result = await runTask(task, model, {
        signal: abort.signal,
        onIntent: async (label) => {
          await writeAgentEvent(response, session, processedDir, { type: "intent", label });
        },
        confirmSafety: createWebSafetyConfirmer(response, abort.signal, session, processedDir),
      });
      reportAutomation(startedAt, new Date());
      await writeAgentEvent(response, session, processedDir, {
        type: "done",
        text: result.text,
        sessionReset: result.sessionReset,
        browserOpen: session.isOpen(),
        costUsd: computeCostUsd(result.usage ?? EMPTY_USAGE, prices),
      });
    } catch (error: unknown) {
      await writeAgentEvent(response, session, processedDir, {
        type: "error",
        error: errorMessage(error),
        costUsd: computeCostUsd(
          error instanceof AgentRunError ? error.usage : EMPTY_USAGE,
          prices,
        ),
      });
      if (!(error instanceof AgentRunError)) {
        logger.error("Failed to run agent", error);
      }
    } finally {
      finished = true;
      response.off("close", stopOnDisconnect);
      endNdjson(response);
    }
  } finally {
    busy.current = false;
  }
}

async function handleAgentSafety(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  cors: http.OutgoingHttpHeaders,
): Promise<void> {
  if (request.method !== "POST") {
    sendMethodNotAllowed(response, "POST", cors);
    return;
  }

  const body = await readJsonBody(request);
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new HttpError(400, "Body must be a JSON object");
  }

  const payload = body as { id?: unknown; confirmed?: unknown };
  if (typeof payload.id !== "string" || !payload.id.trim()) {
    throw new HttpError(400, "id is required");
  }
  if (typeof payload.confirmed !== "boolean") {
    throw new HttpError(400, "confirmed must be a boolean");
  }

  const settle = pendingSafetyConfirmations.get(payload.id);
  if (!settle) {
    throw new HttpError(404, "No pending confirmation for id");
  }

  settle(payload.confirmed);
  sendJson(response, 200, { ok: true }, cors);
}

function handleSessionStatus(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  session: BrowserSession,
  cors: http.OutgoingHttpHeaders,
): void {
  if (request.method !== "GET") {
    sendMethodNotAllowed(response, "GET", cors);
    return;
  }

  const status = session.getStatus();
  sendJson(response, 200, { open: status.open, url: status.url }, cors);
}

async function handleSessionNavigate(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  session: BrowserSession,
  busy: { current: boolean },
  action: "back" | "forward" | "reload",
  cors: http.OutgoingHttpHeaders,
): Promise<void> {
  if (request.method !== "POST") {
    sendMethodNotAllowed(response, "POST", cors);
    return;
  }

  if (busy.current) {
    throw new HttpError(409, "Agent already running");
  }

  try {
    let status: SessionStatus;
    if (action === "back") {
      status = await session.goBack();
    } else if (action === "forward") {
      status = await session.goForward();
    } else {
      status = await session.reload();
    }
    sendJson(response, 200, { open: status.open, url: status.url }, cors);
  } catch (error: unknown) {
    if (error instanceof BrowserClosedError) {
      throw new HttpError(409, error.message);
    }
    throw error;
  }
}

function handleHealth(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  cors: http.OutgoingHttpHeaders,
): void {
  if (request.method !== "GET") {
    sendMethodNotAllowed(response, "GET", cors);
    return;
  }

  sendJson(response, 200, { ok: true }, cors);
}

function parseRequiredName(body: unknown, field = "fileName"): string {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new HttpError(400, "Body must be a JSON object");
  }

  const value = (body as Record<string, unknown>)[field];
  if (typeof value !== "string" || !value.trim()) {
    throw new HttpError(400, `${field} is required`);
  }

  return value.trim();
}

async function handleSavedRunStart(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  savedRun: SavedRunManager,
  cors: http.OutgoingHttpHeaders,
): Promise<void> {
  if (request.method !== "POST") {
    sendMethodNotAllowed(response, "POST", cors);
    return;
  }

  const fileName = parseRequiredName(await readJsonBody(request), "fileName");
  try {
    const historyFile = await savedRun.start(fileName);
    sendJson(response, 202, { historyFile }, cors);
  } catch (error: unknown) {
    if (error instanceof SavedRunBusyError || error instanceof SavedRunLimitError) {
      throw new HttpError(409, error.message);
    }
    if (error instanceof SavedNotFoundError) {
      throw new HttpError(404, error.message);
    }
    if (error instanceof SavedNameError) {
      throw new HttpError(400, error.message);
    }
    throw error;
  }
}

async function handleHistoryList(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  historyDir: string,
  cors: http.OutgoingHttpHeaders,
): Promise<void> {
  if (request.method !== "GET") {
    sendMethodNotAllowed(response, "GET", cors);
    return;
  }

  sendJson(response, 200, { runs: await listHistoryRuns(historyDir) }, cors);
}

async function handleHistoryDetail(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  historyDir: string,
  processedDir: string,
  cors: http.OutgoingHttpHeaders,
): Promise<void> {
  if (request.method !== "POST") {
    sendMethodNotAllowed(response, "POST", cors);
    return;
  }

  const historyFile = parseRequiredName(await readJsonBody(request), "historyFile");
  try {
    const name = normalizeSavedFileName(historyFile);
    const document = await readHistoryFile(name, historyDir);
    const items = await Promise.all(
      document.items.map(async (item) => {
        const screenshots = await getSavedRunItemScreenshotRelPaths(
          processedDir,
          name,
          item.sequence,
          item.id,
        );
        return serializeHistoryDetailItem(item, screenshots);
      }),
    );
    sendJson(
      response,
      200,
      {
        historyFile: name,
        status: document.status,
        items,
      },
      cors,
    );
  } catch (error: unknown) {
    if (error instanceof SavedNotFoundError) {
      throw new HttpError(404, error.message);
    }
    if (error instanceof SavedNameError) {
      throw new HttpError(400, error.message);
    }
    throw error;
  }
}

function handleSavedRunningList(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  savedRun: SavedRunManager,
  cors: http.OutgoingHttpHeaders,
): void {
  if (request.method !== "GET") {
    sendMethodNotAllowed(response, "GET", cors);
    return;
  }

  sendJson(response, 200, { files: savedRun.listRunning() }, cors);
}

async function handleHistoryStatus(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  historyDir: string,
  processedDir: string,
  cors: http.OutgoingHttpHeaders,
): Promise<void> {
  if (request.method !== "POST") {
    sendMethodNotAllowed(response, "POST", cors);
    return;
  }

  const fileName = parseRequiredName(await readJsonBody(request));
  try {
    const latest = await findLatestHistory(fileName, historyDir);
    const screenshotPath = await getSavedRunScreenshotRelPath(processedDir, latest.historyFile);
    sendJson(
      response,
      200,
      {
        fileName: latest.document.fileName,
        historyFile: latest.historyFile,
        status: latest.document.status,
        current: latest.document.current,
        total: latest.document.total,
        screenshotPath,
        items: [...latest.document.items],
      },
      cors,
    );
  } catch (error: unknown) {
    if (error instanceof SavedNotFoundError) {
      throw new HttpError(404, error.message);
    }
    if (error instanceof SavedNameError) {
      throw new HttpError(400, error.message);
    }
    throw error;
  }
}

async function handleHistoryStop(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  savedRun: SavedRunManager,
  historyDir: string,
  cors: http.OutgoingHttpHeaders,
): Promise<void> {
  if (request.method !== "POST") {
    sendMethodNotAllowed(response, "POST", cors);
    return;
  }

  const fileName = parseRequiredName(await readJsonBody(request));
  try {
    const latest = await findLatestHistory(fileName, historyDir);
    await savedRun.stop(latest.historyFile);
    sendJson(response, 200, { ok: true }, cors);
  } catch (error: unknown) {
    if (error instanceof SavedRunNotRunningError) {
      throw new HttpError(404, error.message);
    }
    if (error instanceof SavedRunFinishedError) {
      throw new HttpError(409, error.message);
    }
    if (error instanceof SavedNotFoundError) {
      throw new HttpError(404, error.message);
    }
    if (error instanceof SavedNameError) {
      throw new HttpError(400, error.message);
    }
    throw error;
  }
}

export async function startServiceServer(
  port?: number,
  deps: ServiceServerDeps = {},
): Promise<http.Server> {
  const config = deps.config ?? loadConfig();
  const listenPort = port ?? config.webPort;
  const apiToken = deps.apiToken ?? requireApiToken(config);
  const corsOrigins = deps.corsOrigins ?? config.corsOrigins;
  const processedDir = deps.processedDir ?? config.processedDir;
  const savedDir = deps.savedDir ?? config.savedDir;
  const historyDir = deps.historyDir ?? config.historyDir;

  const busy = { current: false };
  const session =
    deps.session ??
    createBrowserSession({
      launch: launchLightChromium,
      screenshotDir: processedDir,
    });
  await ensureCreateDefaultFile(savedDir);
  const runTask: AgentRunner =
    deps.runTask ??
    ((task, model, extras) =>
      runAgent(task, config, confirmSafetyForWeb, session, model, extras));
  const reportAutomation = deps.reportAutomation ?? createAutomationReporter(config);
  const savedRun = createSavedRunManager({
    savedDir,
    historyDir,
    processedDir,
    config,
    runTask: deps.savedRunTask,
    createSession: deps.createSavedRunSession,
    reportAutomation,
  });

  const server = http.createServer((request, response) => {
    void (async () => {
      const pathname = requestPath(request);
      const method = request.method ?? "GET";
      logger.info(`${method} ${pathname}`);

      const cors = applyCors(request, response, corsOrigins);

      try {
        if (method === "OPTIONS") {
          send(response, 204, "", {
            ...cors,
            "Access-Control-Allow-Methods":
              (cors["Access-Control-Allow-Methods"] as string | undefined) ??
              "GET, POST, PUT, DELETE, OPTIONS",
            "Access-Control-Allow-Headers":
              (cors["Access-Control-Allow-Headers"] as string | undefined) ??
              "Authorization, Content-Type",
          });
          return;
        }

        if (pathname === "/v1/health") {
          handleHealth(request, response, cors);
          return;
        }

        if (!isAuthorized(request.headers.authorization, apiToken)) {
          sendJson(response, 401, { error: "Unauthorized" }, cors);
          return;
        }

        if (pathname === "/v1/screenshot") {
          await handleScreenshotRequest(request, response, processedDir, cors);
          return;
        }

        if (pathname === "/v1/models") {
          await handleModelsRequest(request, response, cors);
          return;
        }

        if (pathname === "/v1/agent") {
          await handleAgentRequest(
            request,
            response,
            runTask,
            session,
            busy,
            processedDir,
            cors,
            reportAutomation,
          );
          return;
        }

        if (pathname === "/v1/agent/safety") {
          await handleAgentSafety(request, response, cors);
          return;
        }

        if (pathname === "/v1/saved") {
          if (request.method === "GET") {
            await handleSavedList(request, response, savedDir, cors);
            return;
          }

          await handleSavedCreate(request, response, savedDir, cors);
          return;
        }

        if (pathname === "/v1/saved/run") {
          await handleSavedRunStart(request, response, savedRun, cors);
          return;
        }

        if (pathname === "/v1/saved/running") {
          handleSavedRunningList(request, response, savedRun, cors);
          return;
        }

        if (
          pathname === "/v1/saved/create-default.json" ||
          pathname === "/v1/saved/create-default"
        ) {
          await handleCreateDefault(request, response, savedDir, cors);
          return;
        }

        if (pathname.startsWith("/v1/saved/")) {
          await handleSavedItem(request, response, pathname, savedDir, cors);
          return;
        }

        if (pathname === "/v1/history") {
          await handleHistoryList(request, response, historyDir, cors);
          return;
        }

        if (pathname === "/v1/history/detail") {
          await handleHistoryDetail(request, response, historyDir, processedDir, cors);
          return;
        }

        if (pathname === "/v1/history/status") {
          await handleHistoryStatus(request, response, historyDir, processedDir, cors);
          return;
        }

        if (pathname === "/v1/history/stop") {
          await handleHistoryStop(request, response, savedRun, historyDir, cors);
          return;
        }

        if (pathname === "/v1/session") {
          handleSessionStatus(request, response, session, cors);
          return;
        }

        if (pathname === "/v1/session/back") {
          await handleSessionNavigate(request, response, session, busy, "back", cors);
          return;
        }

        if (pathname === "/v1/session/forward") {
          await handleSessionNavigate(request, response, session, busy, "forward", cors);
          return;
        }

        if (pathname === "/v1/session/reload") {
          await handleSessionNavigate(request, response, session, busy, "reload", cors);
          return;
        }

        sendJson(response, 404, { error: "Not found" }, cors);
      } catch (error: unknown) {
        if (error instanceof HttpError) {
          sendJson(response, error.status, { error: error.message }, cors);
          return;
        }

        logger.error("Failed to handle request", error);
        sendJson(response, 500, { error: errorMessage(error) }, cors);
      }
    })();
  });

  serverSessions.set(server, session);
  serverSavedRuns.set(server, savedRun);

  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => reject(error);
      server.once("error", onError);
      server.listen(listenPort, "127.0.0.1", () => {
        server.removeListener("error", onError);
        const address = server.address();
        const actualPort = typeof address === "object" && address ? address.port : listenPort;
        logger.info(`Spotcheck service listening at http://127.0.0.1:${actualPort}`);
        resolve();
      });
    });
  } catch (error: unknown) {
    serverSessions.delete(server);
    serverSavedRuns.delete(server);
    await session.close();
    throw error;
  }

  activeServer = server;
  return server;
}

export async function closeServiceServer(server: http.Server | undefined): Promise<void> {
  if (!server) {
    return;
  }

  const session = serverSessions.get(server);
  serverSessions.delete(server);
  const savedRun = serverSavedRuns.get(server);
  serverSavedRuns.delete(server);

  if (savedRun) {
    try {
      await savedRun.close();
    } catch (error: unknown) {
      logger.error("Failed to close saved run", error);
    }
  }

  if (session) {
    try {
      await session.close();
    } catch (error: unknown) {
      logger.error("Failed to close browser session", error);
    }
  }

  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}

async function shutdown(exitCode: number, reason: string): Promise<never> {
  if (shuttingDown) {
    process.exit(exitCode);
  }

  shuttingDown = true;
  logger.info(reason);
  await closeServiceServer(activeServer);
  activeServer = undefined;
  process.exit(exitCode);
}

function registerShutdownHandlers(): void {
  const onSignal = (signal: NodeJS.Signals): void => {
    void shutdown(0, `Received ${signal}, shutting down`);
  };

  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
}

async function main(): Promise<void> {
  registerShutdownHandlers();
  const config = loadConfig();
  requireApiToken(config);
  await startServiceServer(config.webPort, { config });
}

if (isMainModule(import.meta.url)) {
  main().catch((error: unknown) => {
    logger.error("Fatal error", error);
    void shutdown(1, "Exiting after fatal error");
  });
}
