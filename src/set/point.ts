import {ChangeSet} from "wordgard/doc"
import {findAbove, heapSink, heapBubble, heapPop, addReplacements} from "./util"

const enum ChunkSize { Max = 512 }

class Chunk<T extends PointSet.Value> {
  constructor(
    readonly start: number,
    readonly pos: number[],
    readonly value: T[]
  ) {}

  get end() {
    return this.start + this.pos[this.pos.length - 1]
  }

  get startSide() { 
    return this.value[0].side
  }

  get endSide() {
    return this.value[this.value.length - 1].side
  }

  move(start: number) {
    return start == this.start ? this : new Chunk(start, this.pos, this.value)
  }
}

class SetBuilder<T extends PointSet.Value> {
  chunks: Chunk<T>[] = []
  lastPos = -1
  lastSide = -1

  addChunk(chunk: Chunk<T>) {
    this.chunks.push(chunk)
    this.lastPos = chunk.end
    this.lastSide = chunk.endSide
  }

  add(source: PointSet.Source<T>, pre?: (pos: number, value: T) => void) {
    if (typeof source != "function") {
      let array = source
      source = add => { for (let [pos, value] of array) add(pos, value) }
    }
    source((pos, value) => {
      if (pre) pre(pos, value)
      this.addPoint(pos, value)
    })
  }

  addPoint(pos: number, value: T) {
    let chunk: Chunk<T> | undefined
    if (this.chunks.length) {
      chunk = this.chunks[this.chunks.length - 1]
      if (chunk.value.length >= ChunkSize.Max) chunk = undefined
    }
    if (!chunk) {
      this.chunks.push(chunk = new Chunk(pos, [], []))
    }
    chunk.pos.push(pos - chunk.start)
    chunk.value.push(value)
    if ((pos - this.lastPos || value.side || this.lastSide) >= 0) {
      this.lastPos = pos
      this.lastSide = value.side
    } else {
      // Move down until sorted
      for (let i = chunk.value.length - 1, chunkI = this.chunks.length - 1;;) {
        let nextI = i - 1, nextChunk: Chunk<T> = chunk
        if (nextI < 0) {
          if (!chunkI) break
          nextChunk = this.chunks[--chunkI]
          nextI = nextChunk.value.length - 1
        }
        if ((pos - nextChunk.pos[nextI] || value.side - nextChunk.value[nextI].side) >= 0) break
        chunk.pos[i] = nextChunk.pos[nextI]
        chunk.value[i] = nextChunk.value[nextI]
        nextChunk.pos[nextI] = pos
        nextChunk.value[nextI] = value
        i = nextI
        chunk = nextChunk
      }
    }
  }

  finish(): PointSet<T> {
    return this.chunks.length ? PointSet.new(this.chunks) : PointSet.empty
  }
}

/// Data structure used to store sets of points and then track them
/// across document changes. Mostly used for {@link Decoration.Point
/// point decorations}, but can also track your own types, if you make
/// sure they implement the {@link PointSet.Value} interface.
export class PointSet<T extends PointSet.Value> {
  private constructor(
    /// @internal
    readonly chunks: readonly Chunk<T>[]
  ) {}

  /// @internal
  static new<T extends PointSet.Value>(chunks: readonly Chunk<T>[]) { return new PointSet(chunks) }

  /// Create a point set from an iterable of `[position, value]`
  /// tuples, or a function that calls its argument for every point to
  /// add.
  static create<T extends PointSet.Value>(
    source: PointSet.Source<T>
  ): PointSet<T> {
    let build = new SetBuilder<T>()
    build.add(source, (from, value) => {
      if ((from - build.lastPos || value.side - build.lastSide) < 0)
        throw new Error("Points must be added in order")
    })
    return build.finish()
  }

  /// The number of points in this set.
  get length(): number {
    return this.chunks.length ? this.chunks[this.chunks.length - 1].end : 0
  }

  /// Returns `true` when this set is empty.
  get empty() {
    return this == PointSet.empty
  }

  /// Create a cursor over this point set, starting at the given
  /// position and side.
  cursor(from = 0, side = -1e9): PointSet.Cursor<T> {
    return new PointCursor(this, from, side)
  }

  /// Create a cursor over a collection of point sets.
  static cursor<T extends PointSet.Value>(sets: readonly PointSet<T>[], from = 0, side = -1e9): PointSet.Cursor<T> {
    let cursors: PointSet.Cursor<T>[] = []
    for (let set of sets) if (!set.empty) cursors.push(set.cursor(from, side))
    return cursors.length == 0 ? PointSet.empty.cursor() : cursors.length == 1 ? cursors[0] : new HeapCursor(cursors)
  }

