import path from "node:path";
import { AgentRunError, runAgent, type AgentRunExtras, type AgentRunResult } from "../computer-use/index.js";
import { launchLightChromium } from "../playwright/chromium.js";
import { SAVED_RUNS_SUBDIR, savedRunItemScreenshotDir, savedRunScreenshotStem } from "../playwright/processed.js";
import { createBrowserSession, type BrowserSession } from "../playwright/session.js";
import type { AppConfig } from "../shared/config.js";
import { createAutomationReporter, type AutomationReporter } from "../shared/telemetry.js";
import { computeCostUsd, EMPTY_USAGE } from "../shared/cost.js";
import { logger } from "../shared/logger.js";
import { getModelEntry, loadModels } from "../shared/models.js";
import {
  createHistoryDocument,
  makeHistoryFileName,
  readHistoryFile,
  writeHistoryFile,
  type HistoryDocument,
  type HistoryItem,
} from "./history.js";
import {
  CREATE_DEFAULT_FILE,
  isCreateDefaultFileName,
  normalizeSavedFileName,
  readSavedFile,
  SavedNameError,
  type SavedPromptItem,
} from "./saved.js";

export class SavedRunBusyError extends Error {
  constructor(message = "Saved run already running for this file") {
    super(message);
    this.name = "SavedRunBusyError";
  }
}

export class SavedRunLimitError extends Error {
  constructor(message = "Saved run limit reached") {
    super(message);
    this.name = "SavedRunLimitError";
  }
}

export class SavedRunNotRunningError extends Error {
  constructor(message = "No running saved execution") {
    super(message);
    this.name = "SavedRunNotRunningError";
  }
}

export class SavedRunFinishedError extends Error {
  constructor(message = "Saved run already finished") {
    super(message);
    this.name = "SavedRunFinishedError";
  }
}

export type SavedRunTask = (
  task: string,
  model: string,
  session: BrowserSession,
  extras?: AgentRunExtras,
  screenshotDir?: string,
) => Promise<AgentRunResult>;

export interface SavedRunManagerDeps {
  readonly savedDir: string;
  readonly historyDir: string;
  readonly processedDir: string;
  readonly config: AppConfig;
  readonly runTask?: SavedRunTask;
  readonly createSession?: (screenshotDir: string) => BrowserSession;
  readonly now?: () => Date;
  readonly reportAutomation?: AutomationReporter;
}

