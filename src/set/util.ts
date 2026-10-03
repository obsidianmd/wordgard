import {ChangeSet} from "wordgard/doc"

/// Perform a binary search on the given array (starting at start) and
/// return the index of the first element > n (or the length if no
/// such element exists) @hidden
export function findAbove(array: readonly number[], start: number, n: number) {
  let from = start, to = array.length
  for (;;) {
    if (from == to) return from
    let mid = (from + to) >> 1
    if (array[mid] > n) to = mid
    else from = mid + 1
  }
}

export function heapBubble<T>(heap: T[], index: number, cmp: (a: T, b: T) => number) {
  for (let cur = heap[index];;) {
    let childIndex = (index << 1) + 1
    if (childIndex >= heap.length) break
    let child = heap[childIndex]
    if (childIndex + 1 < heap.length && cmp(child, heap[childIndex + 1]) >= 0) {
      child = heap[childIndex + 1]
      childIndex++
    }
    if (cmp(cur, child) < 0) break
    heap[childIndex] = cur
    heap[index] = child
    index = childIndex
  }
}

export function heapSink<T>(heap: T[], index: number, cmp: (a: T, b: T) => number) {
  let elt = heap[index]
  while (index > 0) {
    let parent = (index - 1) >> 1
    if (cmp(heap[parent], elt) < 0) break
    heap[index] = heap[parent]
    heap[parent] = elt
    index = parent
  }
}

export function heapPop<T>(heap: T[], cmp: (a: T, b: T) => number) {
  let last = heap.pop()!
  if (heap.length) {
    heap[0] = last
    heapBubble(heap, 0, cmp)
  }
}

export function addReplacements(changes: ChangeSet, replace: readonly {from: number, to: number}[]) {
  let add: number[] = [], at = 0, len = changes.newLength
  for (let repl of replace) {
    if (repl.from < at) throw new Error("Replacing ranges must be ordered and non-overlapping")
    if (repl.to > len) throw new Error("Replacing range out of bounds")
    if (repl.from > at) add.push(repl.from - at, -1)
    add.push(repl.to - repl.from, repl.to - repl.from)
    at = repl.to
  }        
  if (len > at) add.push(len - at, -1)
  return ChangeSet.composeSections(changes.sections, add)
}
