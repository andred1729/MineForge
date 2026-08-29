export class MinecraftActionQueue {
  private tail: Promise<void> = Promise.resolve();
  private activeController: AbortController | null = null;

  run<T>({
    signal,
    operation,
    onAbort,
  }: {
    signal: AbortSignal;
    operation: (activeSignal: AbortSignal) => Promise<T>;
    onAbort: () => void;
  }): Promise<T> {
    const handleAbort = () => {
      try {
        onAbort();
      } finally {
        this.cancelActive();
      }
    };
    signal.addEventListener('abort', handleAbort, { once: true });
    if (signal.aborted) {
      handleAbort();
    }

    const execute = async (): Promise<T> => {
      if (signal.aborted) {
        throw new Error('Minecraft action was cancelled before execution.');
      }
      const controller = new AbortController();
      this.activeController = controller;
      try {
        return await operation(controller.signal);
      } finally {
        if (this.activeController === controller) {
          this.activeController = null;
        }
      }
    };

    const result = this.tail.then(execute, execute);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    void result.then(
      () => {
        signal.removeEventListener('abort', handleAbort);
      },
      () => {
        signal.removeEventListener('abort', handleAbort);
      },
    );
    return result;
  }

  cancelActive(): void {
    this.activeController?.abort();
  }
}
