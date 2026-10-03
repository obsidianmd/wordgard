import ist from "ist"
import {RangeSet} from "wordgard/set"
import {ChangeSet} from "wordgard/doc"

class V implements RangeSet.Value {
  name: string
  inclusiveStart: boolean
  inclusiveEnd: boolean

  constructor(name = "x", inc = false) {
    this.name = name
    this.inclusiveStart = this.inclusiveEnd = inc
  }

  eq(other: V) {
    return other.inclusiveStart == this.inclusiveStart && other.name == this.name
  }

  static a = new V("a")
  static b = new V("b")
  static c = new V("c")
}

function str(set: RangeSet<V>) {
  let result: string[] = []
  for (let cur = set.cursor(); cur.value; cur.next()) result.push(`${cur.value.name}@${cur.from}-${cur.to}`)
  return result.join(" ")
}

describe("RangeSet", () => {
  it("stores ranges and values", () => {
    ist(str(RangeSet.create([[0, 1, V.a], [4, 6, V.b]])), "a@0-1 b@4-6")
  })

  it("checks order on creation", () => {
    ist.throws(() => {
      RangeSet.create([[2, 3, V.a], [0, 1, V.a]])
    }, /must be added in order/)
  })

  it("supports overlap", () => {
    ist(str(RangeSet.create([[0, 3, V.a], [2, 4, V.b]])), "a@0-3 b@2-4")
  })

  it("can be mapped", () => {
    let rs = RangeSet.create<V>(add => {
      for (let i = 0; i < 20; i += 4) add(i, i + 2, new V("v" + (i / 4)))
    })
    rs = rs.map(ChangeSet.new([5, 0, 4, -1, 0, 2, 3, -1, 4, 4, 0, 1, 2, -1, 0, 1, 10, -1], []))
    ist(str(rs), "v1@0-1 v2@3-7 v4@14-16")
  })

  it("can be mapped inclusively", () => {
    let rs = RangeSet.create<V>(add => {
      for (let i = 0; i < 10; i += 4) add(i, i + 2, new V("v" + (i / 4), true))
    })
    rs = rs.map(ChangeSet.new([2, -1, 0, 2, 2, -1, 0, 1, 20, -1], []))
    ist(str(rs), "v0@0-4 v1@6-9 v2@11-13")
  })

  const chunkSize = 512

  it("preserves whole chunks during mapping", () => {
    let rs = RangeSet.create<V>(add => {
      for (let i = 0; i < chunkSize * 2; i++) add(i, i + 1, V.a)
    })
    let rs2 = rs.map(ChangeSet.new([chunkSize + 10, -1, 10, 0, chunkSize, -1], []))
    ist(rs.chunks[0].value, rs2.chunks[0].value)
  })

  it("can be updated with a replacing range", () => {
    let rs = RangeSet.create<V>([[0, 1, V.a], [3, 4, V.a], [7, 8, V.a]])
    ist(str(rs.modify({replace: [{from: 1, to: 6, add: [[1, 3, V.b], [3, 5, V.b]]}]})),
        "a@0-1 b@1-3 b@3-5 a@7-8")
  })

  it("can be added to", () => {
    let rs = RangeSet.create<V>([[0, 1, V.a], [3, 4, V.a], [7, 8, V.a]])
      .modify({add: [[1, 2, V.b], [4, 5, V.c]]})
    ist(str(rs), "a@0-1 b@1-2 a@3-4 c@4-5 a@7-8")
    ist(rs.next, null)
  })

  it("can filter out ranges", () => {
    let rs = RangeSet.create<V>([[0, 2, V.a], [3, 5, V.a], [6, 8, V.a]])
      .modify({filter: (f, t) => t % 2 == 0})
    ist(str(rs), "a@0-2 a@6-8")
  })

  it("properly maps ranges at the end of the document", () => {
    ist(str(RangeSet.create([[2, 4, V.a]]).map(ChangeSet.new([0, 1, 4, -1], []))), "a@3-5")
  })

  it("can compare sets", () => {
    let diff: number[] = []
    RangeSet.create([[0, 3, V.a], [4, 7, V.b]]).compareRange(
      0, RangeSet.create([[1, 5, V.a], [5, 6, V.c], [6, 9, V.b]]), 1, 20, (f, t) => diff.push(f, t))
    ist(diff.join(), "4,5,5,6,8,9")
  })

  it("cheaply compares identical chunks", () => {
    let setA = RangeSet.create<V>(add => {
      for (let i = 0; i < chunkSize * 3; i++) add(i, i + 1, V.a)
    })
    let setB = setA.map(ChangeSet.new([0, 1, chunkSize * 3, -1], []))
    let target = setB.chunks[1], values = target.value, accessCount = 0
    Object.defineProperty(target, "value", {
      get() { accessCount++; return values }
    })
    setA.compareRange(0, setB, 1, chunkSize * 3, () => ist(false))
    ist(accessCount, 10, "<")
  })
})