  /// Get the value at the given position, if any. If there's multiple
  /// values at that position, the one with the lowest side is
  /// returned.
  at(pos: number): T | undefined {
    for (let chunk of this.chunks) {
      if (chunk.end > pos) break
      if (chunk.start > pos) continue
      let index = findAbove(chunk.pos, 0, pos - 1)
      if (index < chunk.pos.length && chunk.pos[index] == pos) return chunk.value[index]
    }
    return undefined
  }

  /// Adjust the points for a set of document changes. Returns a new
  /// set with the adjusted points. May delete points when the content
  /// around them was deleted. Optionally accepts an ordered sequence
  /// of replacements.
  map(map: ChangeSet, replace: readonly PointSet.Replacement<T>[] = []) {
    let {sections} = map
    if (replace.length) sections = addReplacements(map, replace)
    else if (map.empty) return this
    return this.mapInner(sections, map, replace)
  }

  private mapInner(sections: ChangeSet.Sections, map: ChangeSet, replace: readonly PointSet.Replacement<T>[]): PointSet<T> {
    let cursor = new PointCursor(this, 0, -1e9)
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
          } else if (cursor.pos < upto) {
            build.addPoint(cursor.pos + off, cursor.value!)
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
        if (len) cursor.goto(posA + len, -1e9)
        copyMappedUpto(cursor, posA + len, map, build, replace, replStartI)
        posB = endB
      }
      posA += len
    }
    return build.finish()
  }

  /// Create an updated copy of this set.
  modify(spec: {
    /// If given, replace all points in these ranges.
    replace?: readonly PointSet.Replacement<T>[],
    /// Add the points from this source.
    add?: PointSet.Source<T>,
    /// Optionally filter out any point where this predicate returns
    /// false.
    filter?: (pos: number, value: T) => boolean
  }) {
    let {replace, add, filter} = spec
    let result: PointSet<T> = this
    if (replace && replace.length) {
      result = result.map(ChangeSet.empty(Math.max(result.length, replace[replace.length - 1].to)), replace)
    }
    return add || filter ? result.modifyInner(add, filter) : result
  }

  private modifyInner(add: PointSet.Source<T> | undefined, filter?: (pos: number, value: T) => boolean): PointSet<T> {
    let build = new SetBuilder<T>()
    let cursor = new PointCursor(this, 0, -1e9)
    let advance = (pos: number) => {
      for (;;) {
        let {cur} = cursor
        if (!cur) return
        if (cursor.i == 0 && cur.end <= pos && !filter) {
          build.addChunk(cur)
          cursor.next(true)
        } else if (cursor.pos >= pos) {
          break
        } else {
          if (!filter || filter(cursor.pos, cursor.value!))
            build.addPoint(cursor.pos, cursor.value!)
          cursor.next()
        }
      }
    }
    if (add) build.add(add, advance)
    advance(1e9)
    return build.finish()
  }

  /// Compare a range in this set with a range in another set. Call
  /// `change` for every point that exists in one but not the other.
  compareRange(fromA: number, b: PointSet<T>, fromB: number, len: number, change: (pos: number, value: T) => void) {
    if (this == b) return
    let curA = new PointCursor(this, fromA, -1e9), curB = new PointCursor(b, fromB, -1e9)
    let off = fromB - fromA, endB = fromB + len
    for (;;) {
      let nextA = curA.value ? curA.pos + off : 1e9, nextB = curB.value ? curB.pos : 1e9
      if (Math.min(nextA, nextB) > endB) break
      let cmp = nextA - nextB || curA.side - curB.side
      if (cmp == 0 && curA.cur!.value == curB.cur!.value) { // Identical chunk. Skip
        curA.next(true)
        curB.next(true)
      } else if (cmp == 0 && curA.value!.eq(curB.value!)) {
        curA.next()
        curB.next()
      } else if (cmp < 0) {
        change(nextA, curA.value!)
        curA.next()
      } else {
        change(nextB, curB.value!)
        curB.next()
      }
    }
  }

  /// The empty point set.
  static empty = new PointSet<any>([])
}

function copyMappedUpto<T extends PointSet.Value>(
  cursor: PointSet.Cursor<T>, upto: number,
  map: ChangeSet, build: SetBuilder<T>,
  replace: readonly PointSet.Replacement<T>[], replI: number
) {
  while (cursor.value && cursor.pos <= upto) {
    let value = cursor.value
    let pos = map.mapPos(cursor.pos, value.side < 0 ? -1 : 1, value.trackMode)
    if (pos != null) {
      let filtered = false
      for (let i = replI; !filtered && i < replace.length && replace[i].from <= pos; i++) {
        if (replace[i].to >= pos) filtered = true
      }
      if (!filtered) build.addPoint(pos, value)
    }
    cursor.next()
  }
}

