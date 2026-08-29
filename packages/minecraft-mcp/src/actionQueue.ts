export class MinecraftActionQueue {
  private tail: Promise<void> = Promise.resolve();

  run<T>({ signal, operation }: { signal: AbortSignal; operation: () => Promise<T> }): Promise<T> {
    const execute = async (): Promise<T> => {
      if (signal.aborted) {
        throw new Error('Minecraft action was cancelled before execution.');
      }
      return await operation();
    };

    const result = this.tail.then(execute, execute);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
