import {Wordgard, Decoration, Widget} from "wordgard/editor"
import {GardState, Transaction} from "wordgard/state"
import {Plot, Leaf, Node, Elt, Mark, Token} from "wordgard/doc"
import {CodeBlock, Emphasis, Strong, Paragraph, Heading, Blockquote, Image, ImageAlt, HorizontalRule} from "wordgard/types"
import ist from "ist"
import {builder, basicBuilders, tableSchema} from "./schema.ts"
import {rDoc, rChangeSpec} from "./generate.ts"

const {DocTile} = Wordgard
const {doc, p, blockquote, h1, h2, ul, li, br, $img, img, imgAlt, fig, hr, strong, em, table, tr, td} = basicBuilders

type DocTile = InstanceType<typeof DocTile>
const dummyEditor: Wordgard = {connected: false} as any

function render(doc: Plot.Doc, ...config: GardState.Extension[]): DocTile {
  return DocTile.create(GardState.create({doc, config}), document.createElement("div"), dummyEditor)
}

function update(node: InstanceType<typeof DocTile>, spec: Transaction.Spec) {
  let tr = node.state.update(spec)
  return node.update(tr.state, tr.changes.sections, dummyEditor)
}

function span(text: string) {
  let s = document.createElement("span")
  s.textContent = text
  return s
}

const inlineWidget = Widget.define<string>({render: span, editable: true})

function compareDOM(a: Element | Text, b: Element | Text) {
  if (a instanceof Element) {
    if (!(b instanceof Element) || b.childNodes.length != a.childNodes.length ||
        b.attributes.length != a.attributes.length) return false
    for (let i = 0; i < a.childNodes.length; i++) {
      if (!compareDOM(a.childNodes[i] as any, b.childNodes[i] as any)) return false
    }
    for (let i = 0; i < a.attributes.length; i++) {
      let attr = a.attributes[i]
      if (b.getAttribute(attr.name) != attr.value) return false
    }
    return true
  } else if (a instanceof Text) {
    return b instanceof Text && a.nodeValue == b.nodeValue
  } else {
    return false
  }
}

function html(tile: DocTile) {
  return tile.dom.innerHTML.replace(/ contenteditable="false"|<img class="wg-blockBuffer" alt="">/g, "")
}

