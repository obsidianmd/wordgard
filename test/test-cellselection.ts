import {CellSelection} from "wordgard/table"
import {GardSelection} from "wordgard/state"
import {Plot, Leaf, Mark, Schema, ChangeSet} from "wordgard/doc"
import {Table, TableRow, Cell, ColSpan, RowSpan} from "wordgard/types"
import {builder, basicBuilders, basicSchema} from "./schema.ts"
import ist from "ist"

const schema = Schema.define(basicSchema.elements.concat(Table, TableRow, Cell, ColSpan, RowSpan))
const {p, table, tr, td} = basicBuilders
const doc = builder(schema)

// Cell positions in a 3x3:
//   2  7 12
//  19 24 29
//  31 36 41
function mkTable(rows = 3, cols = 3, spans?: string) {
  let rowNodes: Plot[] = [], done = new Set<string>()
  let spanInfo = !spans ? [] : spans.split(" ").map(spec => {
    let m = /^(\d+,\d+):(\d+)x(\d+)$/.exec(spec)!
    return {id: m[1], cols: +m[2], rows: +m[3]}
  })
  for (let r = 1; r <= rows; r++) {
    let cells: Plot[] = []
    for (let c = 1; c <= cols; c++) {
      let name = c + "," + r
      if (!done.has(name)) {
        let info = spanInfo.find(i => i.id == name)
        let marks = Mark.none
        if (info) {
          if (info.rows > 1) marks = RowSpan.of(info.rows).addToSet(marks)
          if (info.cols > 1) marks = ColSpan.of(info.cols).addToSet(marks)
          for (let sr = 0; sr < info.rows; sr++) for (let sc = 0; sc < info.cols; sc++)
            done.add((c + sc) + "," + (r + sr))
        }
        cells.push(Cell.withMarks(marks).create([Leaf.text(name)]))
      }
    }
    rowNodes.push(TableRow.create(cells))
  }
  return schema.doc([Table.create(rowNodes)])
}

function checkSel(sel: GardSelection, doc: Plot.Doc, cells: string) {
  let cellIDs = cells.split(" ")
  ist(cellIDs.length, sel.ranges.length)
  for (let i = 0; i < cellIDs.length; i++) {
    let r = sel.ranges[i], id = cellIDs[i]
    let cell = doc.plotAt(r.from - 1)!
    ist(r.from + cell.length - 2, r.to)
    ist(cell.textContent(), id)
  }
}

function testSel(doc: Plot.Doc, anchor: number, head: number, cells: string) {
  let sel = CellSelection.create(doc, anchor, head)!
  ist(sel instanceof CellSelection)
  checkSel(sel, doc, cells)
}

function testNorm(doc: Plot.Doc, anchor: number, head: number, result: string | null) {
  let sel = CellSelection.normalize(GardSelection.range(anchor, head), doc)
  if (!result) {
    ist(!sel)
  } else if (/^\d+-\d+$/.test(result)) {
    ist(sel instanceof GardSelection.Text)
    ist(sel!.anchor + "-" + sel!.head, result)
  } else {
    ist(sel instanceof CellSelection)
    if (anchor < head) ist(sel!.anchor < sel!.head)
    checkSel(sel!, doc, result)
  }
}

function testMove(doc: Plot.Doc, anchor: number, head: number, dir: "forward" | "backward" | "up" | "down", cells: string | null) {
  let sel = CellSelection.create(doc, anchor, head)!.moveHead(doc, dir)
  if (cells) {
    ist(sel)
    checkSel(sel!, doc, cells)
  } else {
    ist(!sel)
  }
}

function testMap(doc: Plot.Doc, anchor: number, head: number, change: ChangeSet.Spec, newAnchor: number, newHead: number) {
  let ch = ChangeSet.create(doc, change)
  let sel = CellSelection.create(doc, anchor, head)!.map(ch, {doc: ch.apply(doc)} as GardSelection.Context)
  ist(sel instanceof CellSelection)
  ist((sel as CellSelection).anchorCell, newAnchor)
  ist((sel as CellSelection).headCell, newHead)
}

