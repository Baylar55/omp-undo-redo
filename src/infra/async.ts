import "./compat.js";
/** True when `ms` elapsed before `promise` settled. The promise keeps running;
 *  callers use this only to stop waiting, never to abandon the work. */
export async function timedOutAfter(promise: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(true), Math.max(1, ms));
    timer.unref?.();
  });
  try {
    return await Promise.race([promise.then(() => false), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export function track(
  operation: () => Promise<void>,
  operations: Set<Promise<void>>,
): Promise<void> {
  const { promise: tracked, resolve, reject } = Promise.withResolvers<void>();
  operations.add(tracked);
  void (async () => {
    try {
      await operation();
      resolve();
    } catch (error) {
      reject(error);
    } finally {
      operations.delete(tracked);
    }
  })();
  return tracked;
}
