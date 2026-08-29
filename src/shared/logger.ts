export const logger = {
  info(message: string): void {
    console.log(`[${new Date().toISOString()}] INFO  ${message}`);
  },
  error(message: string, error?: unknown): void {
    const detail = error instanceof Error ? error.stack ?? error.message : String(error ?? "");
    console.error(`[${new Date().toISOString()}] ERROR ${message}${detail ? `\n${detail}` : ""}`);
  },
};
