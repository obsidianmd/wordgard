import {ChangeSet} from "wordgard/doc"
import {findAbove, heapSink, heapBubble, heapPop, addReplacements} from "./util"

const enum ChunkSize { Max = 512 }

class Chunk<T extends RangeSet.Value> {
  constructor(
    readonly start: number,
    readonly from: number[],
    readonly to: number[],
    readonly value: T[]
  ) {}

  get end() {
    return this.start + this.to[this.to.length - 1]
  }

  move(start: number) {
    return start == this.start ? this : new Chunk(start, this.from, this.to, this.value)
  }
}

class SetBuilder<T extends RangeSet.Value> {
  chunks: Chunk<T>[] = []
  spilled: SetBuilder<T> | null = null
  lastTo = -1
  lastFrom = -1

  get next() {
    return this.spilled || (this.spilled = new SetBuilder<T>())
  }

  addChunk(chunk: Chunk<T>) {
    if (chunk.start < this.lastTo) {
      this.next.addChunk(chunk)
    } else {
      this.chunks.push(chunk)
      this.lastTo = chunk.end
    }
  }

  add(source: RangeSet.Source<T>, pre?: (from: number, to: number) => void) {
    if (typeof source != "function") {
      let array = source
      source = add => { for (let [from, to, value] of array) add(from, to, value) }
    }
    source((from, to, value) => {
      if (pre) pre(from, to)
      this.addRange(from, to, value)
    })
  }

  addRange(from: number, to: number, value: T) {
    if (from >= to) throw new Error("Ranges cannot be empty")
    ;(this.lastTo <= from ? this : this.next).addInner(from, to, value)
  }

  addInner(from: number, to: number, value: T) {
    let chunk: Chunk<T> | undefined
    if (this.chunks.length) {
      chunk = this.chunks[this.chunks.length - 1]
      if (chunk.value.length >= ChunkSize.Max) chunk = undefined
    }
    if (!chunk) {
      this.chunks.push(chunk = new Chunk(from, [], [], []))
    }
    chunk.from.push(from - chunk.start)
    chunk.to.push(to - chunk.start)
    chunk.value.push(value)
    this.lastFrom = from
    this.lastTo = to
  }

  finish(plus: RangeSet<T> | null = null): RangeSet<T> {
    let next = this.spilled ? this.spilled.finish(plus) : plus
    if (!this.chunks.length) return next || RangeSet.empty
    return RangeSet.new(this.chunks, next)
  }
}

/// Data structure that stores sets of ranges, for use with {@link
/// Decoration.Range range decorations} or other data types
/// implementing {@link RangeSet.Value}.
export class RangeSet<T extends RangeSet.Value> {
  private constructor(
    /// @internal
    readonly chunks: readonly Chunk<T>[],
    /// @internal
    readonly next: RangeSet<T> | null
  ) {}

  /// @internal
  static new<T extends RangeSet.Value>(chunks: readonly Chunk<T>[], next: RangeSet<T> | null) {
    return new RangeSet(chunks, next)
  }

  /// Create a range set from an iterable of `[from, to, value]`
  /// tuples, or a function that calls its argument for every range to
  /// add.
  static create<T extends RangeSet.Value>(
    source: RangeSet.Source<T>
  ): RangeSet<T> {
    let build = new SetBuilder<T>()
    build.add(source, from => {
      if (from < build.lastFrom) throw new Error("Ranges must be added in order")
    })
    return build.finish()
  }

  /// The number of ranges stored in this set.
  get length(): number {
    return Math.max(this.chunks.length ? this.chunks[this.chunks.length - 1].end : 0, this.next ? this.next.length : 0)
  }

  /// Returns true when this set is empty.
  get empty() {
    return this == RangeSet.empty
  }

