export function logInfo(tool: string, message: string, extra?: Record<string, unknown>): void {
  console.log(JSON.stringify({ level: 'INFO', tool, message, ...extra }));
}

export function logError(tool: string, message: string, err?: unknown, extra?: Record<string, unknown>): void {
  console.error(JSON.stringify({
    level: 'ERROR',
    tool,
    message,
    error: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
    ...extra,
  }));
}