describe("DocTile", () => {
  it("can draw a simple document", () => {
    ist(html(render(doc(p("one"), p("two")))), "<p>one</p><p>two</p>")
  })

  it("can draw basic structure", () => {
    ist(html(render(doc(blockquote(ul(li(p("a: ", $img)), li(p("b"), p("c")))), hr))),
        "<blockquote><ul><li><p>a: <img src=\"test.png\"></p></li><li><p>b</p><p>c</p></li></ul></blockquote><hr>")
  })

  it("can draw marks on text", () => {
    ist(html(render(doc(p(em("ab", strong("cd")), "ef")))),
        "<p><em>ab<strong>cd</strong></em>ef</p>")
  })

  it("can draw marks with a preferred target", () => {
    let Img = Leaf.define("Img", {
      inline: true,
      shape: {structure: () => Elt.mk("span", {class: "my-img"}, [Elt.mk("img", {src: "/x.webp"})])}
    })
    let Alt = Mark.Type.define<string>("Alt", {
      target: Img,
      shape: {attribute: "alt", value: 0, preferTarget: "img"}
    })
    let alt = builder(Alt), img = builder(Img)
    Plot.Doc.noValidate(() => {
      ist(html(render(doc(p(alt("x", img))))),
          `<p><span class="my-img"><img alt="x" src="/x.webp"></span></p>`)
    })
  })

  it("can draw nodes with structure representation", () => {
    ist(html(render(doc(h2("head")))), "<h2>head</h2>")
  })

  it("can draw nodes with complicated structure", () => {
    let FancyBlock = Plot.define("FancyBlock", {
      group: Node.Group.Content,
      inlineContent: Node.Group.Inline,
      shape: {
        structure: Elt.mk("div", {class: "c"}, [Elt.mk("span", ["before"]), 0, Elt.mk("span", ["after"])])
      }
    })
    Plot.Doc.noValidate(() => {
      let tile = render(doc(FancyBlock.create([Leaf.text("!")])))
      ist(html(tile), `<div class=\"c\"><span>before</span>!<span>after</span></div>`)
      tile = update(tile, {changes: [{from: 0, insert: [p("(")]},
                                     {from: 1, to: 2, insert: [Leaf.text("?")]},
                                     {from: 3, insert: [p(")")]}]})
      ist(html(tile), `<p>(</p><div class=\"c\"><span>before</span>?<span>after</span></div><p>)</p>`)
    })
  })

  it("can draw marks on nodes", () => {
    ist(html(render(doc(p(imgAlt("alt text", $img))))),
        "<p><img alt=\"alt text\" src=\"test.png\"></p>")
  })

  it("can update for a text change", () => {
    let node = update(render(doc(p("123"))), {changes: {from: 2, insert: [Leaf.text("..")]}})
    ist(html(node), "<p>1..23</p>")
  })

  it("can update for a tag change", () => {
    let node = update(render(doc(p("a"))), {changes: {from: 0, to: 1, insert: [CodeBlock]}})
    ist(html(node), "<pre>a</pre>")
  })

  it("can make multiple changes", () => {
    let node = update(render(doc(p("ab"), p("cd"))), {changes: [{from: 1, insert: [Leaf.text("..")]}, {from: 2, to: 6}]})
    ist(html(node), "<p>..ad</p>")
  })

  it("can update text marks", () => {
    let node = update(render(doc(p("one ", em("two")))), {
      changes: [{from: 1, to: 4, add: Strong}, {from: 5, to: 8, remove: Emphasis}]
    })
    ist(html(node), "<p><strong>one</strong> two</p>")
  })

  it("can update node marks", () => {
    let node = update(render(doc(p($img, " ", imgAlt("a2", $img)))), {
      changes: [{from: 1, add: ImageAlt.of("a1")}, {from: 3, remove: ImageAlt.of("a2")}]
    })
    ist(html(node), "<p><img src=\"test.png\" alt=\"a1\"> <img src=\"test.png\"></p>")
  })

  it("can draw spanning marks", () => {
    ist(html(render(doc(p(strong("a", $img, "b"), "c")))),
        "<p><strong>a<img src=\"test.png\">b</strong>c</p>")
  })

  it("can join spanning marks in updates", () => {
    let node = update(render(doc(p(strong("a"), "b", strong("c")))), {changes: {from: 2, to: 3}})
    ist(html(node), "<p><strong>ac</strong></p>")
  })

  it("preserves DOM nodes with changed wrappers marks", () => {
    let node = render(doc(p(strong($img))))
    let img = node.dom.querySelector("img")
    node = update(node, {changes: {from: 1, remove: Strong, add: Emphasis}})
    ist(node.dom.querySelector("img"), img)
  })

  it("properly syncs replacements inside wrappers", () => {
    let node = render(doc(p(strong("abc")), p("def")))
    ist(html(update(node, {changes: {from: 2, insert: [Leaf.text("..", [Strong])]}})),
        "<p><strong>a..bc</strong></p><p>def</p>")
  })

  it("preserves DOM nodes with changed attribute marks", () => {
    let node = render(doc(p($img)))
    let img = node.dom.querySelector("img")
    node = update(node, {changes: {from: 1, add: ImageAlt.of("text")}})
    ist(node.dom.querySelector("img"), img)
  })

  it("preserves mark wrapper nodes", () => {
    let node = render(doc(p(strong("ab"))))
    let str = node.dom.querySelector("strong")
    node = update(node, {changes: {from: 2, insert: [Leaf.text("!")]}})
    ist(node.dom.querySelector("strong"), str)
  })

  it("adds breaks for empty textblocks and those ending in breaks", () => {
    let node = render(doc(p(), p("a"), p("b", br)))
    ist(html(node), "<p><br></p><p>a</p><p>b<br><br></p>")
  })

  it("fixes textblock breaks on changes", () => {
    let node = render(doc(p(), p("a")))
    ist(html(update(node, {changes: [{from: 1, insert: [Leaf.text("x")]}, {from: 3, to: 4}]})),
        "<p>x</p><p><br></p>")
  })

  it("keeps parent nodes when updating their content", () => {
    let node = render(doc(p("a")))
    let para = node.dom.firstChild
    node = update(node, {changes: [{from: 2, insert: [Leaf.text("b")]}]})
    ist(node.dom.firstChild, para)
  })

  it("reuses text nodes when changing their start", () => {
    let node = render(doc(p("abc"), p("def")))
    let abc = node.dom.firstChild!.firstChild!, def = node.dom.lastChild!.firstChild!
    node = update(node, {changes: [{from: 1, insert: [Leaf.text("..")]}, {from: 6, to: 7}]})
    ist(abc.nodeValue, "..abc")
    ist(def.nodeValue, "ef")
  })

  it("reuses text nodes when changing their end", () => {
    let node = render(doc(p("abc"), p("def")))
    let abc = node.dom.firstChild!.firstChild!, def = node.dom.lastChild!.firstChild!
    node = update(node, {changes: [{from: 4, insert: [Leaf.text("..")]}, {from: 8, to: 9}]})
    ist(abc.nodeValue, "abc..")
    ist(def.nodeValue, "de")
  })

  it("reuses text nodes when changing their middle", () => {
    let node = render(doc(p("abc"), p("def")))
    let abc = node.dom.firstChild!.firstChild!, def = node.dom.lastChild!.firstChild!
    node = update(node, {changes: [{from: 2, insert: [Leaf.text("..")]}, {from: 7, to: 8}]})
    ist(abc.nodeValue, "a..bc")
    ist(def.nodeValue, "df")
  })

  it("can handle adding a mark to part of a textblock", () => {
    let tile = update(render(doc(p("one two"))), {changes: {from: 5, to: 8, add: Strong}})
    ist(html(tile), "<p>one <strong>two</strong></p>")
  })

  it("can handle a change moving content up", () => {
    let tile = update(render(doc(blockquote(p("abc")))), {
      changes: [{from: 0, to: 2, insert: [Paragraph]}, {from: 6, to: 7}]
    })
    ist(html(tile), "<p>abc</p>")
  })

  it("can handle a change moving content down", () => {
    let tile = update(render(doc(p("abc"))), {
      changes: [{from: 0, to: 1, insert: [Blockquote, Paragraph]}, {from: 5, insert: [Token.End]}]
    })
    ist(html(tile), "<blockquote><p>abc</p></blockquote>")
  })

  it("handles insertion of text before a mark", () => {
    let tile = update(render(doc(p(strong("a"), "b"))), {changes: {from: 1, insert: [Leaf.text("x")]}})
    ist(html(tile), "<p>x<strong>a</strong>b</p>")
  })

  it("can handle random changes", () => {
    for (let i = 0; i < 100; i++) {
      let start = rDoc(20), doc = start, tile = render(doc)
      let log = []
      for (let j = 0; j < 100; j++) {
        let changes = rChangeSpec(doc)
        log.push(changes)
        tile = update(tile, {changes})
        doc = tile.state.doc
      }
      if (!compareDOM(render(doc).dom, tile.dom)) {
        ist(html(render(doc)), html(tile))
      }
    }
  })

  it("renders block buffers next to uneditable elements", () => {
    Plot.Doc.noValidate(() => {
      let buf = `<img class="wg-blockBuffer" alt="">`, fg = `<figure contenteditable="false"><img src="/x.webp"></figure>`
      ist(render(doc(fig("/x.webp"), fig("/x.webp"), p(), fig("/x.webp"))).dom.innerHTML,
          `${buf}${fg}${buf}${fg}<p><br></p>${fg}${buf}`)
    })
  })

  describe("decoration", () => {
    it("can draw widgets around nodes", () => {
      let src = (side: "before" | "after" | "start" | "end") => Decoration.Tag.widget(Paragraph, side, inlineWidget.of(side))
      let node = render(doc(p("xyz"), hr), src("before"), src("start"), src("end"), src("after"))
      ist(html(node), "<span>before</span><p><span>start</span>xyz<span>end</span></p><span>after</span><hr>")
    })

    it("can reuse widgets when replacing next to them", () => {
      let src = (side: "before" | "after" | "start" | "end") => Decoration.Tag.widget(Image, side, inlineWidget.of(side))
      let node = render(doc(p("x", $img, "y")), src("before"), src("after"))
      let widgets = node.dom.querySelectorAll("span")
      node = update(node, {changes: {from: 2, to: 3, insert: [img("/x.webp")]}})
      let newWidgets = node.dom.querySelectorAll("span")
      ist(newWidgets.length, 2)
      for (let i = 0; i < widgets.length; i++) ist(newWidgets[i], widgets[i])
    })

    it("can reuse widgets when updating across them", () => {
      let src = (side: "before" | "after" | "start" | "end") => Decoration.Tag.widget(Image, side, inlineWidget.of(side))
      let node = render(doc(p(strong("x", $img, "y"), em("z", $img))), src("before"), src("after"))
      let widgets = node.dom.querySelectorAll("span")
      node = update(node, {changes: [
        {from: 1, to: 4, remove: Strong, add: Emphasis},
        {from: 4, to: 6, remove: Emphasis}
      ]})
      let newWidgets = node.dom.querySelectorAll("span")
      ist(newWidgets.length, 4)
      for (let i = 0; i < widgets.length; i++) ist(newWidgets[i], widgets[i])
    })

    it("updates tag widgets at the end of a changed plot", () => {
      let node = render(doc(p("x"), h2("y")), [
        Decoration.Tag.widget(Heading, "end", t => inlineWidget.of("E" + t.param)),
        Decoration.Tag.widget(Heading, "after", t => inlineWidget.of("A" + t.param))
      ])
      ist(html(node), `<p>x</p><h2>y<span>E2</span></h2><span>A2</span>`)
      node = update(node, {changes: [
        {from: 0, to: 1, insert: [Heading.of(2)]},
        {from: 3, to: 4, insert: [Heading.of(3)]}
      ]})
      ist(html(node), `<h2>x<span>E2</span></h2><span>A2</span><h3>y<span>E3</span></h3><span>A3</span>`)
      node = update(node, {changes: [
        {from: 0, to: 1, insert: [Paragraph]},
        {from: 3, to: 4, insert: [Paragraph]}
      ]})
      ist(html(node), `<p>x</p><p>y</p>`)
    })

    it("doesn't break spanning wrappers on widgets", () => {
      let src = (side: "before" | "after" | "start" | "end") => Decoration.Tag.widget(Image, side, inlineWidget.of(side))
      let node = render(doc(p(strong("x", $img, "y"))), src("before"), src("after"))
      let spanning = node.dom.querySelectorAll("strong")
      ist(spanning.length, 1)
      ist(node.dom.querySelector("span")!.parentNode, spanning[0])
    })

    it("keeps structure entirely the same on a no-change update", () => {
      let node = render(doc(p(strong("one", em("two"), $img, "three")), hr))
      let elts = node.dom.querySelectorAll("*")
      let tr1 = node.state.update({changes: {from: 1, to: 12, remove: Strong}})
      let tr2 = tr1.state.update({changes: {from: 1, to: 12, add: Strong}})
      node = node.update(tr2.state, tr1.changes.compose(tr2.changes).sections, dummyEditor)
      let newElts = node.dom.querySelectorAll("*")
      ist(newElts.length, elts.length)
      for (let i = 0; i < elts.length; i++) ist(newElts[i], elts[i])
    })

    it("can draw widgets from a point set", () => {
      let node = render(doc(p("abc")), Decoration.Point.source.of(state => {
        return Decoration.Point.set([[Decoration.Point.widget(inlineWidget.of("x")), 1],
                                     [Decoration.Point.widget(inlineWidget.of("y")), 3]])
      }))
      ist(html(node), "<p><span>x</span>ab<span>y</span>c</p>")
    })

    it("can update widgets from a point set", () => {
      let f = GardState.Field.define({
        create: () => Decoration.Point.set([[Decoration.Point.widget(inlineWidget.of("x")), 1]]),
        update: () => Decoration.Point.set([[Decoration.Point.widget(inlineWidget.of("y")), 4]]),
        provide: f => Decoration.Point.source.of(s => s.field(f))
      })
      let node = update(render(doc(p("a"), p("b")), f), {})
      ist(html(node), "<p>a</p><p><span>y</span>b</p>")
    })

    it("can update widgets in place", () => {
      let f = GardState.Field.define({
        create: () => Decoration.Point.set([[Decoration.Point.widget(inlineWidget.of("x")), 1]]),
        update: () => Decoration.Point.set([[Decoration.Point.widget(inlineWidget.of("y")), 1]]),
        provide: f => Decoration.Point.source.of(s => s.field(f))
      })
      let node = update(render(doc(p("a")), f), {})
      ist(html(node), "<p><span>y</span>a</p>")
    })

    it("orders widgets by side", () => {
      let w = (n: number) => Widget.create({render: () => span(n + "")})
      let src = (s: number) => Decoration.Point.source.of(() => Decoration.Point.set([[Decoration.Point.widget(w(s), {side: s}), 2]]))
      ist(html(render(doc(p("xy")), src(1), src(-2), src(-1))),
          "<p>x<span>-2</span><span>-1</span><span>1</span>y</p>")
    })

    it("can redraw widgets at the end of the document", () => {
      let widget = Widget.define({
        render: v => Object.assign(document.createElement("b"), {textContent: v})
      })
      let flip = Transaction.Effect.define()
      let field = GardState.Field.define({
        create: s => Decoration.Point.set([[Decoration.Point.widget(widget.of("x")), s.doc.length]]),
        update: (v, tr) => tr.effects.some(e => e.is(flip))
          ? Decoration.Point.set([[Decoration.Point.widget(widget.of("y")), tr.state.doc.length]]) : v,
        provide: f => Decoration.Point.source.of(s => s.field(f))
      })

      let tile = update(render(doc(p("ab")), field), {effects: flip.of(null)})
      ist(html(tile), "<p>ab</p><b>y</b>")
    })

    it("doesn't duplicate widgets on section boundaries", () => {
      let node = render(doc(p(strong("a"), $img)),
                        Decoration.Tag.widget(Image, "before", inlineWidget.of("!")))
      ist(html(node), "<p><strong>a</strong><span>!</span><img src=\"test.png\"></p>")
      node = update(node, {changes: [
        {from: 1, to: 2, remove: Strong},
        {from: 2, to: 3, insert: [$img]}
      ]})
      ist(html(node), "<p>a<span>!</span><img src=\"test.png\"></p>")
    })

    it("can decorate tags", () => {
      let pWrap = Decoration.Tag.wrapper(Paragraph, Elt.mk("div", {class: "pwrap"}, [0]))
      let iWrap = Decoration.Tag.wrapper(Image, Elt.mk("image", [0]))
      ist(html(render(doc(p("a", $img)), [pWrap, iWrap])),
          `<div class="pwrap"><p>a<image><img src="test.png"></image></p></div>`)
    })

    it("updates wrappers when they change", () => {
      let wA = Decoration.Range.wrapper("span",  {attributes: {class: "a"}})
      let wB = Decoration.Range.wrapper("span",  {attributes: {class: "b"}})
      let tile = render(doc(p("-")), Decoration.Range.source.of(s => {
        return Decoration.Range.set([[s.selection.from == 1 ? wA : wB, 1, 2]])
      }))
      ist(html(tile), `<p><span class="a">-</span></p>`)
      tile = update(tile, {selection: {anchor: 2}})
      ist(html(tile), `<p><span class="b">-</span></p>`)
    })

    it("can handle changes from range and point decorations in a single transactions", () => {
      let point = Decoration.Point.source.of(s => {
        return Decoration.Point.set([[Decoration.Point.widget(inlineWidget.of(s.selection.from == 1 ? "x" : "y")), 2]])
      })
      let range = Decoration.Range.source.of(s => {
        return Decoration.Range.set([[Decoration.Range.attribute("data-m", String(s.selection.from)), 5, 6]])
      })
      let tile = update(render(doc(p("abcdef")), [point, range]), {selection: {anchor: 2}})
      ist(html(tile), `<p>a<span>y</span>bcd<span data-m="2">e</span>f</p>`)
    })

    it("can add attributes to tags", () => {
      ist(html(render(doc(p("?")), Decoration.Tag.attribute(Paragraph, "lang", "nl"))), "<p lang=\"nl\">?</p>")
    })

    it("can remove attributes from tags", () => {
      let comp = GardState.Compartment.define()
      let node = render(doc(p("?")), comp.of(Decoration.Tag.attribute(Paragraph, "lang", "nl")))
      node = update(node, {effects: comp.reconfigure([])})
      ist(html(node), "<p>?</p>")
    })

    it("preserves DOM nodes when adding attributes", () => {
      let node = render(doc(p("a"))), para = node.dom.firstChild
      node = update(node, {effects: GardState.reconfigure.of(Decoration.Tag.attribute(Paragraph, "lang", "nl"))})
      ist(html(node), "<p lang=\"nl\">a</p>")
      ist(node.dom.firstChild, para)
    })

    it("doesn't drop point decorations directly after a change", () => {
      let classes = Decoration.Point.source.of(s => {
        return Decoration.Point.set(add => {
          let i = 0
          s.doc.iterate((node, pos) => {
            if (node.type == Paragraph.type)
              add(Decoration.Point.attributes({"class": `c${++i % 3}`}), pos)
          })
        })
      })
      let node = update(render(doc(p("a"), p("b"), p("c")), classes), {changes: {from: 0, to: 3}})
      ist(html(node), `<p class="c1">b</p><p class="c2">c</p>`)
    })

    it("can take wrappers from spans", () => {
      ist(html(render(doc(p("ab", $img, "cd")), Decoration.Range.source.of(s => {
        return Decoration.Range.set([[Decoration.Range.wrapper("span", {attributes: {class: "a"}}), 2, 5]])
      }))), "<p>a<span class=\"a\">b<img src=\"test.png\">c</span>d</p>")
    })

    it("can take attributes from spans", () => {
      ist(html(render(doc(p("ab", $img, "cd")), Decoration.Range.source.of(s => {
        return Decoration.Range.set([[Decoration.Range.attribute("alt", "a test", {query: Image}), 2, 5]])
      }))), "<p>ab<img alt=\"a test\" src=\"test.png\">cd</p>")
    })

    it("notices changes to spans that start before a preserved section", () => {
      ist(html(update(render(doc(p("abcd")), Decoration.Range.source.of(s => {
        let wrap = Decoration.Range.wrapper("span", {attributes: {class: s.doc.length % 2 ? "x" : "y"}})
        return Decoration.Range.set([[wrap, 1, s.doc.length - 1]])
      })), {
        changes: {from: 3, insert: [Leaf.text("/")]}
      })), `<p><span class="x">ab/cd</span></p>`)
    })

    it("can override a specific leaf node's shape", () => {
      ist(html(render(doc(p("ab", $img, "cd")), Decoration.Point.source.of(state => {
        return Decoration.Point.set([[Decoration.Point.shape(Elt.mk("span", ["!"])), 3]])
      }))), `<p>ab<span>!</span>cd</p>`)
    })

    it("can override a specific non-leaf node's shape", () => {
      ist(html(render(doc(p("ab", $img, "cd")), Decoration.Point.source.of(state => {
        return Decoration.Point.set([[Decoration.Point.shape(Elt.mk("div", [0])), 0]])
      }))), "<div>ab<img src=\"test.png\">cd</div>")
    })

    it("can give a plot an atomic shape", () => {
      ist(html(render(doc(p("ab", $img, "cd")), Decoration.Point.source.of(state => {
        return Decoration.Point.set([[Decoration.Point.shape(Elt.mk("div", ["?"])), 0]])
      }))), `<div>?</div>`)
    })

    it("can dynamically redraw a plot as an atom", () => {
      let tile = render(doc(p("abc")))
      tile = update(tile, {effects: GardState.appendConfig.of(Decoration.Point.source.of(state => {
        return Decoration.Point.set([[Decoration.Point.shape(Elt.mk("div", ["?"])), 0]])
      }))})
      ist(html(tile), `<div>?</div>`)
    })

    it("can dynamically redraw an atom plot as a regular plot", () => {
      let tile = render(doc(p("abc")), Decoration.Point.source.of(state => {
        return Decoration.Point.set([[Decoration.Point.shape(Elt.mk("div", ["?"])), 0]])
      }))
      tile = update(tile, {effects: GardState.reconfigure.of([])})
      ist(html(tile), "<p>abc</p>")
    })

    it("can change between normal plot and atom plot", () => {
      let atomH = Decoration.Tag.shape(Heading, Elt.mk("h1", ["H"]))
      let tile = update(render(doc(h1("abcd")), atomH), {changes: {from: 0, to: 1, insert: [Paragraph]}})
      ist(html(tile), "<p>abcd</p>")
      tile = update(tile, {changes: {from: 0, to: 1, insert: [Heading.of(1)]}})
      ist(html(tile), `<h1>H</h1>`)
    })

    it("can add attributes to a specific node", () => {
      let deco = Decoration.Point.set([[Decoration.Point.attributes({class: "u"}), 0]])
      ist(html(render(doc(p(), p()), Decoration.Point.source.of(() => deco))),
          "<p class=\"u\"><br></p><p><br></p>")
    })

    it("won't try to add attributes to a text node", () => {
      let deco = Decoration.Point.set([[Decoration.Point.attributes({class: "u"}), 1]])
      ist(html(render(doc(p("a")), Decoration.Point.source.of(() => deco))), "<p>a</p>")
    })

    it("doesn't leave stale decorations on complex changes", () => {
      let doc = builder(tableSchema)
      let attr = Decoration.Point.attributes({class: "x"})
      let tile = render(doc(p("-"), table(tr(td("A"), td("B")), tr(td("C"), td("D")))),
                        Decoration.Point.source.of(state => state.doc.length == 21
                          ? Decoration.Point.set([[attr, 5], [attr, 8]]) : Decoration.Point.none))
      tile = update(tile, {changes: [
        {from: 6, to: 7}, {from: 9, to: 10},
        {from: 14, to: 15, insert: [Leaf.text("A")]},
        {from: 17, to: 18, insert: [Leaf.text("B")]}
      ]})
      ist(tile.dom.querySelector(".x"), null)
    })

    it("can add wrapping structure to a specific node", () => {
      let deco = Decoration.Point.set([[Decoration.Point.wrapper(Elt.mk("div", [Elt.mk("hr"), 0])), 3]])
      ist(html(render(doc(p("x"), p("y")), Decoration.Point.source.of(() => deco))),
          "<p>x</p><div><hr><p>y</p></div>")
    })

    it("can handle a change modifying the depth of a plot's wrapper", () => {
      let deco = Decoration.Point.set([[Decoration.Point.wrapper(Elt.mk("div", [Elt.mk("hr"), 0])), 0]])
      let node = update(render(doc(p("x"), p("y"))), {
        effects: GardState.appendConfig.of(Decoration.Point.source.of(() => deco))
      })
      ist(html(node), "<div><hr><p>x</p></div><p>y</p>")
    })

    it("can replace the shape of a node type", () => {
      let tile = render(doc(p("a", $img, "b")), Decoration.Tag.shape(Image, Elt.mk("span", {"class": "img"})))
      ist(html(tile), `<p>a<span class="img"></span>b</p>`)
    })

    it("properly handles insertions at the start and end of wrapping structure", () => {
      let wrapPara = Decoration.Tag.shape(Paragraph, Elt.mk("div", [Elt.mk("p", [0])]))
      let tile = render(doc(p("ab")), wrapPara)
      tile = update(tile, {changes: {from: 3, insert: [Leaf.text("x")]}})
      ist(html(tile), "<div><p>abx</p></div>")
      tile = update(tile, {changes: {from: 1, insert: [Leaf.text("y")]}})
      ist(html(tile), "<div><p>yabx</p></div>")
    })

    it("can handle changes inside atomic plots", () => {
      let tile = render(doc(p("abcd")), Decoration.Tag.shape(Paragraph, Elt.mk("para")))
      let para = tile.dom.querySelector("para")
      tile = update(tile, {changes: {from: 1, insert: [Leaf.text("--")]}})
      ist(html(tile), `<para></para>`)
      ist(tile.dom.querySelector("para"), para)
    })

    it("can handle deletion inside an atomic plot", () => {
      let tile = render(doc(p("abcd")), Decoration.Tag.shape(Paragraph, Elt.mk("para")))
      tile = update(tile, {changes: {from: 2, to: 4}})
      ist(html(tile), `<para></para>`)
      ist(tile.children[1].length, 4)
    })

    it("can handle changes covering parts of atomic plots", () => {
      let tile = render(doc(p("ab"), p("cd")), Decoration.Tag.shape(Paragraph, Elt.mk("para")))
      tile = update(tile, {changes: {from: 2, to: 6}})
      ist(html(tile), `<para></para>`)
    })

    it("can handle changes covering parts of wrapped atomic plots", () => {
      let tile = render(doc(p("ab"), p("cd")), [
        Decoration.Tag.shape(Paragraph, Elt.mk("para")),
        Decoration.Tag.wrapper(Paragraph, Elt.mk("outer", [0]))
      ])
      tile = update(tile, {changes: {from: 2, to: 6, insert: [Plot.End, Paragraph]}})
      ist(html(tile), `<outer><para></para></outer><outer><para></para></outer>`)
    })

    it("can handle changes covering the start of atomic plots", () => {
      let tile = render(doc(h2("ab"), p("cd")), Decoration.Tag.shape(Paragraph, Elt.mk("para")))
      tile = update(tile, {changes: {from: 2, to: 6, insert: [Plot.End, Paragraph]}})
      ist(html(tile), `<h2>a</h2><para></para>`)
    })

    it("supports selectors for wrapper decorations", () => {
      let complexImg = Decoration.Tag.shape(Image, i => Elt.mk("span", {class: "my-image"}, [Elt.mk("img", {src: i.param})]))
      let deco = Decoration.Point.set([[Decoration.Point.wrapper(Elt.mk("span", {class: "inner"}, [0]), {target: "img"}), 2]])
      let tile = render(doc(p("»", $img)), [complexImg, Decoration.Point.source.of(() => deco)])
      ist(html(tile), `<p>»<span class="my-image"><span class="inner"><img src="test.png"></span></span></p>`)
    })

    it("can reuse DOM structure when adding a shape wrapper", () => {
      let node = render(doc(p($img)))
      let img = node.dom.querySelector("img")
      node = update(node, {effects: GardState.appendConfig.of(Decoration.Point.source.of(state => {
        return Decoration.Point.set([[Decoration.Point.wrapper(Elt.mk("span", {class: "u"}, [0])), 1]])
      }))})
      ist(node.dom.querySelector("img"), img)
    })

    it("makes isAtom aware of tag shapes", () => {
      ist(GardState.create({doc: doc(p())}).isAtom(Paragraph.type), false)
      let s = GardState.create({doc: doc(p()), config: Decoration.Tag.shape(Paragraph, Elt.mk("div"))})
      ist(s.isAtom(Paragraph.type), true)
    })

    it("can override shapes by tag", () => {
      ist(html(render(doc(p("a")), Decoration.Tag.shape(Paragraph, Elt.mk("div", {class: "para"}, [0])))),
          "<div class=\"para\">a</div>")
    })

    it("makes by-point shapes override by-tag ones", () => {
      ist(html(render(doc(p("a")), [
        Decoration.Tag.shape(Paragraph, Elt.mk("div", {class: "b"}, [0])),
        Decoration.Point.source.of(state => {
          return Decoration.Point.set([[Decoration.Point.shape(Elt.mk("div", {class: "a"}, [0])), 0]])
        })
      ])), "<div class=\"a\">a</div>")
    })

    it("properly updates when tag shapes change", () => {
      let tile = render(doc(p("a")))
      tile = update(tile, {
        effects: GardState.appendConfig.of(Decoration.Tag.shape(Paragraph, Elt.mk("para", [0])))
      })
      ist(html(tile), "<para>a</para>")
    })

    it("properly updates when positional shapes change", () => {
      let tile = render(doc(p("a")))
      tile = update(tile, {
        effects: GardState.appendConfig.of(Decoration.Point.source.of(state => {
          return Decoration.Point.set([[Decoration.Point.shape(Elt.mk("para")), 0]])
        }))
      })
      ist(html(tile), `<para></para>`)
    })

    it("renders shape atoms at the end of a positional shape change", () => {
      let tile = render(doc(p("a")))
      tile = update(tile, {
        effects: GardState.appendConfig.of(Decoration.Point.source.of(state => {
          return Decoration.Point.set([[Decoration.Point.shape(Elt.mk("div", [Elt.mk("p", [0]), Elt.mk("after")])), 0]])
        }))
      })
      ist(html(tile), `<div><p>a</p><after></after></div>`)
    })

    it("keeps to-the-side node structure in place when the node's content changes", () => {
      let paraShape = Decoration.Tag.shape(Paragraph, Elt.mk("div", [Elt.mk("before"), Elt.mk("p", [0]), Elt.mk("after")]))
      let tile = update(render(doc(p("abc")), paraShape), {changes: {from: 2, to: 3}})
      ist(html(tile),
          `<div><before></before><p>ac</p><after></after></div>`)
    })

    it("supports dynamic shapes", () => {
      let cls = GardState.Facet.define<string>(), called = 0
      let tile = render(doc(hr), [
        Decoration.Tag.shape.derived(HorizontalRule.type, state => {
          called++
          return Elt.mk("hr", {class: state.facet(cls)[0]})
        }),
        cls.of("a")
      ])
      tile = update(tile, {selection: {anchor: 1}})
      ist(html(tile), `<hr class="a">`)
      ist(called, 1)
      tile = update(tile, {effects: GardState.appendConfig.of(GardState.prec.high(cls.of("b")))})
      ist(html(tile), `<hr class="b">`)
    })

    it("can change the shape of element marks", () => {
      ist(html(render(doc(p(strong("ab"))), Decoration.Mark.shape(Strong, {element: "b"}))),
          "<p><b>ab</b></p>")
    })

    it("can change the shape of attribute marks", () => {
      let deco = Decoration.Mark.shape(ImageAlt, {attribute: "aria-description", value: 0})
      ist(html(render(doc(p(imgAlt("p", $img))), deco)),
          `<p><img aria-description="p" src="test.png"></p>`)
    })
  })
})
