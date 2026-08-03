// Minimal synchronous event bus. Every cross-module message in the game goes through here so
// that modules authored independently never need to import each other. Handlers are copied
// before dispatch so a handler may safely unsubscribe itself mid-emit.

export function createEventBus() {
  const map = new Map();
  let depth = 0;

  return {
    on(name, fn) {
      if (!map.has(name)) map.set(name, new Set());
      map.get(name).add(fn);
      return () => this.off(name, fn);
    },
    once(name, fn) {
      const off = this.on(name, (p) => {
        off();
        fn(p);
      });
      return off;
    },
    off(name, fn) {
      map.get(name)?.delete(fn);
    },
    emit(name, payload) {
      const set = map.get(name);
      if (!set || set.size === 0) return;
      if (depth > 32) {
        console.warn('[events] recursion guard tripped on', name);
        return;
      }
      depth++;
      try {
        for (const fn of [...set]) {
          try {
            fn(payload);
          } catch (err) {
            console.error(`[events] handler for "${name}" threw:`, err);
          }
        }
      } finally {
        depth--;
      }
    },
    clear() {
      map.clear();
    },
  };
}
