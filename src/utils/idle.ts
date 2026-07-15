// Yield to the browser between bounded work slices so background passes never
// monopolize the main thread. requestIdleCallback runs the next slice only when
// the page is idle; the timeout guarantees forward progress on a busy page. In
// Node (unit tests) there is no requestIdleCallback, so a macrotask stands in.
export function whenIdle(): Promise<void> {
  return new Promise((resolve) => {
    const ric = (globalThis as { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => void })
      .requestIdleCallback
    if (typeof ric === 'function') ric(() => resolve(), { timeout: 200 })
    else setTimeout(resolve, 0)
  })
}
