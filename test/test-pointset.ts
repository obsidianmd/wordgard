import ist from "ist"
import {PointSet} from "wordgard/editor"
import {ChangeSet} from "wordgard/doc"

class V implements PointSet.Value {
  name: string
  side: number

  constructor(name = "x", side = 0) {
    this.name = name
    this.side = side
  }

  eq(other: PointSet.Value): boolean {
    return other instanceof V && other.side == this.side && other.name == this.name
  }

  get trackMode() { return "around" as const }

  static a = new V("a")
  static b = new V("b")
}

function str(set: PointSet<V>) {
  return set.values.map((v, i) => v.name + "@" + set.positions[i]).join(" ")
}

describe("PointSet", () => {
  it("stores points and values", () => {
    ist(str(PointSet.create([[0, V.a], [4, V.b]])), "a@0 b@4")
  })

  it("corrects order on creation", () => {
    ist(str(PointSet.create([[2, V.a], [1, V.a], [0, V.b]])), "b@0 a@1 a@2")
    ist(str(PointSet.create([[1, V.a], [5, V.b], [3, V.a]])), "a@1 a@3 b@5")
  })

  it("can merge", () => {
    ist(str(PointSet.create([[0, V.a], [3, V.a]]).merge(PointSet.create([[2, V.b]]))),
        "a@0 b@2 a@3")
  })

  it("can merge masked", () => {
    ist(str(PointSet.create([[0, V.a], [3, V.a]]).merge(PointSet.create([[2, V.b]]), 0, 2)),
        "b@2 a@3")
  })

  it("can be mapped", () => {
    let ps = PointSet.create<V>(add => {
      for (let i = 0; i < 12; i += 2) add(i, new V("v" + (i / 2), 1))
    })
    ps = ps.map(ChangeSet.new([3, 0, 2, -1, 0, 2, 3, -1, 0, 1, 5, -1], []))
    ist(str(ps), "v0@0 v2@1 v3@5 v4@8 v5@10")
  })

  it("can be mapped with negative side", () => {
    let ps = PointSet.create<V>([[2, new V("x", -1)]])
    ps = ps.map(ChangeSet.new([2, -1, 0, 2, 2, -1], []))
    ist(str(ps), "x@2")
  })

  it("properly maps ranges at the end of the document", () => {
    ist(str(PointSet.create([[4, V.a]]).map(ChangeSet.new([0, 1, 4, -1], []))), "a@5")
  })
})
