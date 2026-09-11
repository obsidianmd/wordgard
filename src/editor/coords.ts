import {textRange, singleRect} from "./dom"
import {ltrAt, WidgetTile, TextTile, Tile} from "./tile"
import {Wordgard} from "./editor"

export class Coords {
  constructor(readonly ref: Tile, readonly rect: DOMRect) {}
}

// Given a position in the document model, get a bounding box of the
// character at that position, relative to the window.
export function coordsAtPos(wg: Wordgard, pos: number, assoc: -1 | 1): Coords {
  let {offset, tile, pos: tilePos} = wg.docTile.resolve(pos, assoc)

  if (tile instanceof TextTile) {
    let from = offset, to = offset
    let side: -1 | 1 = from == 0 ? -1 : from == tile.length ? 1 : -assoc as -1 | 1
    if (side < 0) to++
    else from--
    return new Coords(tile, flattenV(singleRect(textRange(tile.dom, from, to), side, true),
                                     (side < 0) == ltrAt(wg.state, pos, assoc)))
  }

  let tagTile = tile
  while (!tagTile.node) tagTile = tagTile.parent!
  // Return a horizontal line in block context
  let horizontal = tagTile.node.isPlot && tagTile.node.type.orientation == "column"

  if (tile instanceof WidgetTile) {
    let after = pos > tilePos + tile.length / 2
    if (tile.widget.type.inFlow) {
      let rect = singleRect(tile.dom, after ? 1 : -1)
      if (rect.width || rect.height)
        return new Coords(tile, horizontal ? flattenH(rect, !after) : flattenV(rect, ltrAt(wg.state, pos, 1) == !after))
    }
    if (!tile.parent) return new Coords(tile, new DOMRect)
    offset = tile.parent.children.indexOf(tile) + (after ? 1 : 0)
    tile = tile.parent
    assoc = after ? 1 : -1
  }

  // Scan through nearby nodes for a suitable target
  for (let pass = 0; pass < 2; pass++) {
    if (pass == (assoc < 0 ? 0 : 1)) { // Scan back
      for (let i = offset; i > 0; i--) {
        let before = tile.children[i - 1]
        if (before instanceof WidgetTile && !before.widget.type.inFlow) continue
        if (before.dom.nodeName == "BR") break
        let rect = singleRect(before.dom, 1)
        if (rect.width || rect.height)
          return new Coords(before, horizontal ? flattenH(rect, false) : flattenV(rect, !ltrAt(wg.state, pos, 1)))
      }
    } else { // Scan forward
      for (let i = offset; i < tile.children.length; i++) {
        let after = tile.children[i]
        if (after instanceof WidgetTile && !after.widget.type.inFlow) continue
        let rect = singleRect(after.dom, -1)
        if (rect.width || rect.height)
          return new Coords(after, horizontal ? flattenH(rect, true) : flattenV(rect, ltrAt(wg.state, pos, 1)))
      }
    }
  }
  // All else failed, just try to get a rectangle for the target node
  let rect = singleRect(tile.dom, -assoc as -1 | 1)
  return new Coords(tile, horizontal ? flattenH(rect, assoc < 0) : flattenV(rect, assoc < 0))
}

function flattenV(rect: DOMRect, left: boolean) {
  return rect.width ? new DOMRect(left ? rect.left : rect.right, rect.top, 0, rect.height) : rect
}

function flattenH(rect: DOMRect, top: boolean) {
  return rect.height ? new DOMRect(rect.left, top ? rect.top : rect.bottom, rect.width, 0) : rect
}
