import ist from "ist"
import {RangeSet} from "wordgard/editor"
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
}

function str(set: RangeSet<V>) {
  return set.values.map((v, i) => v.name + "@" + set.from[i] + "-" + set.to[i]).join(" ")
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

  it("checks overlap on creation", () => {
    ist.throws(() => {
      RangeSet.create([[0, 3, V.a], [2, 4, V.a]])
    }, /cannot overlap/)
  })

  it("can merge", () => {
    ist(str(RangeSet.create([[0, 1, V.a], [3, 4, V.a]]).merge(RangeSet.create([[2, 3, V.b]]))),
        "a@0-1 b@2-3 a@3-4")
  })

  it("can merge masked", () => {
    ist(str(RangeSet.create([[0, 1, V.a], [3, 4, V.a], [4, 6, V.a]]).merge(RangeSet.create([[2, 3, V.b]]), 1, 5)),
        "a@0-1 b@2-3")
  })

  it("checks overlap during merge", () => {
    ist.throws(() => {
      RangeSet.create([[0, 2, V.a]]).merge(RangeSet.create([[1, 3, V.b]]))
    }, /Overlapping ranges/)
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

  it("properly maps ranges at the end of the document", () => {
    ist(str(RangeSet.create([[2, 4, V.a]]).map(ChangeSet.new([0, 1, 4, -1], []))), "a@3-5")
  })
})