  /// Create a cursor over this set, starting at the given position.
  cursor(from = 0): RangeSet.Cursor<T> {
    if (!this.next) return new LayerCursor(this.chunks, from)
    let cursors: LayerCursor<T>[] = []
    for (let layer: RangeSet<T> | null = this; layer; layer = layer.next)
      cursors.push(new LayerCursor(layer.chunks, from))
    return new HeapCursor(cursors)
  }

  /// Create a cursor over a collection of range sets.
  static cursor<T extends RangeSet.Value>(sets: readonly RangeSet<T>[], from = 0): RangeSet.Cursor<T> {
    let cursors: LayerCursor<T>[] = []
    for (let set of sets) if (!set.empty) {
      for (let layer: RangeSet<T> | null = set; layer; layer = layer.next)
        cursors.push(new LayerCursor(layer.chunks, from))
    }
    return cursors.length == 0 ? RangeSet.empty.cursor() : cursors.length == 1 ? cursors[0] : new HeapCursor(cursors)
  }

  /// Adjust the positions of the ranges for the given change set.
  /// Returns a set with the updated ranges. Optionally takes an array
  /// of replacement ranges. Any ranges overlapping such a replacement
  /// will be dropped, and new ranges provided by their `add`
  /// properties will be added to the new set.
  map(map: ChangeSet, replace: readonly RangeSet.Replacement<T>[] = []) {
    let {sections} = map
    if (replace.length) sections = addReplacements(map, replace)
    else if (map.empty) return this
    return this.mapInner(sections, map, replace)
  }

  private mapInner(sections: ChangeSet.Sections, map: ChangeSet, replace: readonly RangeSet.Replacement<T>[]): RangeSet<T> {
    let cursor = new LayerCursor(this.chunks, 0)
    let replI = 0, posA = 0, posB = 0
    let build = new SetBuilder<T>()
    for (let i = 0; i < sections.length;) {
      let len = sections[i++], ins = sections[i++]
      if (ins < 0) {
        while (i < sections.length && sections[i + 1] < 0) {
          len += sections[i]
          i += 2
        }
        let upto = i == sections.length ? 1e9 : posA + len, off = posB - posA
        // Unchanged range. Copy over ranges and chunks entirely inside.
        while (cursor.cur) {
          let chunk = cursor.cur
          if (cursor.i == 0 && chunk.end < upto) {
            build.addChunk(chunk.move(chunk.start + off))
            cursor.next(true)
          } else if (cursor.to < upto) {
            build.addRange(cursor.from + off, cursor.to + off, cursor.value!)
            cursor.next()
          } else {
            break
          }
        }
        posB += len
      } else {
        // Iterate over replacements in this change's range, copy over
        // mapped version of ranges covering its start and end before
        // and after.
        let replStartI = replI, endB = posB + ins
        copyMappedUpto(cursor, posA, map, build, replace, replStartI)
        while (replI < replace.length && replace[replI].from < endB) {
          let repl = replace[replI++]
          if (repl.add) build.add(repl.add)
        }
        if (len) cursor.goto(posA + len - 1)
        copyMappedUpto(cursor, posA + len, map, build, replace, replStartI)
        posB = endB
      }
      posA += len
    }
    return build.finish(this.next && this.next.mapInner(sections, map, replace))
  }

  /// Modify this set.
  modify(spec: {
    /// Drop any ranges inside the given replacement ranges,
    /// optionally add new ranges provided by their `add` property.
    replace?: readonly RangeSet.Replacement<T>[],
    /// Add new ranges to the set.
    add?: RangeSet.Source<T>,
    /// Drop any range for which this predicate function returns
    /// `false`.
    filter?: (from: number, to: number, value: T) => boolean
  }) {
    let {replace, add, filter} = spec
    let result: RangeSet<T> = this
    if (replace && replace.length) {
      result = result.map(ChangeSet.empty(Math.max(result.length, replace[replace.length - 1].to)), replace)
    }
    return add || filter ? result.modifyInner(add, filter) : result
  }

