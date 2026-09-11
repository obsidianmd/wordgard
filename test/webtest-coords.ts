import {Wordgard} from "wordgard/editor"
import {GardSelection} from "wordgard/state"
import {Table, TableRow, Cell} from "wordgard/types"
import {Schema} from "wordgard/doc"
import ist from "ist"
import {tempEditor} from "./tempview.ts"
import {basicSchema,basicBuilders, builder} from "./schema.ts"

const schema = Schema.define(basicSchema.elements.concat(Table, TableRow, Cell))
const {p, pre, br, hr, blockquote, ul, li, strong, table, tr, td} = basicBuilders
const doc = builder(schema)

const P = (wg: Wordgard, x: number, y: number) => {
  let pos = wg.posAtCoords({x, y})
  return `${pos.pos}${pos.side < 0 ? "<" : pos.side ? ">" : ""}`
}

describe("coordsAtPos", () => {
  it("finds reasonable coordinates for simple text", () => {
    let wg = tempEditor(doc(p("abc def ghi jkl mno pqr stu")), Wordgard.theme({
      "&": { width: "8ch" }
    }))
    for (let i = 1; i < wg.state.doc.length - 1; i++) {
      let coords = wg.coordsAtPos(i)
      ist(wg.posAtCoords({x: coords.left, y: coords.top + 1}).pos, i)
    }
  })

  it("properly assigns a side to positions", () => {
    let wg = tempEditor(doc(p("abcde fghijk")), Wordgard.theme({
      "&": { width: "8ch" }
    }))
    let p3 = wg.coordsAtPos(3)
    ist(P(wg, p3.left - 1.5, p3.top + 2), "3<")
    ist(P(wg, p3.left + 1.5, p3.bottom - 2), "3>")
    let p7a = wg.coordsAtPos(7, -1)
    let p7b = wg.coordsAtPos(7, 1)
    ist(p7a.top, p7b.top, "<")
    ist(p7a.left, p7b.left, ">")
    ist(P(wg, p7a.left + 20, p7a.top + 2), "7<")
    ist(P(wg, p7b.left - 10, p7b.top + 2), "7>")
  })

  it("assigns positions below text to the end", () => {
    let wg = tempEditor(doc(p("abcde")), Wordgard.theme({
      "p": { paddingBottom: "3px" }
    }))
    let p5 = wg.coordsAtPos(5)
    ist(P(wg, p5.left - 1, p5.bottom + 10), "7<")
  })

  it("assigns position below wrapped text to end", () => {
    let wg = tempEditor(doc(p("abcde fg")), Wordgard.theme({
      "p": { paddingBottom: "3px" },
      "&": { width: "6ch" }
    }))
    let p9 = wg.coordsAtPos(9)
    ist(p9.top, wg.coordsAtPos(1).bottom, ">=")
    ist(P(wg, p9.right + 10, p9.bottom + 2), "9<")
  })

  it("works around hard breaks", () => {
    let wg = tempEditor(doc(p("ab", br, "cd")))
    let p3 = wg.coordsAtPos(3), p4 = wg.coordsAtPos(4, 1)
    ist(p3.bottom, p4.top, "<=")
    ist(P(wg, p3.left - 1, p3.top + 1), "3<")
    ist(P(wg, p3.left + 1, p3.top + 1), "3<")
    ist(P(wg, p4.left - 1, p4.top + 1), "4>")
    ist(P(wg, p4.left + 1, p4.top + 1), "4>")
  })

  it("works in block atoms", () => {
    let wg = tempEditor(doc(hr, hr, hr))
    let p0 = wg.coordsAtPos(0)
    ist(p0.left, p0.right, "<")
    ist(p0.top, p0.bottom)
    ist(P(wg, p0.left + 10, p0.top - 1), "0>")
    ist(P(wg, p0.left + 10, p0.top + 0.1), "0>")
    let r2 = wg.contentDOM.children[1].getBoundingClientRect()
    ist(P(wg, r2.left, r2.top + 0.1), "1>")
    ist(P(wg, r2.left, r2.bottom - 0.1), "2<")
  })

  it("can handle different text height", () => {
    let wg = tempEditor(doc(p("abc", strong("def"), "ghi")), Wordgard.theme({
      "strong": {fontSize: "300%"}
    }))
    let c2 = wg.coordsAtPos(2)
    ist(P(wg, c2.left - 1, c2.top - 5), "2<")
    ist(P(wg, c2.left + 1, c2.bottom + 1), "2>")
    let c8 = wg.coordsAtPos(8)
    ist(P(wg, c8.left - 1, c8.top - 5), "8<")
  })

  it("works in right-to-left context", () => {
    let wg = tempEditor(doc(p("مطر")))
    let c2 = wg.coordsAtPos(2)
    ist(P(wg, c2.left - 1, c2.top + 2), "2>")
    ist(P(wg, c2.left + 1, c2.top + 2), "2<")
  })

  it("works around line breaks", () => {
    let wg = tempEditor(doc(pre("a", br, br, "b", br)))
    let c2 = wg.coordsAtPos(2, -1)
    ist(wg.coordsAtPos(2, 1).top, c2.top)
    let c3 = wg.coordsAtPos(3, -1)
    ist(c3.top, c2.top, ">")
    ist(P(wg, c3.left + 20, c3.top + 2), "3>")
    ist(wg.coordsAtPos(3, 1).top, c3.top)
    let c4 = wg.coordsAtPos(4, 1)
    ist(c4.top, c3.top, ">")
    let c6 = wg.coordsAtPos(6, -1)
    ist(c6.top, c4.top, ">")
    ist(P(wg, c6.left + 2, c6.top + 2), "6>")
  })
})

