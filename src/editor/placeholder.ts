import {GardState} from "wordgard/state"
import {Decoration, Widget} from "./decoration"

const placeholderWidget = Widget.define<() => Element | Text>({
  render(value) {
    let elt = document.createElement("wg-placeholder")
    elt.appendChild(value())
    return elt
  }
})

const placeholderShape = GardState.Facet.define<() => Element | Text>()

function showPlaceholder(state: GardState): Decoration.Point.Set {
  let pos = -1
  if (state.doc.length == 0) pos = 0
  else if (state.doc.length == 2 && state.doc.firstChild!.isPlot) pos = 1
  else return Decoration.Point.none
  let shape = state.facet(placeholderShape)
  if (!shape.length) return Decoration.Point.none
  return Decoration.Point.set([[pos, Decoration.Point.widget(placeholderWidget.of(shape[0]), {side: 1})]])
}

const placeholderField = GardState.Field.define<Decoration.Point.Set>({
  create(state) {
    return showPlaceholder(state)
  },
  update(deco, tr) {
    return !tr.docChanged ? deco : showPlaceholder(tr.state)
  },
  provide: f => Decoration.Point.source.of(s => s.field(f))
})
  
/// Extension that enables a placeholder—a piece of example content
/// to show when the editor is empty.
export function placeholder(content: string | (() => Element)): GardState.Extension {
  return [
    placeholderShape.of(typeof content == "string" ? () => document.createTextNode(content) : content),
    placeholderField
  ]
}
