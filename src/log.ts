/**
 * stdout is the MCP transport. Every diagnostic goes to stderr, never stdout.
 */
export function log(message: string): void {
  process.stderr.write(`[copilot-studio-mcp] ${message}\n`);
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