  private modifyInner(add: RangeSet.Source<T> | undefined, filter?: (from: number, to: number, value: T) => boolean): RangeSet<T> {
    let build = new SetBuilder<T>()
    let cursor = new LayerCursor(this.chunks, 0)
    let advance = (pos: number) => {
      for (;;) {
        let {cur} = cursor
        if (!cur) return
        if (cursor.i == 0 && cur.end <= pos && !filter) {
          build.addChunk(cur)
          cursor.next(true)
        } else if (cursor.from > pos) {
          break
        } else {
          if (!filter || filter(cursor.from, cursor.to, cursor.value!))
            build.addRange(cursor.from, cursor.to, cursor.value!)
          cursor.next()
        }
      }
    }
    if (add) build.add(add, advance)
    advance(1e9)
    return build.finish(this.next && this.next.modifyInner(add, filter))
  }

  /// Compare a section of this set with a section of the same length
  /// in another set. Calls `change` for any range where the two do
  /// not contain identical ranges.
  compareRange(fromA: number, b: RangeSet<T>, fromB: number, len: number, change: (from: number, to: number) => void) {
    if (this == b) return
    let curA = new LayerCursor(this.chunks, fromA), curB = new LayerCursor(b.chunks, fromB), off = fromB - fromA
    let end = fromB + len, startA = -1, endA = -1, startB = -1, endB = -1
    for (;;) {
      if (startA >= endA)
        [startA, endA] = curA.value ? [Math.max(fromB, curA.from + off), Math.min(end, curA.to + off)] : [1e9, 1e9]
      if (startB >= endB)
        [startB, endB] = curB.value ? [Math.max(fromB, curB.from), Math.min(end, curB.to)] : [1e9, 1e9]
      let start = Math.min(startA, startB), upto
      if (start >= end) break
      if (startA < startB) {
        change(startA, upto = Math.min(endA, startB))
        startA = upto
      } else if (startB < startA) {
        change(startB, upto = Math.min(endB, startA))
        startB = upto
      } else if (curA.cur!.value == curB.cur!.value) {
        // Identical chunks. Skip
        curA.next(true)
        curB.next(true)
        startA = startB = 1e9
      } else {
        upto = Math.min(endA, endB)
        if (!curA.value!.eq(curB.value!)) change(startA, upto)
        startA = startB = upto
      }
      if (startA >= endA) curA.next()
      if (startB >= endB) curB.next()
    }
    if (this.next || b.next)
      (this.next || RangeSet.empty).compareRange(fromA, b.next || RangeSet.empty, fromB, len, change)
  }

  /// The empty range set.
  static empty = new RangeSet<any>([], null)
}

function copyMappedUpto<T extends RangeSet.Value>(
  cursor: RangeSet.Cursor<T>, upto: number,
  map: ChangeSet, build: SetBuilder<T>,
  replace: readonly RangeSet.Replacement<T>[], replI: number
) {
  while (cursor.value && cursor.from <= upto) {
    let value = cursor.value!
    let from = map.mapPos(cursor.from, value.inclusiveStart ? -1 : 1)
    let to = map.mapPos(cursor.to, value.inclusiveEnd ? 1 : -1)
    let filtered = from >= to
    for (let i = replI; !filtered && i < replace.length && replace[i].from < to; i++) {
      if (replace[i].to > from) filtered = true
    }
    if (!filtered) build.addRange(from, to, value)
    cursor.next()
  }
}

class LayerCursor<T extends RangeSet.Value> implements RangeSet.Cursor<T> {
  chunkI = 0
  i = 0

  declare cur: Chunk<T> | null
  from = 0
  declare to: number
  declare value: T | null

  constructor(readonly chunks: readonly Chunk<T>[], start: number) {
    this.goto(start)
  }

