const SECRET_PATTERN = /(secret|token|password|api[_-]?key|private[_-]?key)/i;

function shouldRedact(key: string): boolean {
  return !key.startsWith("NEXT_PUBLIC_") && SECRET_PATTERN.test(key);
}

export function redactSecrets(values: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(values).map(([key, value]) => {
      if (!shouldRedact(key)) {
        return [key, value];
      }

      if (typeof value !== "string" || value.length <= 4) {
        return [key, "[REDACTED]"];
      }

      return [key, `[REDACTED:${value.slice(-4)}]`];
    }),
  );
}
