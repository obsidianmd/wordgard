import {Wordgard, Decoration, decoratePlots} from "wordgard/editor"
import {GardState, Transaction} from "wordgard/state"
import {Plot, Leaf, Node} from "wordgard/doc"
import {BulletList, OrderedList, Paragraph, Heading, Blockquote} from "wordgard/types"
import ist from "ist"
import {basicBuilders} from "./schema.ts"

const {DocTile} = Wordgard
const {doc, p, blockquote, h1, ul, li} = basicBuilders

type DocTile = InstanceType<typeof DocTile>
const dummyEditor: Wordgard = {connected: false} as any

function render(doc: Plot.Doc, ...config: GardState.Extension[]): DocTile {
  return DocTile.create(GardState.create({doc, config}), document.createElement("div"), dummyEditor)
}

function update(tile: InstanceType<typeof DocTile>, spec: Transaction.Spec) {
  let tr = tile.state.update(spec)
  return tile.update(tr.state, tr.changes.sections, dummyEditor)
}

const classA = Decoration.Range.attribute("class", "a")
const classB = Decoration.Point.attributes({class: "b"})

function lastChar(type: Node.Query, d: Decoration.Range) {
  return decoratePlots({
    type,
    ranges: (p, range) => p.contentLength && range(d, p.contentLength - 1, p.contentLength)
  })
}

function firstChild(type: Node.Query, d: Decoration.Point) {
  return decoratePlots({type, points: (p, point) => point(classB, 0)})
}  

function lastChild(type: Node.Query, d: Decoration.Point) {
  return decoratePlots({type, points: (p, point) => point(classB, p.contentLength - p.content[p.content.length - 1].length)})
}  

describe("decoratePlots", () => {
  it("decorates plots", () => {
    let tile = render(doc(p("one"), p("two")), lastChar(Paragraph, classA))
    ist([...tile.dom.querySelectorAll(".a")].map(e => e.textContent).join(), "e,o")
  })

  it("decorates nested plots", () => {
    let tile = render(doc(blockquote(p("one"), blockquote(p("two"), p("three")))), firstChild(Blockquote, classB))
    ist(tile.dom.querySelectorAll(".b").length, 2)
  })

  it("decorates nested plots whose decorations interleave", () => {
    let tile = render(doc(blockquote(p("one"), blockquote(p("two"), p("three")), p("four"))), lastChild(Blockquote, classB))
    ist(tile.dom.querySelectorAll(".b").length, 2)
  })

  it("decorates modified plots", () => {
    let tile = render(doc(p(""), p("two")), lastChar(Paragraph, classA))
    tile = update(tile, {changes: {from: 1, insert: [Leaf.text("one")]}})
    ist(tile.dom.querySelectorAll(".a").length, 2)
  })

  it("decorate newly added plots", () => {
    let tile = render(doc(p("one")), lastChar(Paragraph, classA))
    tile = update(tile, {changes: {from: 0, insert: [p("zero")]}})
    ist(tile.dom.querySelectorAll(".a").length, 2)
  })

  it("decorates plots that changed type", () => {
    let tile = render(doc(h1("one")), lastChar(Paragraph, classA))
    ist(tile.dom.querySelectorAll(".a").length, 0)
    tile = update(tile, {changes: {from: 0, to: 1, insert: [Paragraph]}})
    ist(tile.dom.querySelectorAll(".a").length, 1)
  })

  it("removes decoration on plots that changed type", () => {
    let tile = render(doc(p("one")), lastChar(Paragraph, classA))
    ist(tile.dom.querySelectorAll(".a").length, 1)
    tile = update(tile, {changes: {from: 0, to: 1, insert: [Heading.of(1)]}})
    ist(tile.dom.querySelectorAll(".a").length, 0)
  })

  it("preserves decorations on nodes whose matching parent changed", () => {
    let tile = render(doc(ul(li(p("one")), li(ul(li(p("two")))))), firstChild(BulletList, classB))
    ist(tile.dom.querySelectorAll(".b").length, 2)
    tile = update(tile, {changes: {from: 0, to: 1, insert: [OrderedList.of(1)]}})
    ist(tile.dom.querySelectorAll(".b").length, 1)
  })

  it("preserves nested children of changed plots that aren't directly changed", () => {
    let tile = render(doc(blockquote(blockquote(p("a")), p("b"), blockquote(p("c")))), firstChild(Blockquote, classB))
    ist(tile.dom.querySelectorAll(".b").length, 3)
    tile = update(tile, {changes: {from: 8, insert: [Leaf.text("!")]}})
    ist(tile.dom.querySelectorAll(".b").length, 3)
  })
})
