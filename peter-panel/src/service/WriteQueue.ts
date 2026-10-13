/** Runs async jobs one at a time, so writes to the workbook never interleave. */
export class WriteQueue {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(job: () => Promise<T>): Promise<T> {
    const result = this.tail.then(job, job);
    this.tail = result.catch(() => undefined);
    return result;
  }

  /** Resolves once every job queued so far has finished. */
  async idle(): Promise<void> {
    await this.tail;
  }
}
