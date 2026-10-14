/** A small typed event emitter: no Node or DOM dependency, so it runs in React Native too. */
export class Emitter<Events extends object> {
  private handlers: { [K in keyof Events]?: Set<(payload: Events[K]) => void> } = {};

  on<K extends keyof Events>(event: K, handler: (payload: Events[K]) => void): () => void {
    (this.handlers[event] ??= new Set()).add(handler);
    return () => this.off(event, handler);
  }

  off<K extends keyof Events>(event: K, handler: (payload: Events[K]) => void): void {
    this.handlers[event]?.delete(handler);
  }

  protected emit<K extends keyof Events>(event: K, payload: Events[K]): void {
    for (const handler of this.handlers[event] ?? []) {
      try {
        handler(payload);
      } catch (err) {
        // a listener that throws must not stop the reader
        console.error(`[freya] "${String(event)}" listener failed`, err);
      }
    }
  }
}
