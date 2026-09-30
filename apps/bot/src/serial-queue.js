export class SerialQueue {
  #tails = new Map();

  run(key, task) {
    const previous = this.#tails.get(key) ?? Promise.resolve();
    const current = previous
      .catch(() => {})
      .then(task);
    this.#tails.set(key, current);
    void current
      .finally(() => {
        if (this.#tails.get(key) === current) {
          this.#tails.delete(key);
        }
      })
      .catch(() => {});
    return current;
  }

  async drain() {
    await Promise.allSettled([...this.#tails.values()]);
  }
}
