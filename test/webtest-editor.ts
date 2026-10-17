import {Wordgard, Widget, Decoration} from "wordgard/editor"
import {Transaction} from "wordgard/state"
import {Leaf} from "wordgard/doc"
import {Image} from "wordgard/types"
import {basicBuilders, eq} from "./schema.ts"
import ist from "ist"
import {tempEditor} from "./tempview.ts"

const {doc, p, img, hr} = basicBuilders

describe("Wordgard", () => {
  it("calls update on plugins", () => {
    let updates = 0
    let plugin = Wordgard.Plugin.define(wg => {
      let prevDoc = wg.state.doc
      return {
        update(update: Wordgard.Update) {
          ist(update.startState.doc, prevDoc)
          ist(update.state.doc, wg.state.doc)
          prevDoc = update.state.doc
          updates++
        }
      }
    })
    let wg = tempEditor(doc(p("xyz")), [plugin])
    ist(updates, 0)
    wg.dispatch({changes: {from: 2, to: 3, insert: [Leaf.text("u")]}})
    wg.flush()
    ist(updates, 1)
    wg.dispatch({selection: {anchor: 3}})
    wg.flush()
    ist(updates, 2)
  })

  it("allows content attributes to be changed through extensions", () => {
    let wg = tempEditor(doc(p()), [Wordgard.contentAttributes.of({"aria-label": "test"})])
    ist(wg.contentDOM.getAttribute("aria-label"), "test")
  })

  it("allows editor attributes to be changed through extensions", () => {
    let wg = tempEditor(doc(p()), [Wordgard.editorAttributes.of({class: "something"})])
    ist(wg.dom.classList.contains("something"))
  })

  it("repairs changes to text nodes", () => {
    let wg = tempEditor(doc(p("abc")))
    wg.contentDOM.firstChild!.firstChild!.nodeValue = "a"
    wg.flush()
    ist(wg.contentDOM.innerHTML, "<p>abc</p>")
  })

  it("repairs modified attributes", () => {
    let wg = tempEditor(doc(p("abc")))
    ;(wg.contentDOM.firstChild as HTMLElement).setAttribute("test", "test")
    wg.flush()
    ist(wg.contentDOM.innerHTML, "<p>abc</p>")
  })

  it("disallows dispatches from plugin update", () => {
    let wg = tempEditor(doc(p("x")), Wordgard.Plugin.fromClass(class {
      update(u: Wordgard.Update) {
        if (u.state.doc.length == 4) ist.throws(() => {
          wg.dispatch({changes: {from: 1, to: 2}})
        }, /Cannot dispatch new updates/)
      }
    }))
    wg.dispatch({changes: {from: 2, insert: [Leaf.text("y")]}})
    wg.flush()
  })

  it("automatically flushes on DOM access", () => {
    let wg = tempEditor(doc(p("abc")))
    let c1 = wg.coordsAtPos(4)
    wg.dispatch({changes: {from: 0, insert: [p()]}})
    let c2 = wg.coordsAtPos(4)
    ist(c2.top, c1.top, ">")
  })

  it("applies transaction appenders", () => {
    let wg = tempEditor(doc(p()), Transaction.appender.of((trs, state) => {
      return state.doc.length >= 5 ? {changes: {from: 5, to: state.doc.length, fit: true}} : null
    }))
    wg.dispatch({changes: {from: 1, insert: [Leaf.text("more content")]}})
    ist(wg.state.doc, doc(p("more")), eq)
  })

  it("calls connect/disconnect on widgets", () => {
    let log: string[] = []
    const trackedWidget = Widget.define<string>({
      render(v) { let s = document.createElement("span"); s.textContent = v; return s },
      connect(v) { log.push("connect " + v) },
      disconnect(v) { log.push("disconnect " + v) }
    })
    const imgWidget = Decoration.Tag.shape(Image, t => trackedWidget.of(t.param))

    let wg = tempEditor(doc(p("ab", img("a"), "cd")), imgWidget)
    ist(log.join("/"), "connect a")
    let parent = wg.dom.parentNode!
    parent.removeChild(wg.dom)
    parent.appendChild(wg.dom)
    ist(log.join("/"), "connect a/disconnect a/connect a")
    log.length = 0
    wg.dispatch({changes: {from: 3, to: 4, insert: [img("b")]}})
    wg.flush()
    ist(log.join("/"), "disconnect a/connect b")
    wg.dispatch({changes: {from: wg.state.doc.length, insert: [p("!", img("c"))]}})
    wg.flush()
    ist(log.join("/"), "disconnect a/connect b/connect c")
    wg.dispatch({changes: {from: 0, to: wg.state.doc.length, insert: [hr]}})
    wg.flush()
    ist(log.join("/"), "disconnect a/connect b/connect c/disconnect b/disconnect c")
  })

  it("fires an update with a geometryChanged flag when styling changes content height", () => {
    let geoChanges = 0
    let wg = tempEditor(doc(p("a"), p("b")), [
      Wordgard.theme({"body.c1 & p": { margin: "50px" }}),
      Wordgard.updateListener.of(u => { if (u.geometryChanged) geoChanges++ })
    ])
    wg.flush()
    ist(geoChanges, 0)
    document.body.classList.add("c1")
    wg.flush()
    document.body.classList.remove("c1")
    ist(geoChanges, 1)
  })
})