  goto(pos: number) {
    if (pos < this.from) this.chunkI = this.i = 0
    else if (pos < this.to) return
    let {chunks} = this
    while (this.chunkI < chunks.length && chunks[this.chunkI].end <= pos) {
      this.chunkI++
      this.i = 0
    }
    if (this.chunkI == chunks.length) {
      this.i = 0
      this.from = this.to = 1e9
      this.cur = this.value = null
    } else {
      let chunk = this.cur = chunks[this.chunkI]
      let i = this.i = findAbove(chunk.to, this.i, pos - chunk.start)
      this.from = chunk.from[i] + chunk.start
      this.to = chunk.to[i] + chunk.start
      this.value = chunk.value[i]
    }
  }

  next(chunk?: boolean) {
    let {cur} = this
    if (!cur) return
    if (!chunk && this.i < cur.value.length - 1) {
      this.i++
    } else {
      this.chunkI++
      this.i = 0
      if (this.chunkI == this.chunks.length) {
        this.from = this.to = 1e9
        this.value = this.cur = null
        return
      } else {
        cur = this.cur = this.chunks[this.chunkI]
      }
    }
    this.from = cur.from[this.i] + cur.start
    this.to = cur.to[this.i] + cur.start
    this.value = cur.value[this.i]
  }
}

let cmpCursor = (a: RangeSet.Cursor<RangeSet.Value>, b: RangeSet.Cursor<RangeSet.Value>): number => {
  return (a.from - b.from) || (a.value!.inclusiveStart ? (b.value!.inclusiveStart ? 0 : 1) : -1) || (a.to - b.to)
}

class HeapCursor<T extends RangeSet.Value> implements RangeSet.Cursor<T> {
  heap: RangeSet.Cursor<T>[] = []
  declare from: number
  declare to: number
  declare value: T | null

  constructor(readonly cursors: readonly RangeSet.Cursor<T>[]) {
    for (let cur of cursors) if (cur.value) {
      this.heap.push(cur)
      heapSink(this.heap, this.heap.length - 1, cmpCursor)
    }
    this.fill()
  }

  fill() {
    if (this.heap.length) {
      ;({from: this.from, to: this.to, value: this.value} = this.heap[0])
    } else {
      this.from = this.to = 1e9
      this.value = null
    }
  }

  goto(pos: number) {
    this.heap = []
    for (let cur of this.cursors) {
      cur.goto(pos)
      if (cur.value) {
        this.heap.push(cur)
        heapSink(this.heap, this.heap.length - 1, cmpCursor)
      }
    }
  }

  next() {
    if (this.heap.length) {
      this.heap[0].next()
      if (this.heap[0].value) heapBubble(this.heap, 0, cmpCursor)
      else heapPop(this.heap, cmpCursor)
      this.fill()
    }
  }
}

export namespace RangeSet {
  /// Values stored in a range set must conform to this interface.
  export interface Value {
    /// Whether content inserted at the start of this value's range is
    /// included in the range.
    inclusiveStart: boolean
    /// Whether content inserted at the end is included.
    inclusiveEnd: boolean
    /// Compare this value to another.
    eq(other: Value): boolean
  }

  /// A range source, used to construct or extend a range set, must
  /// either be an array of `[from, to, value]` tuples, or a function
  /// that calls its argument for each range to add. Ranges must be
  /// provided ordered by their `from` position.
  export type Source<T extends Value> = Iterable<[number, number, T]> | ((add: (from: number, to: number, value: T) => void) => void)

  /// Represents a replaced section in a range set.
  export type Replacement<T extends Value> = {
    /// The start of the section.
    from: number,
    /// The end of the section.
    to: number,
    /// An optional collection of ranges to replace the section with.
    /// Must fall within `from` and `to`.
    add?: Source<T>
  }

  /// A cursor over a range set.
  export interface Cursor<T extends Value> {
    /// The current range's value, or `null` if the end of the set has
    /// been reached.
    value: T | null
    /// The start position of the current range.
    from: number
    /// The end position of the current range.
    to: number
    /// Move the cursor to a new position.
    goto(pos: number): void
    /// Move to the next range, if any.
    next(): void
  }
}
