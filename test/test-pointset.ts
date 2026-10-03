import ist from "ist"
import {PointSet} from "wordgard/set"
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
  static c = new V("c")
}

function str(set: PointSet<V>) {
  let values: string[] = []
  for (let c = set.cursor(); c.value; c.next()) values.push(c.value.name + "@" + c.pos)
  return values.join(" ")
}

describe("PointSet", () => {
  it("stores points and values", () => {
    ist(str(PointSet.create([[0, V.a], [4, V.b]])), "a@0 b@4")
  })

  it("checks order on creation", () => {
    ist.throws(() => PointSet.create([[2, V.a], [1, V.a]]),
               /Points must be added in order/)
  })

  it("can add to", () => {
    ist(str(PointSet.create([[0, V.a], [3, V.a]]).modify({add: [[2, V.b]]})),
        "a@0 b@2 a@3")
  })

  it("can filter", () => {
    ist(str(PointSet.create([[0, V.a], [1, V.b], [3, V.a], [4, V.b]]).modify({filter: p => !(p % 2)})),
        "a@0 b@4")
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

  it("properly maps points at the end of the document", () => {
    ist(str(PointSet.create([[4, V.a]]).map(ChangeSet.new([0, 1, 4, -1], []))), "a@5")
  })

  it("can map with replacements", () => {
    let set = PointSet.create<V>((add) => {
      for (let i = 0; i <= 20; i += 2) add(i, new V("p" + i))
    })
    ist(str(set.map(ChangeSet.new([6, -1, 8, 4, 6, -1], []), [{from: 4, to: 12, add: [[8, V.a]]}])),
        "p0@0 p2@2 a@8 p18@14 p20@16")
  })

  const chunkSize = 512

  it("preserves whole chunks during mapping", () => {
    let ps = PointSet.create<V>(add => {
      for (let i = 0; i < chunkSize * 2; i++) add(i, V.a)
    })
    let ps2 = ps.map(ChangeSet.new([chunkSize + 10, -1, 10, 0, chunkSize, -1], []))
    ist(ps.chunks[0].value, ps2.chunks[0].value)
  })

  it("can handle order change during mapping", () => {
    let set = PointSet.create<V>([[0, new V("a", 1)], [1, new V("b", -1)]])
    ist(str(set.map(ChangeSet.new([1, 0], []))), "b@0 a@0")
  })

  it("can compare sets", () => {
    let diff: number[] = []
    PointSet.create([[0, V.a], [2, V.b], [4, V.c]]).compareRange(
      0, PointSet.create([[1, V.a], [3, V.b], [3, V.a], [6, V.c]]), 1, 20, p => diff.push(p))
    ist(diff.join(), "3,5,6")
  })

  it("cheaply compares identical chunks", () => {
    let setA = PointSet.create<V>(add => {
      for (let i = 0; i < chunkSize * 3; i++) add(i, V.a)
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