describe("CellSelection", () => {
  it("Can select two adjacent cells", () =>
    testSel(mkTable(), 7, 12, "2,1 3,1"))

  it("Can select two adjacent cells in reverse", () =>
    testSel(mkTable(), 12, 7, "2,1 3,1"))

  it("Can select three adjacent cells", () =>
    testSel(mkTable(), 19, 29, "1,2 2,2 3,2"))

  it("Can select two cells vertically", () =>
    testSel(mkTable(), 7, 24, "2,1 2,2"))
    
  it("Can select two cells vertically in reverse", () =>
    testSel(mkTable(), 24, 7, "2,1 2,2"))

  it("Can select a single cell", () =>
    testSel(mkTable(), 24, 24, "2,2"))

  it("Can select a single cell in reverse", () =>
    testSel(mkTable(), 24, 24, "2,2"))

  it("Can select a square of cells", () =>
    testSel(mkTable(), 7, 29, "2,1 3,1 2,2 3,2"))

  it("Can select a square of cells in reverse", () =>
    testSel(mkTable(), 29, 7, "2,1 3,1 2,2 3,2"))

  it("Can handle merged cells", () =>
    testSel(mkTable(3, 3, "2,2:2x2"), 2, 24, "1,1 2,1 3,1 1,2 2,2 1,3"))

  it("grows to cover a colspan", () =>
    testSel(mkTable(3, 3, "1,2:2x1"), 2, 19, "1,1 2,1 1,2"))

  it("grows to cover a rowspan", () =>
    testSel(mkTable(3, 3, "2,1:1x3"), 2, 7, "1,1 2,1 1,2 1,3"))

  describe("normalize", () => {
    it("leaves selections inside a cell alone", () =>
      testNorm(mkTable(), 8, 10, null))

    it("converts selections crossing cell boundaries", () =>
      testNorm(mkTable(), 8, 13, "2,1 3,1"))

    it("preserves selection direction", () =>
      testNorm(mkTable(), 13, 8, "2,1 3,1"))

    it("can handle selections starting between cells", () =>
      testNorm(mkTable(), 7, 12, "2,1"))

    it("can handle cursor selection between cells", () =>
      testNorm(mkTable(), 7, 7, "2,1"))

    it("allows a cursor at the end of a cell", () =>
      testNorm(mkTable(), 11, 11, null))

    it("moves out of a table at the start", () =>
      testNorm(doc(table(tr(td("x"))), p("a")), 3, 9, "0-9"))

    it("moves out of a table at the end", () =>
      testNorm(doc(p("a"), table(tr(td("x")))), 1, 6, "1-10"))

    it("moves out of two tables", () =>
      testNorm(doc(table(tr(td("x"))), p("a"), table(tr(td("y")))), 3, 13, "0-17"))
  })

  describe("moveHead", () => {
    it("can move forward", () =>
      testMove(mkTable(), 24, 24, "forward", "2,2 3,2"))
    
    it("can move backward", () =>
      testMove(mkTable(), 24, 24, "backward", "1,2 2,2"))

    it("can move up", () =>
      testMove(mkTable(), 24, 24, "up", "2,1 2,2"))

    it("can move down", () =>
      testMove(mkTable(), 24, 24, "down", "2,2 2,3"))

    it("moves the head", () =>
      testMove(mkTable(), 2, 12, "backward", "1,1 2,1"))

    it("moves the head when inverted", () =>
      testMove(mkTable(), 12, 2, "forward", "2,1 3,1"))

    it("extends to a rectangle", () =>
      testMove(mkTable(), 2, 12, "down", "1,1 2,1 3,1 1,2 2,2 3,2"))

    it("extend when hitting a colspan node", () =>
      testMove(mkTable(3, 3, "1,1:3x1"), 9, 9, "up", "1,1 1,2 2,2 3,2"))

    it("extend when hitting a rowspan node", () =>
      testMove(mkTable(3, 3, "2,1:1x3"), 19, 2, "forward", "1,1 2,1 1,2 1,3"))
  })

  describe("map", () => {
    it("can map through a remote change", () =>
      testMap(mkTable(), 19, 29, {from: 0, insert: [p("!")]}, 22, 32))

    it("can handle a changed cell before the selection", () =>
      testMap(mkTable(), 19, 29, {from: 3, to: 5}, 17, 27))

    it("can handle a changed cell inside the selection", () =>
      testMap(mkTable(), 19, 29, {from: 20, to: 21}, 19, 28))

    it("works if the cell at the end of the selection is deleted", () =>
      testMap(mkTable(), 2, 12, {from: 7, to: 12}, 2, 7))

    it("works in inverted selection if the cell at the end is deleted", () =>
      testMap(mkTable(), 12, 2, {from: 7, to: 12}, 7, 2))

    it("works if the cell at the start of the selection is deleted", () =>
      testMap(mkTable(), 2, 12, {from: 2, to: 7}, 2, 7))

    it("works in inverted selection if the cell at the start is deleted", () =>
      testMap(mkTable(), 12, 2, {from: 2, to: 7}, 7, 2))
  })
})