function s(pos: number, b?: number) {
  if (b == null) return GardSelection.cursor(pos)
  if (b == 1 || b == -1) return GardSelection.cursor(pos, b)
  return GardSelection.cursor(pos, 1, b)
}

describe("moveVertically", () => {
  it("can move between paragraphs", () => {
    let wg = tempEditor(doc(p("one"), p("two")))
    ist(wg.moveVertically(s(1), true)?.head, 6)
    ist(wg.moveVertically(s(2), true)?.head, 7)
    ist(wg.moveVertically(s(4), true)?.head, 9)
    ist(wg.moveVertically(s(6), false)?.head, 1)
    ist(wg.moveVertically(s(7), false)?.head, 2)
    ist(wg.moveVertically(s(9), false)?.head, 4)
  })

  it("can move within a paragraph", () => {
    let wg = tempEditor(doc(p("abcde ugh")), Wordgard.theme({
      "&": { width: "10ch" }
    }))
    ist(wg.moveVertically(s(1), true)?.head, 7)
    ist(wg.moveVertically(s(3), true)?.head, 9)
    ist(wg.moveVertically(s(6, -1), true)?.head, 10)
    ist(wg.moveVertically(s(7, 1), true), null)
    ist(wg.moveVertically(s(9), true), null)
    ist(wg.moveVertically(s(8), false)?.head, 2)
    ist(wg.moveVertically(s(1), false), null)
  })

  it("preserves a goal column", () => {
    let wg = tempEditor(doc(p("one"), p("x"), p("two")))
    let r1 = wg.moveVertically(s(4), true)
    ist(r1?.head, 7)
    ist(wg.moveVertically(r1!, true)?.head, 12)
    ist(wg.moveVertically(r1!, false)?.head, 4)
  })

  it("can move across atom blocks", () => {
    let wg = tempEditor(doc(p("one"), hr, p("two"), hr))
    ist(wg.moveVertically(s(2), true)?.head, 8)
    ist(wg.moveVertically(s(8), true)?.head, 12)
  })

  it("can enter nested blocks", () => {
    let wg = tempEditor(doc(p("one"), blockquote(p("two")), ul(li(p("three")), li(p("four"))), p("five")), Wordgard.theme({
      "&": {fontFamily: "monospace"},
      "ul, li, blockquote": {margin: 0, padding: 0, listStyle: "none"}
    }))
    ist(wg.moveVertically(s(2), true)?.head, 8)
    ist(wg.moveVertically(s(8), true)?.head, 16)
    ist(wg.moveVertically(s(16), true)?.head, 25)
    ist(wg.moveVertically(s(25), true)?.head, 33)
    ist(wg.moveVertically(s(34), false)?.head, 26)
    ist(wg.moveVertically(s(26), false)?.head, 17)
    ist(wg.moveVertically(s(17), false)?.head, 9)
    ist(wg.moveVertically(s(9), false)?.head, 3)
  })

  it("can move through rows in a table", () => {
    let wg = tempEditor(doc(p("a"), table(tr(td("a"), td("a")), tr(td("a"), td("a"))), p("a".repeat(10))),
                        Wordgard.theme({td: {padding: "0"}}))
    ist(wg.moveVertically(s(2), true)?.head, 7)
    ist(wg.moveVertically(s(7), true)?.head, 15)
    ist(wg.moveVertically(s(14), true)?.head, 22)
    ist(wg.moveVertically(s(9), true)?.head, 17)
    ist(wg.moveVertically(s(17), true)?.head, 22, ">")
    ist(wg.moveVertically(s(22), false)?.head, 14)
    ist(wg.moveVertically(s(32), false)?.head, 18)
    ist(wg.moveVertically(s(18), false)?.head, 10)
    ist(wg.moveVertically(s(10), false)?.head, 2)
    ist(wg.moveVertically(s(6), false)?.head, 1)
  })
})
