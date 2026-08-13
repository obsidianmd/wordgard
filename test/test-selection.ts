import ist from "ist"
import {Schema, Plot, Leaf, Node} from "wordgard/doc"
import {Table, TableRow, Cell, HeaderCell} from "wordgard/types"
import {GardSelection, GardState} from "wordgard/state"
import {basicSchema, basicBuilders, builder, maybeTag} from "./schema.ts"
const {p, hr, blockquote, pre, ul, li, $img, table, tr, td, th} = basicBuilders

let Iso = Plot.define("Iso", {
  blockContent: Node.Group.Content,
  group: Node.Group.Content,
  isolating: true,
  shape: {element: "div"}
}), iso = builder(Iso)
let InlineA = Plot.define("InlineA", {
  inline: true,
  inlineContent: true,
  shape: {element: "span"}
}), a = builder(InlineA)
let InlineB = Plot.define("InlineB", {
  inline: true,
  inlineContent: true,
  cursorInsideBounds: true,
  shape: {element: "span"}
}), b = builder(InlineB)

const schema = Schema.define([...basicSchema.nodes, ...basicSchema.marks, Iso, InlineA, InlineB,
                              Table, TableRow, Cell, HeaderCell])
const doc = builder(schema)

function normalPositions(state: GardState) {
  let result: number[] = []
  let ii = 0
  for (let cur = GardSelection.atStart(state);;) {
    result.push(cur.head)
    let next = cur.nextNormalCursor(state)
    if (next == null) return result
    cur = next
    if (++ii > state.doc.length * 2) throw new Error("STUCK " + result)
  }
}