interface ActiveSavedRun {
  readonly savedFileName: string;
  readonly historyFile: string;
  readonly abort: AbortController;
  readonly session: BrowserSession;
  done: Promise<void>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function denySavedRunSafety(): Promise<boolean> {
  throw new AgentRunError("Safety confirmation denied", EMPTY_USAGE);
}

function patchItem(
  document: HistoryDocument,
  sequence: number,
  patch: Partial<HistoryItem> & { status: HistoryItem["status"] },
): HistoryDocument {
  return {
    ...document,
    current: sequence,
    items: document.items.map((item) =>
      item.sequence === sequence
        ? {
            sequence: item.sequence,
            id: item.id,
            prompt: item.prompt,
            model: item.model,
            status: patch.status,
            ...(patch.resultText !== undefined ? { resultText: patch.resultText } : {}),
            ...(patch.costUsd !== undefined ? { costUsd: patch.costUsd } : {}),
            ...(patch.error !== undefined ? { error: patch.error } : {}),
          }
        : item,
    ),
  };
}

export function createSavedRunManager(deps: SavedRunManagerDeps) {
  const createSession =
    deps.createSession ??
    ((screenshotDir: string) =>
      createBrowserSession({
        launch: launchLightChromium,
        screenshotDir,
      }));
  const reportAutomation = deps.reportAutomation ?? createAutomationReporter(deps.config);

  const active = new Map<string, ActiveSavedRun>();

  async function persist(historyFile: string, document: HistoryDocument): Promise<HistoryDocument> {
    await writeHistoryFile(historyFile, document, deps.historyDir);
    return document;
  }

  async function costFor(model: string, usage: AgentRunResult["usage"]): Promise<number> {
    try {
      const models = await loadModels();
      return computeCostUsd(usage ?? EMPTY_USAGE, getModelEntry(model, models));
    } catch {
      return 0;
    }
  }

  function callTask(
    task: string,
    model: string,
    session: BrowserSession,
    screenshotDir: string,
    extras: AgentRunExtras,
  ): Promise<AgentRunResult> {
    if (deps.runTask) {
      return deps.runTask(task, model, session, extras, screenshotDir);
    }

    return runAgent(
      task,
      { ...deps.config, processedDir: screenshotDir },
      denySavedRunSafety,
      session,
      model,
      { ...extras, confirmSafety: extras.confirmSafety ?? denySavedRunSafety },
    );
  }

  function findActiveByHistoryFile(historyFile: string): ActiveSavedRun | undefined {
    for (const run of active.values()) {
      if (run.historyFile === historyFile) {
        return run;
      }
    }

    return undefined;
  }

  async function execute(
    savedFileName: string,
    historyFile: string,
    items: readonly SavedPromptItem[],
    session: BrowserSession,
    abort: AbortController,
  ): Promise<void> {
    let document = await readHistoryFile(historyFile, deps.historyDir);

    try {
      await session.ensurePage(deps.config);

      for (const item of items) {
        if (abort.signal.aborted) {
          document = await persist(historyFile, { ...document, status: "stopped" });
          return;
        }

        if (!item.prompt.trim()) {
          document = await persist(historyFile, patchItem(document, item.sequence, { status: "skipped" }));
          continue;
        }

        document = await persist(historyFile, patchItem(document, item.sequence, { status: "running" }));

        try {
          const startedAt = new Date();
          const result = await callTask(
            item.prompt,
            item.model,
            session,
            savedRunItemScreenshotDir(deps.processedDir, historyFile, item.sequence, item.id),
            {
              signal: abort.signal,
              confirmSafety: denySavedRunSafety,
            },
          );
          if (abort.signal.aborted) {
            document = await persist(historyFile, { ...document, status: "stopped" });
            return;
          }

          reportAutomation(startedAt, new Date());
          const costUsd = await costFor(item.model, result.usage);
          document = await persist(
            historyFile,
            patchItem(document, item.sequence, {
              status: "done",
              resultText: result.text,
              costUsd,
            }),
          );
        } catch (error: unknown) {
          if (abort.signal.aborted || (error instanceof AgentRunError && error.message === "Agent stopped")) {
            document = await persist(historyFile, { ...document, status: "stopped" });
            return;
          }

          const usage = error instanceof AgentRunError ? error.usage : EMPTY_USAGE;
          const costUsd = await costFor(item.model, usage);
          document = await persist(historyFile, {
            ...patchItem(document, item.sequence, {
              status: "error",
              error: errorMessage(error),
              costUsd,
            }),
            status: "error",
          });
          return;
        }
      }

      if (document.status === "running" && !abort.signal.aborted) {
        await persist(historyFile, { ...document, status: "done", current: document.total });
      } else if (abort.signal.aborted && document.status === "running") {
        await persist(historyFile, { ...document, status: "stopped" });
      }
    } catch (error: unknown) {
      logger.error("Saved run failed", error);
      if (document.status === "running") {
        await persist(historyFile, {
          ...document,
          status: abort.signal.aborted ? "stopped" : "error",
        });
      }
    } finally {
      try {
        await session.close();
      } catch (error: unknown) {
        logger.error("Failed to close saved-run browser", error);
      }
      const current = active.get(savedFileName);
      if (current?.historyFile === historyFile) {
        active.delete(savedFileName);
      }
    }
  }

  return {
    async start(savedFileName: string): Promise<string> {
      if (isCreateDefaultFileName(savedFileName)) {
        throw new SavedNameError(`${CREATE_DEFAULT_FILE} is reserved`);
      }

      const saved = await readSavedFile(savedFileName, deps.savedDir);
      if (active.has(saved.fileName)) {
        throw new SavedRunBusyError();
      }

      if (active.size >= deps.config.maxSavedRuns) {
        throw new SavedRunLimitError();
      }

      const historyFile = makeHistoryFileName(saved.fileName, deps.now?.() ?? new Date());
      const screenshotDir = path.join(
        deps.processedDir,
        SAVED_RUNS_SUBDIR,
        savedRunScreenshotStem(historyFile),
      );
      const session = createSession(screenshotDir);
      const abort = new AbortController();
      const run: ActiveSavedRun = {
        savedFileName: saved.fileName,
        historyFile,
        abort,
        session,
        done: Promise.resolve(),
      };
      active.set(saved.fileName, run);

      try {
        await persist(historyFile, createHistoryDocument(saved.fileName, saved.items));
      } catch (error: unknown) {
        active.delete(saved.fileName);
        await session.close();
        throw error;
      }

      run.done = execute(saved.fileName, historyFile, saved.items, session, abort);
      return historyFile;
    },

    async stop(historyFileName: string): Promise<void> {
      const name = normalizeSavedFileName(historyFileName);
      const current = findActiveByHistoryFile(name);
      if (!current) {
        const document = await readHistoryFile(name, deps.historyDir);
        if (document.status !== "running") {
          throw new SavedRunFinishedError();
        }

        throw new SavedRunNotRunningError();
      }

      current.abort.abort();
      await current.done;
    },

    async close(): Promise<void> {
      const runs = [...active.values()];
      for (const run of runs) {
        run.abort.abort();
      }

      await Promise.all(runs.map((run) => run.done));
    },

    listRunning(): string[] {
      return [...active.keys()].sort((left, right) => left.localeCompare(right));
    },
  };
}

export type SavedRunManager = ReturnType<typeof createSavedRunManager>;
