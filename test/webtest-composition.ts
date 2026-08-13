import {Wordgard} from "wordgard/editor"
import {Strong} from "wordgard/types"
import {GardSelection} from "wordgard/state"
import ist from "ist"
import {tempEditor, requireFocus} from "./tempview.ts"
import {basicBuilders, eq} from "./schema.ts"
const {doc, p, strong, em} = basicBuilders

function compositionEvent(wg: Wordgard, type: string) {
  wg.contentDOM.dispatchEvent(new CompositionEvent(type))
}

function inputEvent(wg: Wordgard, type: string, init: InputEventInit) {
  let event = new InputEvent(type, init)
  // Safari doesn't support the targetRanges option
  if (init.targetRanges && !event.getTargetRanges().length) {
    event.getTargetRanges = () => init.targetRanges!
  }
  wg.contentDOM.dispatchEvent(event)
}

type CompositionUpdate = [number, number, string, () => Text] | [number, number, string]

function selEnd(node: Node) {
  document.getSelection()!.collapse(node, node.nodeValue!.length)
  return node as Text
}

function compose(wg: Wordgard, start: CompositionUpdate | (() => Text),
                 ...args: (CompositionUpdate | {end?: (node: Text) => void, cancel?: boolean})[]) {
  let last = args[args.length - 1]
  let [updates, options] = Array.isArray(last)
    ? [args as CompositionUpdate[], {}]
    : [args.slice(0, args.length - 1) as CompositionUpdate[], last as any]

  ist(!wg.composing)
  compositionEvent(wg, "compositionstart")
  ist(wg.composing)
  let node!: Text, sel = document.getSelection()!
  for (let i = -1; i < updates.length; i++) {
    let update: CompositionUpdate | undefined
    if (i < 0) {
      if (typeof start == "function") node = start()
      else update = start
    } else {
      update = updates[i]
    }
    if (update) {
      compositionEvent(wg, "compositionupdate")
      let [from, to, text] = update
      let fromDOM = wg.domAtPos(from, -1)
      if (fromDOM.node.nodeType != 3 || node && node != fromDOM.node) fromDOM = wg.domAtPos(from, 1)
      let toDOM = from == to ? fromDOM : wg.domAtPos(to, -1)
      inputEvent(wg, "beforeinput", {
        inputType: "insertCompositionText",
        data: text,
        isComposing: true,
        targetRanges: [new StaticRange({startContainer: fromDOM.node, startOffset: fromDOM.offset,
                                        endContainer: toDOM.node, endOffset: toDOM.offset})]
      })
      if (update.length == 4) {
        node = update[3]()
      } else {
        node = fromDOM.node as Text
        if (node.nodeType != 3) throw new Error("Didn't find a composition text node")
        node.nodeValue = node.nodeValue!.slice(0, fromDOM.offset) + text + node.nodeValue!.slice(fromDOM.offset + (to - from))
        sel.collapse(node, fromDOM.offset + text.length)
      }
      inputEvent(wg, "input", {inputType: "insertCompositionText", data: text, isComposing: true})
    }

    let {focusNode, focusOffset} = sel
    let stack = []
    for (let p = node.parentNode; p && p != wg.contentDOM; p = p.parentNode) stack.push(p)

    wg.flush()

    if (options.cancel && i == updates.length - 1) {
      // FIXME verify a canceled composition
    } else {
      for (let p = node.parentNode, i = 0; p && p != wg.contentDOM && i < stack.length; p = p.parentNode, i++)
        ist(p, stack[i])
      ist(node.parentNode && wg.contentDOM.contains(node.parentNode))
      ist(sel.focusNode, focusNode)
      ist(sel.focusOffset, focusOffset)
      if (update) ist(wg.compositionStarted)
    }
  }
  compositionEvent(wg, "compositionend")
  if (options.end) options.end(node)
  wg.flush()
  ist(!wg.composing)
}

