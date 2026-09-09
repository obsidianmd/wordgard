import {GardState} from "wordgard/state"

export function eqArray<T extends {eq(b: T): boolean}>(a?: readonly T[] | null, b?: readonly T[] | null) {
  if (!a || !b) return a == b
  if (a == b) return true
  if (a.length != b.length) return false
  for (let i = 0; i < a.length; i++) if (!a[i].eq(b[i])) return false
  return true
}

export const exceptionSink = GardState.Facet.define<(exception: any) => void>()

export function logException(state: GardState, exception: any, context?: string) {
  let handler = state.facet(exceptionSink)
  if (handler.length) handler[0](exception)
  else if (window.onerror) window.onerror(String(exception), context, undefined, undefined, exception)
  else if (context) console.error(context + ":", exception)
  else console.error(exception)
}

// Perform a binary search on the given array (starting at start) and
// return the index of the first element > n (or the length if no such
// element exists).
export function findAbove(array: readonly number[], start: number, n: number) {
  let from = start, to = array.length
  for (;;) {
    if (from == to) return from
    let mid = (from + to) >> 1
    if (array[mid] > n) to = mid
    else from = mid + 1
  }
}