describe("GardSelection", () => {
  describe("nextNormalCursor", () => {
    function testNormal(doc: Plot.Doc) {
      let state = GardState.create({doc}), forward = normalPositions(state), back = []
      let expect = []
      for (let i = 0;; i++) {
        let next = maybeTag(doc, i)
        if (next == null) break
        expect.push(next)
      }
      for (let cur = GardSelection.atEnd(state);;) {
        back.push(cur.head)
        let next = cur.nextNormalCursor(state, false)
        if (next == null) break
        cur = next
      }
      ist(forward.join(), expect.join())
      ist(back.join(), expect.slice().reverse().join())

      // Check whether GardSelection.near properly normalizes
      for (let i = 0, j = 0; i < doc.length; i++) {
        let forw = GardSelection.near(state, i, -1).head
        let back = GardSelection.near(state, i, 1).head
        if (j < expect.length && expect[j] == i) { // This is a normal pos
          ist(forw, i)
          ist(back, i)
          j++
        } else {
          let prev = expect[Math.max(0, j - 1)], next = expect[Math.min(expect.length - 1, j)]
          ist(forw == prev || forw == next)
          ist(back == prev || back == next)
        }
      }
    }

    it("finds inline positions", () =>
      testNormal(doc(p(0, "o", 1, "n", 2, "e", 3))))

    it("allows positions between block leaves", () =>
      testNormal(doc(0, hr, 1, hr, 2)))

    it("doesn't include positions next to textblocks", () =>
      testNormal(doc(0, hr, p(1, "a", 2), hr, 3)))

    it("returns the bottom-most position between blocks", () =>
      testNormal(doc(0, blockquote(hr), 1, blockquote(hr), 2)))

    it("stops at isolating nodes", () =>
      testNormal(doc(0, iso(1, hr, 2), 3, iso(p(4)), 5)))

    it("allows positions between block atoms", () =>
      testNormal(doc(p(0, "-", 1), hr, 2, hr, 3)))

    it("creates positions around whitespace-preserving nodes", () =>
      testNormal(doc(0, pre(1, "a", 2), p(3), pre(4), 5)))

    it("handles inline nodes", () =>
      testNormal(doc(p(0, "a", 1, $img, 2, "b", 3), p(4, $img, 5))))

    it("skips whole glyphs", () =>
      testNormal(doc(p(0, "ő", 1, "👨‍🎤", 2, "🇪🇸", 3))))

    it("creates positions outside inline content nodes", () =>
      testNormal(doc(p(0, "a", 1, a("b", 2, "c"), 3, "d", 4))))

    it("creates positions inside inline content nodes with inside bounds", () =>
      testNormal(doc(p(0, "a", 1, b(2, "b", 3, "c", 4), 5, "d", 6))))

    it("exits text nodes", () => {
      testNormal(doc(p(0, "a", 1, "b", 2, $img, 3, "c", 4, "d", 5)))
    })

    it("enters tables", () => {
      testNormal(doc(p(0, "a", 1), table(tr(td(2, "b", 3), td(4)), tr(td(5, "c", 6), th(7, "d", 8))), 9))
    })

    describe("bidi", () => {
      function test(text: string, ltr: number[], rtl: number[]) {
        it("moves LTR through " + JSON.stringify(text), () => {
          ist(JSON.stringify(normalPositions(GardState.create({doc: doc(p(text))})).map(n => n - 1)), JSON.stringify(ltr))
        })
        it("moves RTL through " + JSON.stringify(text), () => {
          let state = GardState.create({doc: doc(p(text)), config: GardState.textLTR.of(false)})
          ist(JSON.stringify(normalPositions(state).map(n => n - 1)), JSON.stringify(rtl))
        })
      }

      test("الصفصاف",
           [7, 6, 5, 4, 3, 2, 1, 0],
           [0, 1, 2, 3, 4, 5, 6, 7])
      test("treeشجرة",
           [0, 1, 2, 3, 4, 7, 6, 5, 4],
           [4, 3, 2, 1, 4, 5, 6, 7, 8])
      test("شجرةtree",
           [4, 3, 2, 1, 4, 5, 6, 7, 8],
           [0, 1, 2, 3, 4, 7, 6, 5, 4])
      test("aشجرةtree",
           [0, 1, 4, 3, 2, 5, 6, 7, 8, 9],
           [1, 1, 2, 3, 4, 5, 8, 7, 6, 5])
      test("رقم415خمسة",
           [10, 9, 8, 7, 6, 4, 5, 3, 2, 1, 0],
           [0, 1, 2, 3, 5, 4, 6, 7, 8, 9, 10])
      test("كو,",
           [2, 1, 2, 3],
           [0, 1, 2, 3])
      test("  foo  ",
           [0, 1, 2, 3, 4, 5, 6, 7],
           [0, 1, 2, 4, 3, 5, 6, 7])
      test("  مرآة  ",
           [0, 1, 2, 5, 4, 3, 6, 7, 8],
           [0, 1, 2, 3, 4, 5, 6, 7, 8])
      test("ab12-34%م",
           [0, 1, 2, 3, 4, 5, 6, 7, 8, 8],
           [8, 7, 6, 5, 4, 3, 2, 1, 8, 9])
      test("ر12:34ر",
           [7, 6, 2, 3, 4, 5, 1, 0],
           [0, 1, 5, 4, 3, 2, 6, 7])
      test("ab مرآة10 cde 20مرآة!",
           [0, 1, 2, 3, 8, 7, 6, 5, 4, 9, 10, 11, 12, 13, 14, 15, 16, 19, 18, 17, 20, 21],
           [2, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 15, 14, 13, 12, 11, 16, 17, 18, 19, 20, 21])
      test("(ء)و)",
           [0, 1, 2, 3, 4, 5],
           [0, 1, 2, 3, 4, 5])
      test("(([^ء-ي]|^)و)",
           [0, 1, 2, 3, 4, 6, 5, 7, 8, 9, 10, 11, 12, 13],
           [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13])
      test("ء(و)",
           [4, 3, 2, 1, 0],
           [0, 1, 2, 3, 4])
      test("[foo(barء)]",
           [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
           [0, 1, 3, 2, 4, 5, 7, 6, 8, 9, 10, 11])
    })
  })

  describe("near", () => {
    it("will skip out of a surrogate pair", () => {
      let s = GardState.create({doc: doc(p("🐜"))})
      ist(GardSelection.near(s, 2, -1).head, 1)
      ist(GardSelection.near(s, 2, 1).head, 3)
    })

    it("will move to the bottom of a block separation", () => {
      let s = GardState.create({doc: doc(ul(li(blockquote(hr)), li(blockquote(hr))))})
      ist(GardSelection.near(s, 4).head, 6)
      ist(GardSelection.near(s, 8).head, 6)
    })

    let inline = Plot.define("Inline", {
      inline: true,
      inlineContent: true,
      shape: {element: "span"}
    })

    it("will exit a non-cursor-inside inline plot", () => {
      Plot.Doc.noValidate(() => {
        let s = GardState.create({doc: doc(p("a", inline.create([Leaf.text("b")]), "c"))})
        ist(GardSelection.near(s, 3).head, 2)
        ist(GardSelection.near(s, 4).head, 5)
      })
    })

    it("will exit a non-cursor-inside after exiting a surrogate pair", () => {
      Plot.Doc.noValidate(() => {
        let s = GardState.create({doc: doc(p("a", inline.create([Leaf.text("🐜")])))})
        ist(GardSelection.near(s, 4, -1).head, 2)
        ist(GardSelection.near(s, 4, 1).head, 6)
      })
    })

    it("will not exit a cursor-inside inline plot", () => {
      let inline = Plot.define("Inline", {
        inline: true,
        inlineContent: true,
        cursorInsideBounds: true,
        shape: {element: "span"}
      })
      Plot.Doc.noValidate(() => {
        let s = GardState.create({doc: doc(p("a", inline.create([Leaf.text("b")]), "c"))})
        ist(GardSelection.near(s, 3).head, 3)
        ist(GardSelection.near(s, 4).head, 4)
      })
    })
  })

  describe("skipWord", () => {
    function test(name: string, lines: string | string[], positions: number[]) {
      it(name, () => {
        let state = GardState.create({doc: doc((Array.isArray(lines) ? lines : [lines]).map(line => p(line)))})
        let cur = GardSelection.atStart(state), found = []
        for (;;) {
          let next = cur.skipWord(state, true)
          if (!next) break
          found.push(next.head)
          cur = next
        }
        ist(JSON.stringify(found), JSON.stringify(positions))
      })
    }

    test("can skip words", "a bbb c", [2, 6, 8])

    test("skips whitespace", "  a      bbb", [4, 13])

    test("skips punctuation", "a. b??? / c", [2, 5, 12])

    test("can move across blocks", ["abc def", " efg"], [4, 8, 14])

    test("includes extra positions at end", "a b ", [2, 4, 5])

    test("is direction-aware", "a واحد اثنين ثلاثة b", [2, 14, 8, 19, 21])

    test("uses a segmenter", "两只兔子", [2, 3, 5])
  })

  describe("skipWord back", () => {
    function test(name: string, lines: string | string[], positions: number[]) {
      it(name, () => {
        let state = GardState.create({doc: doc((Array.isArray(lines) ? lines : [lines]).map(line => p(line)))})
        let cur = GardSelection.atEnd(state), found = []
        for (;;) {
          let prev = cur.skipWord(state, false)
          if (!prev) break
          found.push(prev.head)
          cur = prev
        }
        ist(JSON.stringify(found), JSON.stringify(positions))
      })
    }

    test("can skip words", "a bbb c", [7, 3, 1])

    test("skips whitespace", "a  bbb ", [4, 1])

    test("skips punctuation", "a. b??? / c", [11, 4, 1])

    test("can move across blocks", ["abc def ", " efg"], [12, 5, 1])

    test("includes extra positions at start", " a b", [4, 2, 1])

    test("is direction-aware", "a واحد اثنين ثلاثة b", [20, 7, 13, 19, 1])

    test("uses a segmenter", "两只兔子", [3, 2, 1])
  })
})
