const HEALTH_REQUEST_TIMEOUT_MS = 3_000;
const HEALTH_RETRY_DELAY_MS = 1_000;

function abortReason(signal: AbortSignal, fallback = new Error('Aborted')): Error {
  return signal.reason instanceof Error ? signal.reason : fallback;
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(abortReason(signal));
      return;
    }
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(abortReason(signal));
      },
      { once: true },
    );
  });
}

export async function waitForTrueForge({
  baseUrl,
  signal,
  requestTimeoutMs = HEALTH_REQUEST_TIMEOUT_MS,
  retryDelayMs = HEALTH_RETRY_DELAY_MS,
}: {
  baseUrl: string;
  signal: AbortSignal;
  requestTimeoutMs?: number;
  retryDelayMs?: number;
}): Promise<void> {
  const healthUrl = `${baseUrl.replace(/\/$/, '')}/healthz`;
  while (!signal.aborted) {
    try {
      const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(requestTimeoutMs)]);
      const response = await fetch(healthUrl, { signal: requestSignal });
      if (response.ok) {
        return;
      }
    } catch {
      // TrueForge and the bridge start together in the local demo.
    }
    await abortableDelay(retryDelayMs, signal);
  }
  throw abortReason(signal);
}
