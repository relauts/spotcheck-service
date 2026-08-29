export function parseAgentTask(argv: readonly string[]): string {
  const task = argv.slice(2).join(" ").trim();
  if (!task) {
    throw new Error('Usage: npm run agent -- "<task>"');
  }

  return task;
}