describe("composition", () => {
  it("supports composition inside existing text", () => {
    let wg = requireFocus(tempEditor(doc(p("a", 0, "b"))))
    compose(wg, [2, 2, "-"], [2, 3, "/"], [2, 3, "*"])
    ist(wg.state.doc, doc(p("a*b")), eq)
  })

  it("supports composition on an empty line", () => {
    let wg = requireFocus(tempEditor(doc(p("."), p(0))))
    compose(wg,
            [4, 4, "a", () => selEnd(wg.contentDOM.querySelectorAll("p")[1].appendChild(document.createTextNode("a")))],
            [5, 5, "b"],
            [6, 6, "c"])
    ist(wg.state.doc, doc(p("."), p("abc")), eq)
  })

  it("supports composition at end of block in existing node", () => {
    let wg = requireFocus(tempEditor(doc(p("foo", 0))))
    compose(wg, [4, 4, "!"], [5, 5, "?"])
    ist(wg.state.doc, doc(p("foo!?")), eq)
  })

  it("supports composition at end of block in a new node", () => {
    let wg = requireFocus(tempEditor(doc(p("foo", 0))))
    compose(wg, [4, 4, "!", () => selEnd(wg.contentDOM.firstChild!.appendChild(document.createTextNode("!")))], [5, 5, "?"])
    ist(wg.state.doc, doc(p("foo!?")), eq)
  })

  it("supports composition at start of block in a new node", () => {
    let wg = requireFocus(tempEditor(doc(p("foo"))))
    compose(wg, [1, 1, "!", () => {
      let p = wg.contentDOM.firstChild!
      return selEnd(p.insertBefore(document.createTextNode("!"), p.firstChild))
    }], [2, 2, "?"])
    ist(wg.state.doc, doc(p("!?foo")), eq)
  })

  it("supports composition at start of line", () => {
    let wg = requireFocus(tempEditor(doc(p("c"))))
    compose(wg, [1, 1, "b"], [1, 1, "a"])
    ist(wg.state.doc, doc(p("abc")), eq)
  })

  it("handles replacement of existing words", () => {
    let wg = requireFocus(tempEditor(doc(p("one two three"))))
    compose(wg, [5, 8, "five"], [5, 9, "seven"], [5, 10, "zero"])
    ist(wg.state.doc, doc(p("one zero three")), eq)
  })

  it("can compose inside a wrapping mark", () => {
    let wg = requireFocus(tempEditor(doc(p("a", strong("b", 0, "c")))))
    compose(wg, [3, 3, "-"], [4, 4, "$"])
    ist(wg.contentDOM.innerHTML, "<p>a<strong>b-$c</strong></p>")
    ist(wg.state.doc, doc(p("a", strong("b-$c"))), eq)
  })

  it("can compose at the end of a wrapping mark", () => {
    let wg = requireFocus(tempEditor(doc(p("a", strong("bc"), 0, "d"))))
    compose(wg, () => selEnd(wg.domAtPos(3).node), [4, 4, "-"], [5, 5, "$"])
    ist(wg.contentDOM.innerHTML, "<p>a<strong>bc-$</strong>d</p>")
    ist(wg.state.doc, doc(p("a", strong("bc-$"), "d")), eq)
  })

  it("can compose at the start of a wrapping mark", () => {
    let wg = requireFocus(tempEditor(doc(p("a", 0, strong("bc"), "d"))))
    compose(wg, () => selEnd(wg.domAtPos(3).node), [2, 2, "-"], [3, 3, "$"])
    ist(wg.contentDOM.innerHTML, "<p>a-$<strong>bc</strong>d</p>")
    ist(wg.state.doc, doc(p("a-$", strong("bc"), "d")), eq)
  })

  it("handles composition in a wrapper that has multiple children", () => {
    let wg = requireFocus(tempEditor(doc(p("one ", em("two", 0, strong(" three"))))))
    compose(wg, [8, 8, "o"], [9, 9, "o"], [10, 10, "w"])
    ist(wg.state.doc, doc(p("one ", em("twooow", strong(" three")))), eq)
  })

  it("supports composition in a cursor wrapper", () => {
    let wg = requireFocus(tempEditor(doc(p(0))))
    wg.dispatch({selection: GardSelection.Text.create({anchor: 1, marks: [Strong]})})
    compose(wg, [1, 1, "a", () => {
      ist(wg.contentDOM.innerHTML, `<p><strong><img class="wg-buffer"></strong></p>`)
      let sel = window.getSelection()!
      ist(sel.getRangeAt(0).comparePoint(wg.contentDOM.firstChild!.firstChild!, 1), -1)
      return selEnd(wg.contentDOM.firstChild!.appendChild(document.createTextNode("a")))
    }], [2, 2, "b"], [3, 3, "c"])
    ist(wg.contentDOM.innerHTML, "<p><strong>abc</strong></p>")
    ist(wg.state.doc, doc(p(strong("abc"))), eq)
  })

  // FIXME text composition next to widgets

  // FIXME test enter-at-end-of-selection situation (especially on Android)
})
