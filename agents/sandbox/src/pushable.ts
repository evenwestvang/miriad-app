/**
 * Pushable - Async iterator that allows pushing values mid-iteration
 *
 * Used for mid-turn message injection in SDK conversations.
 * Push user messages while iterating over SDK responses.
 */

export class Pushable<T> implements AsyncIterable<T> {
  private queue: T[] = [];
  private resolvers: Array<(result: IteratorResult<T>) => void> = [];
  private ended = false;

  /**
   * Push a value to be yielded by the iterator.
   * If the iterator is waiting, the value is immediately yielded.
   * Otherwise, it's queued for the next iteration.
   */
  push(value: T): void {
    if (this.ended) return;

    if (this.resolvers.length > 0) {
      // Iterator is waiting - resolve immediately
      const resolve = this.resolvers.shift()!;
      resolve({ value, done: false });
    } else {
      // Iterator not waiting - queue the value
      this.queue.push(value);
    }
  }

  /**
   * Signal that no more values will be pushed.
   * The iterator will complete after yielding any queued values.
   */
  end(): void {
    this.ended = true;

    // Resolve all waiting iterators with done
    for (const resolve of this.resolvers) {
      resolve({ value: undefined as T, done: true });
    }
    this.resolvers = [];
  }

  /**
   * Check if the pushable has been ended.
   */
  get isEnded(): boolean {
    return this.ended;
  }

  /**
   * Get the number of queued values.
   */
  get queueLength(): number {
    return this.queue.length;
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    while (true) {
      if (this.queue.length > 0) {
        // Yield queued values first
        yield this.queue.shift()!;
      } else if (this.ended) {
        // No more values and ended - complete
        return;
      } else {
        // Wait for next push or end
        const result = await new Promise<IteratorResult<T>>((resolve) => {
          this.resolvers.push(resolve);
        });

        if (result.done) {
          return;
        }

        yield result.value;
      }
    }
  }
}
