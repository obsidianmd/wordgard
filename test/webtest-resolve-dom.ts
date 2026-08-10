import {Wordgard, Widget, Decoration, PointSet} from "wordgard/editor"
import {GardState} from "wordgard/state"
import {Plot, Leaf, Elt} from "wordgard/doc"
import ist from "ist"
import {basicBuilders} from "./schema.ts"

const {DocTile} = Wordgard
const dummyEditor: Wordgard = {connected: false} as any

const {doc, p, $img, hr, capFig, strong, em, code} = basicBuilders

function render(doc: Plot.Doc, ...config: GardState.Extension[]) {
  return DocTile.create(GardState.create({doc, config}), document.createElement("div"), dummyEditor)
}

function isIn(pos: {dom: Node, offset: number}, parent: string, offset: number) {
  ist(pos.dom.nodeValue || pos.dom.nodeName, parent)
  ist(pos.offset, offset)
}

describe("DocTile.resolve", () => {
  it("resolves into text nodes when biased", () => {
    let node = render(doc(p("one")))
    isIn(node.resolve(1, 1), "one", 0)
    isIn(node.resolve(1, -1), "P", 0)
    isIn(node.resolve(4, -1), "one", 3)
    isIn(node.resolve(4, 1), "P", 1)
  })

  it("resolves simple positions", () => {
    let node = render(doc(p("one", $img), hr))
    isIn(node.resolve(0, 1), "DIV", 0)
    isIn(node.resolve(1, -1), "P", 0)
    isIn(node.resolve(1, 1), "one", 0)
    isIn(node.resolve(2, 1), "one", 1)
    isIn(node.resolve(4, -1), "one", 3)
    isIn(node.resolve(4, 1), "P", 1)
    isIn(node.resolve(5, 1), "P", 2)
    isIn(node.resolve(6, -1), "DIV", 1)
    isIn(node.resolve(6, 1), "DIV", 1)
    isIn(node.resolve(7, -1), "DIV", 2)
  })

  function span(name: string) {
    let span = document.createElement("span")
    span.setAttribute("data-name", name)
    return span
  }

  it("resolves properly between widgets", () => {
    let set = PointSet.create([
      [3, Decoration.Point.widget(Widget.create({render: () => span("A")}), {side: -1})],
      [3, Decoration.Point.widget(Widget.create({render: () => span("B")}), {side: 0})],
      [3, Decoration.Point.widget(Widget.create({render: () => span("C")}), {side: 0})],
      [3, Decoration.Point.widget(Widget.create({render: () => span("D")}), {side: 1})]
    ])
    let node = render(doc(p("abcd")), Decoration.Point.source.of(() => set))
    isIn(node.resolve(3, -1), "P", 2)
    isIn(node.resolve(3, 1), "P", 4)
    isIn(node.resolve(4, 1), "cd", 1)
  })

  it("picks the correct side on mark boundaries", () => {
    let node = render(doc(p("a", em("b", strong("c")), code("d"))))
    isIn(node.resolve(2, -1), "a", 1)
    isIn(node.resolve(2, 1), "b", 0)
    isIn(node.resolve(3, -1), "b", 1)
    isIn(node.resolve(3, 1), "c", 0)
    isIn(node.resolve(4, -1), "c", 1)
    isIn(node.resolve(4, 1), "d", 0)
    isIn(node.resolve(5, -1), "d", 1)
    isIn(node.resolve(5, 1), "P", 3)
  })

  it("picks the right side of widgets on wrapper boundaries", () => {
    let set = PointSet.create([
      [1, Decoration.Point.widget(Widget.create({render: () => span("A")}), {side: -1})],
      [2, Decoration.Point.widget(Widget.create({render: () => span("B")}), {side: 1})],
      [3, Decoration.Point.widget(Widget.create({render: () => span("C")}), {side: 1})],
      [4, Decoration.Point.widget(Widget.create({render: () => span("D")}), {side: -1})]
    ])
    let node = render(doc(p(strong("a"), "b", strong("c"), "d")), Decoration.Point.source.of(() => set))
    isIn(node.resolve(1, -1), "P", 1)
    isIn(node.resolve(1, 1), "a", 0)
    isIn(node.resolve(2, -1), "a", 1)
    isIn(node.resolve(2, 1), "P", 2)
    isIn(node.resolve(3, -1), "b", 1)
    isIn(node.resolve(3, 1), "P", 4)
    isIn(node.resolve(4, -1), "P", 7)
    isIn(node.resolve(4, 1), "d", 0)
  })

  it("does not resolve into inner node structure", () => {
    Plot.Doc.noValidate(() => {
      let node = render(doc(p("a"), capFig("test.png", "Caption")))
      isIn(node.resolve(4, -1), "FIGCAPTION", 0)
      isIn(node.resolve(11, 1), "FIGCAPTION", 1)
    })
  })

  it("can handle node structure inside content wrappers", () => {
    let Complex = Plot.define("Complex", {
      shape: {
        structure: Elt.mk("weird", [
          Elt.mk("span", ["<<"]),
          Elt.mk("inner", [Elt.mk("span", ["[["]), 0, Elt.mk("span", ["]]"])]),
          Elt.mk("span", [">>"])
        ])
      },
      inlineContent: true
    })
    Plot.Doc.noValidate(() => {
      let node = render(doc(Complex.create([Leaf.text("...")])))
      isIn(node.resolve(1, -1), "INNER", 1)
      isIn(node.resolve(1, 1), "...", 0)
      isIn(node.resolve(4, -1), "...", 3)
      isIn(node.resolve(4, 1), "INNER", 2)
    })
  })
})
