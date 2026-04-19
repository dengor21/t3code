function normalizeScopedHostName(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

export function shouldReuseDraftForThreadStart(input: {
  requestedScopedHostName?: string | null;
  existingScopedHostName?: string | null;
  existingPrompt?: string | null;
}): boolean {
  const requestedScopedHostName = normalizeScopedHostName(input.requestedScopedHostName);
  if (requestedScopedHostName === null) {
    return true;
  }

  const existingScopedHostName = normalizeScopedHostName(input.existingScopedHostName);
  if (existingScopedHostName === requestedScopedHostName) {
    return true;
  }

  return (input.existingPrompt ?? "").trim().length === 0;
}