class PointCursor<T extends PointSet.Value> implements PointSet.Cursor<T> {
  chunkI = 0
  i = 0

  declare cur: Chunk<T> | null
  pos = -1
  declare value: T | null

  constructor(readonly set: PointSet<T>, start: number, side: number) {
    this.goto(start, side)
  }

  get side() { return this.value ? this.value.side : 1e9 }

  goto(pos: number, side: number) {
    let diff = pos - this.pos || side - this.side
    if (diff < 0) {
      this.chunkI = this.i = 0
    } else if (diff == 0 && this.cur) {
      // Rewind over points directly before the current position, if necessary
      for (;; this.i--) {
        if (!this.i) {
          this.chunkI = 0
          break
        }
        if ((pos - this.cur.pos[this.i - 1] || side - this.cur.value[this.i - 1].side) < 0)
          break
      }
    }
    for (let first = true;;) {
      if (this.chunkI == this.set.chunks.length) {
        this.pos = 1e9
        this.cur = this.value = null
        break
      }
      let chunk = this.set.chunks[this.chunkI]
      if (chunk.end < pos || this.i == chunk.value.length) {
        this.chunkI++; this.i = 0
      } else if (first) {
        this.i = findAbove(chunk.pos, this.i, pos - chunk.start - 1)
        first = false
      } else if ((pos - (chunk.start + chunk.pos[this.i]) || side - chunk.value[this.i].side) > 0) {
        this.i++
      } else {
        this.cur = chunk
        this.pos = chunk.pos[this.i] + chunk.start
        this.value = chunk.value[this.i]
        break
      }
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
      if (this.chunkI == this.set.chunks.length) {
        this.value = this.cur = null
        return
      } else {
        cur = this.cur = this.set.chunks[this.chunkI]
      }
    }
    this.pos = cur.pos[this.i] + cur.start
    this.value = cur.value[this.i]
  }
}

function cmpCursor<T extends PointSet.Value>(a: PointSet.Cursor<T>, b: PointSet.Cursor<T>): number {
  return a.pos - b.pos || a.value!.side - b.value!.side
}

class HeapCursor<T extends PointSet.Value> implements PointSet.Cursor<T> {
  heap: PointSet.Cursor<T>[] = []
  declare pos: number
  declare value: T | null

  constructor(readonly cursors: readonly PointSet.Cursor<T>[]) {
    for (let cur of cursors) if (cur.value) {
      this.heap.push(cur)
      heapSink(this.heap, this.heap.length - 1, cmpCursor)
    }
    this.fill()
  }

  get side() {
    return this.value ? this.value.side : 1e9
  }

  fill() {
    if (this.heap.length) {
      ;({pos: this.pos, value: this.value} = this.heap[0])
    } else {
      this.pos = 1e9
      this.value = null
    }
  }

  goto(pos: number, side: number) {
    this.heap = []
    for (let cur of this.cursors) {
      cur.goto(pos, side)
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

  get set() { return this.heap.length ? this.heap[0].set : PointSet.empty }
}

export namespace PointSet {
  /// Objects stored in a point set must conform to this interface.
  export interface Value {
    /// The side of the point. Used to provide a sorting of points at
    /// the same position, and to determine cursor position relative to
    /// the points. Points with side < 0 are always displayed before a
    /// cursor at their position, those with side > 0 always after, and
    /// those with side == 0 before or after depending on the cursor's
    /// side.
    side: number
    /// Configures whether the point should be deleted when content next
    /// to it is deleted. See {@link ChangeSet.mapPos}.
    trackMode: ChangeSet.TrackMode | undefined
    /// Method to compare this value to another.
    eq(other: Value): boolean
  }

  /// A point source, used to create or extend a point set, is either
  /// an array of `[pos, value]` tuples, or a function that calls its
  /// argument to add a point. Point sources must provide their points
  /// ordered by position and {@link PointSet.Value.side side}.
  export type Source<T extends Value> = Iterable<[number, T]> | ((add: (pos: number, value: T) => void) => void)

  /// Represents a replaced section in a point set.
  export type Replacement<T extends Value> = {
    /// The start of the replacement.
    from: number,
    /// The end of the replaced range.
    to: number,
    /// An optional source of points to to this section.
    add?: PointSet.Source<T>
  }

  /// A cursor over a point set.
  export interface Cursor<T extends Value> {
    /// The value of the current point, or `null` when there are no
    /// more points.
    value: T | null
    /// The position of the current point.
    pos: number
    /// The side value of the current point.
    side: number
    /// Move the cursor to a given position and side.
    goto(pos: number, side: number): void
    /// Continue to the next point, if any.
    next(): void
    /// The set object that the current point belongs to.
    set: PointSet<T>
  }
}
