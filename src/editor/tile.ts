import {Node, Mark, Leaf, Elt, ChangeSet, Attributes} from "wordgard/doc"
import {GardState, TextblockMap, BidiSpan} from "wordgard/state"
import {findClusterBreak} from "@marijn/find-cluster-break"
import {Widget, DecoElt, Decoration, DecoIterator, findChangedRanges, WrapperSource,
        renderWrapper, renderMarkWrapper, DecoSet, getDecoSet} from "./decoration"
import {eqArray} from "./util"
import {textRange, singleRect, DOMNode, rmDOM} from "./dom"
import {type CompositionInfo} from "./input"
import {type Wordgard} from "./editor"

const LOG_update = false

export const enum TileFlag {
  None = 0,
  NodeInner = 1,
  PlotContent = 2,
  Spanning = 4,
  Wrapper = 8,
  Point = 16,
  PointBefore = 32,
  PointAfter = 64,
  PointSide = PointBefore | PointAfter,
  Composition = 128,
  Synced = 256, // Node has been synced. DOM content matches child list / text content, child array becomes read-only
  Atom = 512, // Composite tile whose length isn't determined by child length
  HasContent = 1024, // EltTile whose elt has a content hole
  AfterContent = 2048, // Tiles that sit after their parent's content position
  ContentNotLast = 4096, // EltTile that has children with AfterContent flag
  Dirty = 8192, // DOM change observed in this node, must not reuse
}

const enum Orientation { Row, Col }

export class CoordPos {
  constructor(readonly pos: number, readonly target: number | null, readonly side: -1 | 1, readonly vertOutside: boolean) {}
  map(mapping: ChangeSet) {
    let target = this.target == null ? null : mapping.mapPos(this.target, 1, "after")
    return new CoordPos(mapping.mapPos(this.pos), target, this.side, this.vertOutside)
  }
  static create(pos: number, side: -1 | 1, target: number | null = null, vertOutside = false) {
    return new CoordPos(pos, target, side, vertOutside)
  }
}

export class TilePos {
  constructor(
    readonly tile: Tile,
    readonly offset: number,
    readonly pos: number
  ) {}

  get dom() { return this.tile.dom }
}

// Nodes in the view tree are called tiles. We're already using "node"
// for too many things. I know tiles don't generally nest recursively,
// but these do.

export abstract class Tile {
  parent: CompositeTile | null = null
  abstract children: Tile[]
  length = 0
  flags: TileFlag

  constructor(public dom: Element | Text, flags: number) {
    this.flags = flags & ~TileFlag.Synced
    dom.wgTile = this
  }

  get isAtom() { return false }
  get isNodeOuter() { return false }
  get isNodeInner() { return (this.flags & TileFlag.NodeInner) > 0 }
  get isNode() { return this.isNodeOuter || (this.flags & TileFlag.NodeInner) > 0 }
  get isPlotContent() { return (this.flags & TileFlag.PlotContent) > 0 }
  get isText() { return false }
  get isDoc() { return false }
  get isWrapper() { return (this.flags & TileFlag.Wrapper) > 0 }
  get isSpanning() { return false }
  get isComposition() { return (this.flags & TileFlag.Composition) > 0 }
  get isPoint() { return (this.flags & TileFlag.Point) > 0 }
  get node(): Node | null { return null }

  posBeforeChild(child: Tile, ownStart = this.posAtStart): number {
    for (let i = 0, pos = ownStart;; i++) {
      let cur = this.children[i]
      if (cur == child) return pos
      pos += cur.length
    }
  }

  get posBefore() {
    return this.parent!.posBeforeChild(this)
  }

  get posAtStart() {
    return this.parent ? this.parent.posBeforeChild(this) + this.boundary : 0
  }

  get posAfter() {
    return this.posBefore + this.length
  }

  get posAtEnd() {
    return this.posAtStart + this.length - 2 * this.boundary
  }

  get boundary(): 0 | 1 { return 0 }

  get firstChild(): Tile | null {
    return this.children.length ? this.children[0] : null
  }

  get lastChild(): Tile | null {
    let last = this.children.length - 1
    return last < 0 ? null : this.children[last]
  }

  ignoreEvent(event: Event) { return false }

  get ignoreMutations() { return false }

  toString() { return this.dom.nodeName + (this.children.length ? `(${this.children})` : "") }

  sync() {}

  connect() {
    for (let ch of this.children) ch.connect()
  }

  disconnect(reused?: Map<Tile, Reused>) {
    if (!reused || reused.get(this) != Reused.Full)
      for (let ch of this.children) ch.disconnect(reused)
  }

  nearestNode() {
    let tile: Tile = this
    while (!tile.node) tile = tile.parent!
    return tile
  }

  posAtCoords(state: GardState, x: number, y: number): CoordPos {
    let nodeTile = this.nearestNode()
    return nodeTile.posAtCoordsInner(nodeTile.posAtStart, state, x, y, null, Orientation.Col)
  }

  abstract posAtCoordsInner(start: number, state: GardState, x: number, y: number, textblock: TextblockMap | null,
                            orientation: Orientation): CoordPos

  static get(node: DOMNode) { return node.wgTile }
}

export class CompositeTile extends Tile {
  children: Tile[] = []
  declare dom: Element

  addChild(child: Tile) {
    if (this.flags & TileFlag.Synced) throw new Error("Cannot add to a synced tile")
    if ((this.flags & TileFlag.ContentNotLast) && !(child.flags & TileFlag.AfterContent)) {
      let i = this.children.length
      while (i > 0 && (this.children[i - 1].flags & TileFlag.AfterContent)) i--
      this.children.splice(i, 0, child)
    } else {
      this.children.push(child)
    }
    child.parent = this
  }

  sync() {
    if (this.flags & TileFlag.Synced) return
    this.flags |= TileFlag.Synced
    let len = this.boundary * 2
    for (let ch of this.children) {
      ch.sync()
      len += ch.length
    }
    if (!(this.flags & TileFlag.Atom)) this.length = len
    this.syncChildren()
  }

  syncChildren() {
    let prev: DOMNode | null = null, next: ChildNode | null = this.dom.firstChild
    for (let child of this.children) {
      if (child.dom.parentNode == this.dom) {
        while (next && next != child.dom) next = rmDOM(next)
      } else {
        this.dom.insertBefore(child.dom, next)
      }
      prev = child.dom
      next = prev.nextSibling
    }
    while (next) next = rmDOM(next)
  }

  posAtCoordsInner(start: number, state: GardState, x: number, y: number, textblock: TextblockMap | null,
                   orientation: Orientation): CoordPos {
    let {node} = this, outerOrientation = orientation
    if (node && node.isPlot) {
      orientation = node.type.orientation == "row" ? Orientation.Row : Orientation.Col
      if (node.isTextblock) textblock = TextblockMap.get(state, start, node)
      else if (node.type.isBlock) textblock = null
    } else if (node && node.isText) {
      orientation = Orientation.Row
    }
    let result = this.isAtom || !this.children.length ? null
      : orientation == Orientation.Col ? this.posAtCoordsCol(start, state, x, y, textblock)
      : this.posAtCoordsRow(start, state, x, y, textblock)
    if (result) return result
    let rect = this.dom.getBoundingClientRect()
    let after = outerOrientation == Orientation.Row ? x > (rect.left + rect.right) / 2 : y > (rect.top + rect.bottom) / 2
    let target = this.node && this.node.type.isSelectable &&
      x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom ? start : null
    return CoordPos.create(start + (after ? this.length - 2 * this.boundary: 0), after ? -1 : 1, target)
  }

  // FIXME adopt the binary search trick from CodeMirror
  posAtCoordsRow(start: number, state: GardState, x: number, y: number, textblock: TextblockMap | null): CoordPos | null {
    let result = rowScan<Tile>(x, y, add => {
      for (let child of this.children) {
        if (child.isPoint) continue
        let rects, {dom} = child
        if (dom.nodeType == 1) rects = (dom as Element).getClientRects()
        else if (dom.nodeType == 3) rects = textRange(dom as Text, 0, dom.nodeValue!.length).getClientRects()
        else continue
        for (let i = 0; i < rects.length; i++) if (add(rects[i], child)) return
      }
    })
    if (!result) return null
    let {closest, rect} = result
    let pos = this.posBeforeChild(closest, start)
    return closest.posAtCoordsInner(pos + closest.boundary, state,
                                    x, Math.max(rect!.top, Math.min(rect!.bottom, y)),
                                    textblock, Orientation.Row)
  }

  posAtCoordsCol(
    start: number, state: GardState, x: number, y: number, textblock: TextblockMap | null
  ): CoordPos {
    let lastBot = -1
    for (let child of this.children) {
      if (child.isPoint || child.dom.nodeType != 1) continue
      let rect = (child.dom as Element).getBoundingClientRect()
      if (rect.top > y) return CoordPos.create(this.posBeforeChild(child, start), y > (lastBot + rect.top) / 2 ? 1 : -1)
      if (rect.bottom >= y) return child.posAtCoordsInner(this.posBeforeChild(child, start) + child.boundary, state,
                                                          x, y, textblock, Orientation.Col)
    }
    return CoordPos.create(start + this.length - 2 * this.boundary, -1)
  }
}

// Algorithm for posAtCoords in row-layout elements (textblocks, block
// containers with orientation=row, and text nodes). Locates the
// closest element to the coordinates, prioritizing y closeness, and
// organizing things that overlap vertically into rows.
function rowScan<T>(
  x: number, y: number, scan: (rect: (rect: DOMRect, value: T) => boolean) => void
): {closest: T, rect: DOMRect} | null {
  let closest: T | null = null, closestDx = 1e8, closestRect: DOMRect | null = null as any
  let above: DOMRect | null = null as any, below: DOMRect | null = null as any
  scan((rect: DOMRect, value: T) => {
    if (rect.bottom < y) {
      if (!above || above.bottom < rect.bottom) above = rect
    } else if (rect.top > y) {
      if (!below || below.top > rect.top) below = rect
    } else {
      let dx = rect.left > x ? rect.left - x : rect.right < x ? x - rect.right : 0
      if (dx < closestDx) {
        closest = value
        closestDx = dx
        closestRect = rect
        return !dx
      }
    }
    return false
  })

  if (closestRect) {
    if (closestDx) {
      if (above && above.bottom > closestRect.top) return rowScan(x, above.bottom - 1, scan)
      if (below && below.top < closestRect.bottom) return rowScan(x, below.top + 1, scan)
    }
    return {closest: closest!, rect: closestRect}
  }
  let side: DOMRect | null = above && (!below || (y - above.bottom < below.top - y)) ? above : below
  if (!side) return null
  return rowScan(x, (side.top + side.bottom) / 2, scan)
}

export function ltrAt(state: GardState, pos: number, assoc: -1 | 1, textblock?: TextblockMap | null) {
  if (textblock === undefined) {
    let {textblockParent: block} = state.doc.resolve(pos)
    textblock = block ? TextblockMap.get(state, block.start, block.node) : null
  }
  if (!textblock) return state.textLTR
  let found = BidiSpan.find(textblock.order, textblock.toIndex(pos), assoc)
  return textblock.order[found].ltr
}

export class DocTile extends CompositeTile {
  declare dom: Element

  constructor(
    readonly state: GardState,
    dom: Element,
    readonly cursorWrapper: Mark.Set | null,
    readonly decoSet: DecoSet
  ) {
    super(dom, TileFlag.PlotContent)
  }

  static create(state: GardState, dom: Element, wg: Wordgard) {
    return new DocTile(state, dom, null, {points: new Map, ranges: new Map})
      .updateRanges(state, getDecoSet(state), [0, state.doc.length], wg)
  }

  get isDoc() { return true }

  get node() { return this.state.doc }

  update(state: GardState, changes: ChangeSet.Sections, wg: Wordgard, composition?: CompositionInfo | null) {
    let decoSet = getDecoSet(state)
    let changed = findChangedRanges(this.state, this.decoSet, state, decoSet, changes)
    return this.updateRanges(state, decoSet, changed, wg, composition)
  }

  updateRanges(state: GardState, decoSet: DecoSet, sections: ChangeSet.Sections, wg: Wordgard,
               composition?: CompositionInfo | null) {
    let wrapper = composition?.wrapCursor || null
    if ((!sections.length || sections.length == 2 && sections[1] == -1) && eqArray(wrapper, this.cursorWrapper))
      return this
    LOG_update && console.log(`updateRanges(${state.doc},`, sections, ",", composition, ")")
    if (composition) {
      let separated = separateComposition(sections, composition)
      LOG_update && !separated && console.log("separateComposition failed")
      if (!separated) composition = null
      else sections = separated
    }
    let builder = new ContentUpdate(state, this, wg, new DecoIterator(state, decoSet), wrapper)
    for (let i = 0, posB = 0, startCovered = false; i < sections.length;) {
      let len = sections[i++], ins = sections[i++]
      LOG_update && console.log("section", len, ins, "new=" + builder.new, "old=" + builder.old.tile, "@", builder.old.index)
      if (composition && posB == composition.fromB && ins >= 0) {
        LOG_update && console.log("(composition)")
        if (!startCovered) builder.update(0, false)
        builder.composition(composition!, len)
        if (ins && (startCovered = i == sections.length || sections[i + 1] == -1)) builder.update(0, false)
      } else if (ins == -1) {
        builder.keep(len, !startCovered, i == sections.length)
        startCovered = false
      } else if (ins == -2) {
        builder.update(len, !startCovered)
        startCovered = true
      } else {
        builder.replace(len, ins, !startCovered)
        startCovered = true
      }
      posB += ins >= 0 ? ins : len
    }
    let result = builder.finish()
    result.sync()
    if (wg.connected) {
      for (let ch of this.children) ch.disconnect(builder.reused)
      for (let tile of builder.toConnect) tile.widget.type.connect!(tile.widget.value, tile.dom)
    }
    LOG_update && console.log("/updateRanges " + result + " : " + result.dom.innerHTML)
    return result
  }

  nearest(dom: DOMNode, requireNode = false) {
    for (let cur: DOMNode | null = dom; cur; cur = cur.parentNode) {
      let elt = cur.wgTile
      if (elt && (!requireNode || elt.node) && this.owns(elt)) return elt
    }
    return null
  }

  owns(elt: Tile) {
    for (;;) {
      if (elt == this) return true
      let {parent} = elt
      if (!parent) return false
      elt = parent
    }
  }

  nodeTile(pos: number) {
    let off = 0, parent: Tile = this
    search: for (;;) {
      for (let ch of parent.children) {
        let end = off + ch.length
        if (pos < end) {
          if (off == pos && ch.node || ch instanceof TextTile) return ch
          parent = ch
          off += ch.boundary
          continue search
        }
        off = end
      }
      return null
    }
  }

  resolve(pos: number, side: -1 | 1 = -1) {
    // First find the parent plot or wrapper that contains this position
    let parent: Tile = this, i = 0
    search: for (let scan: Tile = this, off = 0;;) {
      for (let j = 0; j < scan.children.length && off <= pos; j++) {
        let ch = scan.children[j], end = off + ch.length
        if (scan == parent) {
          if (off == pos) i = j
          else if (pos == end) i = j + 1
        }
        if (ch.isPlotContent && !ch.boundary ? pos >= off && pos <= end : pos > off && pos < end) {
          if (ch instanceof TextTile) return new TilePos(ch, pos - off, pos)
          else if (ch.isAtom) { i = j; break search }
          scan = ch
          off += ch.boundary
          if (ch.isPlotContent || ch.isWrapper) parent = ch
          continue search
        }
        off = end
      }
      break
    }


    // Then make sure we're on the right side of nearby point and
    // node-inner structure
    adjust: for (;;) {
      if (i) {
        let before = parent.children[i - 1], parentBefore = parent, beforeI = i - 1
        while (before.isWrapper) {
          parentBefore = before
          before = before.children[beforeI = before.children.length - 1]
        }
        if (before.isNodeInner && (before.flags & TileFlag.AfterContent) || (before.flags & TileFlag.PointAfter)) {
          parent = parentBefore
          i = beforeI
          continue adjust
        }
      }
      if (i < parent.children.length) {
        let after = parent.children[i], parentAfter = parent, afterI = i
        while (after.isWrapper) {
          parentAfter = after
          after = after.children[afterI = 0]
        }
        if (after.isNodeInner && !(after.flags & TileFlag.AfterContent) || (after.flags & TileFlag.PointBefore)) {
          parent = parentAfter
          i = afterI + 1
          continue adjust
        }
      }
      break
    }

    // Finally, skip side-less widgets and enter/leave wrappers or
    // text tiles at the given side
    if (side < 0) {
      while (!i && parent.isWrapper) {
        i = parent.parent!.children.indexOf(parent)
        parent = parent.parent!
      }
      while (i) {
        let before = parent.children[i - 1]
        if (before.isPoint && !(before.flags & TileFlag.PointSide) && !before.isNodeInner) {
          i--
        } else if (before.isWrapper) {
          parent = before
          i = parent.children.length
        } else {
          if (before instanceof TextTile) {
            parent = before
            i = parent.length
          }
          break
        }
      }
    } else {
      while (parent.isWrapper && i == parent.children.length) {
        i = parent.parent!.children.indexOf(parent) + 1
        parent = parent.parent!
      }
      while (i < parent.children.length) {
        let after = parent.children[i]
        if (after.isPoint && !(after.flags & TileFlag.PointSide) && !after.isNodeInner) {
          i++
        } else if (after.isWrapper) {
          parent = after
          i = 0
        } else {
          if (after instanceof TextTile) {
            parent = after
            i = 0
          }
          break
        }
      }
    }

    return new TilePos(parent, i, pos)
  }

  posFromDOM(dom: DOMNode, offset: number, bias: -1 | 1 = -1) {
    let elt = this.nearest(dom)
    if (!elt)
      return this.dom.compareDocumentPosition(dom) & 4 /* following */ ? this.length : 0
    if (elt.isText) return elt.posAtStart + Math.min(offset, elt.length)
    if (elt.isAtom) return elt.posAtStart + (bias > 0 ? elt.length : 0)

    let domBefore, eltBefore: Tile | undefined
    if (dom == elt.dom) {
      domBefore = dom.childNodes[offset - 1]
    } else {
      while (dom.parentNode != elt.dom) dom = dom.parentNode!
      domBefore = dom.previousSibling
    }
    while (domBefore && !((eltBefore = domBefore.wgTile) && eltBefore.parent == elt))
      domBefore = domBefore.previousSibling
    return domBefore ? elt.posBeforeChild(eltBefore!) + eltBefore!.length : elt.posAtStart
  }

  posBeforeDOM(dom: DOMNode) {
    let tile = this.nearest(dom)
    if (!tile) return null
    let pos = tile.posAtStart
    if (tile.dom != dom) for (let ch of tile.children) {
      if (ch.dom.compareDocumentPosition(dom) & 2 /* preceding */) break
      pos += ch.length
    }
    return pos
  }

  coordsForElement(pos: number): DOMRect | null {
    let tile = this.nodeTile(pos)
    if (!tile) return null
    if (tile instanceof TextTile) return textTileRect(tile, pos - tile.posBefore)
    return (tile.dom as Element).getBoundingClientRect()
  }
}

function textTileRect(tile: TextTile, offset: number) {
  return textRange(tile.dom, offset, findClusterBreak(tile.text, offset)).getBoundingClientRect()
}

export class EltTile extends CompositeTile {
  declare dom: Element
  declare parent: CompositeTile

  constructor(readonly elt: DecoElt, readonly _node: Node | null, flags: number, length: number, dom: Element) {
    super(dom, flags)
    this.length = length
  }

  get isSpanning() { return (this.flags & TileFlag.Spanning) > 0 }
  get isNodeOuter() { return !!this.node }
  get isAtom() { return !!this._node && (this.flags & TileFlag.Atom) > 0 }
  get boundary() { return this._node && !(this.flags & TileFlag.Atom) ? 1 : 0 }
  get node() { return this._node }

  get contentTile(): EltTile | null {
    if (!(this.flags & TileFlag.HasContent)) return null
    for (let ch of this.children) if (ch.isNodeInner && (ch.flags & TileFlag.HasContent)) return (ch as EltTile).contentTile
    return this
  }

  static of(elt: DecoElt, node: Node | null, flags: number, length: number, dom?: Element | null) {
    if (elt.hasContent) {
      flags |= TileFlag.HasContent
      if (elt.children.length > 1) {
        let zero = elt.children.indexOf(0)
        if (zero > -1 && zero < elt.children.length - 1) flags |= TileFlag.ContentNotLast
      }
    }
    return new EltTile(elt, node, flags, length, dom || elt.outerDOM())
  }
}

export class WidgetTile extends Tile {
  constructor(
    readonly widget: Widget<any>,
    readonly _node: Node | null,
    flags: TileFlag,
    dom: Element | Text,
    length: number = 0
  ) {
    super(dom, flags)
    this.length = length
    if (dom.nodeType == 1 && !widget.type.editable && (dom as HTMLElement).contentEditable == "inherit")
      (dom as HTMLElement).contentEditable = "false"
  }

  get isNodeOuter() { return !!this._node }
  get isAtom() { return true }
  get node() { return this._node }

  get children() { return noChildren }

  ignoreEvent(event: Event) { return !this.widget.type.propagateEvent(event) }

  connect() {
    this.widget.type.connect?.(this.widget.value, this.dom)
  }

  disconnect(reused?: Map<Tile, Reused>) {
    if (!reused || reused.get(this) != Reused.Full)
      this.widget.type.disconnect?.(this.widget.value, this.dom)
  }

  toString() {
    return this.widget.type == Widget.EditableText || this.widget.type == Widget.Text
      ? JSON.stringify(this.widget.value) : super.toString()
  }

  posAtCoordsInner(start: number, state: GardState, x: number, y: number,
                   textblock: TextblockMap | null, orientation: Orientation): CoordPos {
    if (!this.node) return CoordPos.create(start, 1)
    let rect = this.dom.nodeType == 1 ? (this.dom as Element).getBoundingClientRect()
      : textRange(this.dom as Text, 0, this.length).getBoundingClientRect()
    let after = orientation == Orientation.Col ? y > (rect.top + rect.bottom) / 2
      : (x < (rect.left + rect.right) / 2) == ltrAt(state, start, 1, textblock)
    return after ? CoordPos.create(start + this.length - 2 * this.boundary, -1, start) : CoordPos.create(start, 1, start)
  }
}

export class TextTile extends Tile {
  declare dom: Text

  constructor(public text: string, dom: Text, flags: TileFlag = TileFlag.None) {
    super(dom, flags)
    this.length = text.length
  }

  get children() { return noChildren }

  get isText() { return true }
  get isNodeOuter() { return true }
  get isAtom() { return true }

  sync() {
    if (this.flags & TileFlag.Synced) return
    this.flags |= TileFlag.Synced
    if (this.dom.nodeValue != this.text) this.dom.nodeValue = this.text
  }

  toString() { return JSON.stringify(this.text) }

  posAtCoordsInner(start: number, state: GardState, x: number, y: number,
                   textblock: TextblockMap | null, orientation: Orientation): CoordPos {
    let {closest, rect} = rowScan<number>(x, y, add => {
      for (let i = 0; i < this.length;) {
        let end = findClusterBreak(this.text, i)
        let rect = singleRect(textRange(this.dom, i, end), 1, true)
        if (rect.top == rect.bottom) continue
        if (add(rect, i)) break
        i = end
      }
    })!
    let pos = start + closest
    let after = (x > (rect.left + rect.right) / 2) == ltrAt(state, pos, 1, textblock)
    if (after) return CoordPos.create(start + findClusterBreak(this.text, closest), -1)
    else return CoordPos.create(pos, 1)
  }

  static of(text: string) {
    return new TextTile(text, document.createTextNode(text))
  }
}

const noChildren: Tile[] = []

interface TileWalker {
  enter(tile: EltTile): void
  skip(tile: Tile, from: number, to: number): void
  leave(tile: EltTile): void
}

// Used to track the previous tree during an update.
class TilePointer {
  // In most tiles, index is a child position. In text nodes, it is a
  // character offset, and in atoms (with length > 1), a position
  // offset.
  constructor(readonly tile: Tile, readonly index: number, readonly parent: TilePointer | null) {}

  walk(dist: number, side: -1 | 1, walker?: TileWalker) {
    let {tile, index, parent} = this, nodeBoundary = 0 // 1=entering, 2=leaving
    for (;;) {
      if (!dist && side < 0 && !nodeBoundary) break
      if (tile.isAtom) {
        if (!dist) break
        nodeBoundary = 0
        let left = tile.length - index
        if (dist >= left) {
          dist -= left
          if (left && walker) walker.skip(tile, index, tile.length)
          ;({tile, index, parent} = parent!)
          index++
        } else {
          if (walker) walker.skip(tile, index, index + dist)
          index += dist
          dist = 0
        }
      } else if (index == tile.children.length) {
        if (!dist && (tile.isDoc || nodeBoundary != 2 && tile.isNode)) break
        if (walker) walker.leave(tile as EltTile)
        nodeBoundary = tile.isNodeInner ? 2 : 0
        dist -= tile.boundary
        ;({tile, index, parent} = parent!)
        index++
      } else {
        let next = tile.children[index]
        if (nodeBoundary == 1 && !next.isNodeInner) {
          nodeBoundary = 0
          if (side < 0 && !dist) break
        }
        if (!dist && next.isNodeInner && !nodeBoundary) break
        if (next.length <= dist) {
          if (walker) walker.skip(next, 0, next.length)
          dist -= next.length
          index++
          if (!next.isNodeInner) nodeBoundary = 0
        } else {
          if (next.isNodeOuter && !dist) break
          if (walker && !next.isAtom) walker.enter(next as EltTile)
          dist -= next.boundary
          parent = tile == this.tile && index == this.index ? this : new TilePointer(tile, index, parent)
          tile = next
          index = 0
          nodeBoundary = next.isNode ? 1 : 0
        }
      }
    }
    return tile == this.tile && index == this.index ? this : new TilePointer(tile, index, parent)
  }

  tileAfter() {
    let {tile, index} = this
    if (tile.isText) return tile
    return index < tile.children.length ? tile.children[index] : null
  }

  matchingWrapper(elt: DecoElt, spanning: boolean, reused: Map<Tile, Reused>) {
    let best: EltTile | undefined, bestScore = 0
    let start = this.tile.isText ? this.parent! : this
    for (let {tile, parent} = start; !(tile.isNode || tile.isDoc); {tile, parent} = parent!) {
      let wrap = tile as EltTile
      if (reused.has(wrap) || wrap.elt.tagName != elt.tagName || wrap.isSpanning != spanning) continue
      let score = Attributes.compare(wrap.elt.attrs, elt.attrs)
      if (!best || bestScore < score) {
        best = wrap
        bestScore = score
      }
    }
    if (!best) return null
    if (bestScore < 0) updateAttributes(best.dom, best.elt.attrs, elt.attrs)
    reused.set(best, Reused.DOM)
    return best.dom
  }

  matchingWidget(widget: Widget<any>, sideFlag: number, reused: Map<Tile, Reused>) {
    let {index, tile, parent} = this
    for (;;) {
      if (!index) {
        if (!parent || (tile instanceof EltTile ? tile.node : !(tile instanceof TextTile))) break
        ;({index, tile, parent} = parent)
      } else {
        if (tile instanceof TextTile) break
        let before = tile.children[--index]
        if (!before.isPoint) break
        if (!reused.has(before) && before instanceof WidgetTile && before.widget.eq(widget) &&
            (before.flags & TileFlag.PointSide) == sideFlag && !(before.flags & TileFlag.Dirty)) {
          reused.set(before, Reused.Full)
          return before
        }
      }
    }
    return null
  }
}

const enum Reused { Full = 1, DOM = 2 }

class ContentUpdate {
  old: TilePointer
  new: CompositeTile
  // Current position in the new document
  posB = 0
  reused = new Map<Tile, Reused>()
  keepWalker: TileWalker
  toConnect: WidgetTile[] = []
  partialNode: {node: Node, shape: Decoration.Shape, wrappers: number, reuse: Tile | null} | null = null

  constructor(
    readonly state: GardState,
    old: DocTile,
    readonly wg: Wordgard,
    readonly deco: DecoIterator,
    cursorWrapper: Mark.Set | null
  ) {
    this.old = new TilePointer(old, 0, null)
    this.new = new DocTile(state, old.dom as Element, cursorWrapper, deco.decoSet)
    this.keepWalker = {
      enter: tile => {
        let span = tile.isSpanning && this.enterSpanning(tile.elt)
        if (span) {
          this.new = span
        } else {
          this.reused.set(tile, Reused.DOM)
          let inner = EltTile.of(tile.elt, tile.node, tile.flags, tile.boundary * 2, tile.dom)
          this.new.addChild(inner)
          this.new = inner
        }
      },
      leave: tile => {
        if (tile.isWrapper) {
          for (let scan = this.new, i = 0;;) {
            if (!scan.isWrapper) break
            if ((scan as EltTile).elt.eq(tile.elt) && scan.isSpanning == tile.isSpanning) {
              for (let j = 0; j <= i; j++) this.up()
              break
            }
            if (!scan.parent) break
            scan = scan.parent
          }
        } else if (tile.isNodeOuter) {
          this.leaveNode()
          this.leaveWrappers()
        }
      },
      skip: (tile, from, to) => {
        if (!(tile instanceof TextTile)) {
          if (!from && to == tile.length) {
            this.reused.set(tile, Reused.Full)
            this.new.addChild(tile)
          } else if (from == 0) {
            let wrappers = 0
            for (let w: Tile | null = this.new; w && w.isWrapper; w = w.parent) wrappers++
            let shape = tile instanceof EltTile ? tile.elt : tile instanceof WidgetTile ? tile.widget : null
            if (!shape || !tile.node) throw new Error("Unexpected atom tile")
            this.partialNode = {node: tile.node, reuse: tile, shape, wrappers}
          } else {
            if (!this.partialNode) throw new Error("Missing partial node")
            if (to == tile.length) {
              let {node, shape, reuse} = this.partialNode
              this.partialNode = null
              this.new.addChild(this.buildNodeShape(node, shape, reuse))
            }
          }
        } else if (this.new.lastChild instanceof TextTile && !this.new.lastChild.isComposition) {
          this.addText(tile.text.slice(from, to))
        } else if (!from && to == tile.text.length && !(tile.flags & TileFlag.Dirty) && !this.reused.has(tile)) {
          this.reused.set(tile, Reused.Full)
          this.new.addChild(tile)
        } else if (!this.reused.has(tile)) {
          this.reused.set(tile, Reused.DOM)
          this.new.addChild(new TextTile(tile.text.slice(from, to), tile.dom))
        } else {
          this.new.addChild(TextTile.of(tile.text.slice(from, to)))
        }
      }
    }
  }

  keep(len: number, includeStart: boolean, includeEnd: boolean) {
    let cut: number[] = [], end = this.posB + len
    // Compare this.old and this.new to find node tiles whose tag
    // changed and who have end widgets and whose end is inside the
    // kept range.
    if (this.deco.endWidgets) for (let nw: CompositeTile = this.new, {tile, index, parent} = this.old, pos = this.posB; pos < end;) {
      if (tile instanceof TextTile) {
        pos += tile.length - index
        ;({tile, index, parent} = parent!)
        index++
      } else if (index < tile.children.length) {
        pos += tile.children[index].length
        index++
      } else {
        if (tile.node) {
          while (!nw.node && nw.parent) nw = nw.parent
          if (!nw.parent) break
          if (!nw.node!.tag.eq(tile.node.tag) &&
              (this.deco.hasEndWidget(tile.node.type) || this.deco.hasEndWidget(nw.node!.type)))
            cut.push(pos)
          nw = nw.parent
          if (!nw) break
          pos++
        }
        if (!parent) break
        ;({tile, index, parent} = parent)
        index++
      }
    }
    // Split the kept range at such points, emitting update calls for
    // them, so that the widgets can be redrawn.
    for (let i = cut.length; i;) {
      let from = cut[--i], to = Math.min(from + 1, includeEnd ? end : end - 1)
      while (i && cut[i - 1] == from - 1) { from--; i-- }
      if (from > this.posB) this.keepInner(from - this.posB, includeStart, false)
      this.update(to - from, true)
      includeStart = false
      len = end - to
    }
    if (len) this.keepInner(len, includeStart, includeEnd)
  }

  keepInner(len: number, includeStart: boolean, includeEnd: boolean) {
    if (!includeStart) {
      this.old = this.old.walk(0, 1)
      this.openOldWrappers()
    }
    this.old = this.old.walk(len, includeEnd ? 1 : -1, this.keepWalker)
    this.posB += len
  }

  replace(len: number, ins: number, includeStart: boolean) {
    let start = this.old.walk(0, 1), end = this.old = start.walk(len, 1)
    this.build(ins, false, includeStart, start, end)
  }

  update(len: number, includeStart: boolean) {
    this.old = this.old.walk(0, 1)
    this.build(len, true, includeStart)
  }

  composition(composition: CompositionInfo, lenA: number) {
    this.leaveWrappers()
    if (!composition.target) {
      for (let mark of composition.wrapCursor!) if (mark.type.element) {
        this.openWrapper(renderMarkWrapper(mark), mark.spanning, false)
      }
      this.new.addChild(new WidgetTile(imgHack, null, TileFlag.Point | TileFlag.PointBefore, imgHack.render(this.wg)))
      return
    }
    let found: EltTile[] = []
    for (let parent = composition.target.parentNode; parent; parent = parent.parentNode) {
      let tile = parent.wgTile
      if (!tile) {
        let elt = Elt.create(parent.nodeName.toLowerCase(), takeAttributes(parent as Element), Elt.hole)
        tile = new EltTile(elt, null, 0, 0, parent as Element)
      } else if (tile.isNode || tile.isDoc) {
        break
      }
      found.push(tile as EltTile)
    }
    for (let i = found.length - 1; i >= 0; i--) {
      let tile = found[i]
      if (tile.isSpanning && this.enterSpanning(tile.elt)) {
      } else {
        if (tile.isSpanning && this.reused.has(tile)) {
          let owner = tile.dom.wgTile
          if (owner && owner != tile) owner.dom = (owner as EltTile).elt.outerDOM()
        } else {
          this.reused.set(tile, Reused.DOM)
        }
        tile = EltTile.of(tile.elt, null, tile.flags, 0, tile.dom)
        this.new.addChild(tile)
        this.new = tile
      }
    }
    this.new.addChild(new TextTile(composition.text, composition.target, TileFlag.Composition))
    this.old = this.old.walk(lenA, 1)
    this.posB += composition.text.length
  }

  build(len: number, reuse: boolean, includeStart: boolean, startOld?: TilePointer, endOld?: TilePointer) {
    this.leaveWrappers()
    let start = this.posB, end = this.posB + len
    this.deco.walk(start, includeStart, end, {
      enter: (node, elt, wrappers) => {
        this.openWrappers(wrappers, reuse)
        let tile = this.buildNodeShape(node, elt, reuse ? this.old.tileAfter() : null) as EltTile
        this.new.addChild(tile)
        this.new = tile.contentTile!
        if (!this.new) throw new Error("Non-atom node rendered without hole")
        if (reuse) this.old = this.old.walk(1, 1)
        this.posB++
      },
      leave: () => {
        this.leaveNode()
        if (reuse) this.old = this.old.walk(1, 1)
        this.posB++
      },
      node: (node, shape, wrappers, partial) => {
        this.openWrappers(wrappers, reuse)
        let wrapCount = wrappers.length
        if (node.is(Leaf.Text)) {
          while (shape instanceof Elt) {
            this.openWrapper(Elt.create(shape.tagName, shape.attrs, Elt.hole), true, reuse)
            wrapCount++
            shape = shape.children[0] as Decoration.Shape
          }
          let next = (reuse || this.posB == start) && !(this.new.lastChild instanceof TextTile) && this.old.tileAfter()
          if (!(next instanceof TextTile) || this.reused.has(next)) {
            this.addText(node.param)
          } else if (next.text == node.param && !(next.flags & TileFlag.Dirty)) {
            this.reused.set(next, Reused.Full)
            this.new.addChild(next)
          } else {
            this.reused.set(next, Reused.DOM)
            this.new.addChild(new TextTile(node.param, next.dom))
          }
        } else if (partial != null) {
          this.partialNode = {node, shape, wrappers: wrapCount, reuse: reuse ? this.old.tileAfter() : null}
          if (reuse) this.old = this.old.walk(partial, 1)
          this.posB += partial
          return
        } else {
          this.new.addChild(this.buildNodeShape(node, shape, reuse ? this.old.tileAfter() : null))
        }
        for (let i = 0; i < wrapCount; i++) this.up()
        if (reuse) this.old = this.old.walk(node.length, 1)
        this.posB += node.length
      },
      nodePart: (node, length, done) => {
        if (!this.partialNode) throw new Error("Continuing unknown partial node")
        this.posB += length
        this.partialNode.node = node
        if (reuse) this.old = this.old.walk(length, 1)
        if (done) {
          let {node, shape, wrappers, reuse} = this.partialNode
          this.partialNode = null
          this.new.addChild(this.buildNodeShape(node, shape, reuse))
          for (let i = 0; i < wrappers; i++) this.up()
        }
      },
      widget: (widget, side) => {
        let sideFlag = side < 0 ? TileFlag.PointBefore : side > 0 ? TileFlag.PointAfter : 0
        let tile = reuse ? this.old.matchingWidget(widget, sideFlag, this.reused)
          : startOld && this.posB == start ? startOld.matchingWidget(widget, sideFlag, this.reused)
          : endOld && this.posB == end ? endOld.matchingWidget(widget, sideFlag, this.reused)
          : null
        if (!tile) {
          tile = new WidgetTile(widget, null, TileFlag.Point | sideFlag, widget.render(this.wg))
          if (widget.type.connect) this.toConnect.push(tile)
        }
        this.new.addChild(tile)
      }
    })
  }

  findReusableTile(shape: Decoration.Shape, reuse: Tile | readonly Tile[] | null, strict: boolean): Tile | null {
    if (reuse instanceof EltTile) {
      if (shape instanceof Elt && reuse.elt.tagName == shape.tagName && !this.reused.has(reuse) &&
          (!strict || Attributes.eq(reuse.elt.attrs, shape.attrs)))
        return reuse
      for (let ch of reuse.children) if (ch instanceof EltTile && ch.isNodeInner) {
        let found = this.findReusableTile(shape, ch, strict)
        if (found) return found
      }
      return this.findReusableTile(shape, reuse.children, strict)
    } else if (reuse instanceof WidgetTile && shape instanceof Widget &&
               !this.reused.has(reuse) && shape.eq(reuse.widget)) {
      return reuse
    } else if (Array.isArray(reuse)) {
      for (let tile of reuse) if (tile.isNodeInner) {
        let found = this.findReusableTile(shape, tile, strict)
        if (found) return found
      }
    }
    return null
  }

  // node will be null when building inner structure
  buildNodeShape(node: Node | null, shape: Decoration.Shape, reuse: Tile | readonly Tile[] | null, afterContent = TileFlag.None) {
    if (shape instanceof Elt) {
      if (node && !shape.hasContent && Attributes.get(shape.attrs, "contenteditable") == null &&
          !/^(br|hr|img|input|wbr)$/i.test(shape.tagName))
        shape = Elt.create(shape.tagName, Attributes.merge(shape.attrs, ["contenteditable", "false"]), shape.children)
      let reusable, dom: Element | undefined, strict = true
      if (reusable = this.findReusableTile(shape, reuse, strict) || this.findReusableTile(shape, reuse, strict = false)) {
        this.reused.set(reusable, Reused.DOM)
        dom = reusable.dom as Element
        if (reusable.flags & TileFlag.Dirty)
          updateAttributes(dom, takeAttributes(reusable.dom as Element), shape.attrs)
        else if (!strict)
          updateAttributes(dom, (reusable as EltTile).elt.attrs, shape.attrs)
      }
      let flags = (node ? (shape.hasContent ? TileFlag.None : TileFlag.Atom)
        : TileFlag.NodeInner | (shape.hasContent ? TileFlag.None : TileFlag.Point)) | afterContent
      let tile = EltTile.of(shape, node, flags, node ? node.length : 0, dom)
      let afterContentInner = TileFlag.None
      for (let ch of shape.children) {
        if (ch === 0) {
          afterContentInner = TileFlag.AfterContent
          tile.flags |= TileFlag.PlotContent
        } else {
          tile.addChild(this.buildNodeShape(null, typeof ch == "string" ? Widget.Text.of(ch) : ch,
                                            reusable ? reusable.children : reuse, afterContentInner))
        }
      }
      return tile
    } else {
      let reusable, dom: Element | Text | undefined
      if (reusable = this.findReusableTile(shape, reuse, false)) {
        this.reused.set(reusable, Reused.DOM)
        dom = reusable.dom
      }
      let flags = (node ? TileFlag.Atom : TileFlag.Point | TileFlag.NodeInner) | afterContent
      let tile = new WidgetTile(shape, node, flags, dom || shape.render(this.wg), node ? node.length : 0)
      if (shape.type.connect) this.toConnect.push(tile)
      return tile
    }
  }

  ensureHackNode() {
    let tile = this.new
    if (!tile.isPlotContent) return
    while (tile.isNodeInner) tile = tile.parent!
    let node = tile.node
    if (!node || !node.isPlot || !(node.isTextblock || node.type.isInline)) return

    // Empty inline plots get an image node
    if (node.type.isInline) {
      if (!this.new.children.length)
        this.new.addChild(new WidgetTile(imgHack, null, TileFlag.Point | TileFlag.PointAfter, imgHack.render(this.wg)))
      return
    }

    // Textblocks get a trailing <br> if necessary
    let hasHack = -1, needsHack = true
    for (let parent = this.new, i = parent.children.length;;) {
      if (i > 0) {
        let next = parent.children[--i]
        if (next.isNodeInner || next instanceof WidgetTile && !next.widget.type.inFlow) {
        } else if (next instanceof WidgetTile && next.widget == brHack && parent == this.new) {
          hasHack = i
        } else if (next.dom.nodeName == "BR" || next instanceof TextTile && /\n$/.test(next.text)) {
          break
        } else if (next instanceof CompositeTile && !next.isAtom) {
          parent = next
          i = parent.children.length
        } else {
          needsHack = false
          break
        }
      } else if (parent == this.new) {
        break
      } else {
        i = parent.parent!.children.indexOf(parent)
        parent = parent.parent!
      }
    }

    if (hasHack > -1) {
      if (!needsHack) this.new.children.splice(hasHack, 1)
    } else if (needsHack) {
      this.new.addChild(new WidgetTile(brHack, null, TileFlag.Point | TileFlag.PointAfter, brHack.render(this.wg)))
    }
  }

  up() {
    this.ensureHackNode()
    this.new = this.new.parent!
  }

  leaveNode() {
    for (let inNode = true;;) {
      if (!inNode && (this.new.isNode || this.new.isDoc)) break
      if (inNode && this.new.isNodeOuter) inNode = false
      this.up()
    }
  }

  leaveWrappers() {
    while (!(this.new.isNode || this.new.isDoc)) this.up()
  }

  openWrappers(wrappers: readonly WrapperSource[], reuse: boolean) {
    for (let src of wrappers) {
      this.openWrapper(renderWrapper(src), src.spanning, reuse)
    }
  }

  openOldWrappers() {
    let found: EltTile[] | undefined
    let start = this.old.tile.isText ? this.old.parent! : this.old
    for (let {tile, parent} = start; !tile.isNode && !tile.isDoc; {tile, parent} = parent!) {
      ;(found || (found = [])).push(tile as EltTile)
    }
    if (found) for (let i = found.length - 1; i >= 0; i--) {
      this.openWrapper(found[i].elt, found[i].isSpanning, true)
    }
  }

  openWrapper(elt: DecoElt, spanning: boolean, reuse: boolean) {
    let span = spanning && this.enterSpanning(elt)
    if (span) {
      this.new = span
    } else {
      let match = reuse ? this.old.matchingWrapper(elt, spanning, this.reused) : null
      let tile = EltTile.of(elt, null, TileFlag.Wrapper | (spanning ? TileFlag.Spanning : 0), 0, match)
      this.new.addChild(tile)
      this.new = tile
    }
  }

  enterSpanning(elt: DecoElt) {
    let cur = this.new
    for (let i = cur.children.length - 1; i >= 0; i--) {
      let prev = cur.children[i] as EltTile
      if (prev.isPoint) continue
      if (!prev.isSpanning || !prev.elt.eq(elt)) break
      // If this is a node from the old tree, copy it
      if (prev.flags & TileFlag.Synced) {
        let copy = cur.children[i] = EltTile.of(elt, null, prev.flags, 0, prev.dom)
        for (let ch of prev.children) copy.addChild(ch)
        prev = copy
        prev.parent = cur
      }
      // Move any point tiles after the wrapper into it
      for (let j = i + 1; j < cur.children.length; j++) prev.addChild(cur.children[j])
      return prev
    }
    return null
  }

  addText(text: string) {
    let last = this.new.lastChild
    if (!(last instanceof TextTile) || last.isComposition) {
      this.new.addChild(TextTile.of(text))
    } else if (last.flags & TileFlag.Synced) {
      this.new.children.pop()
      this.new.addChild(new TextTile(last.text + text, last.dom))
      this.reused.set(last, Reused.DOM)
    } else {
      last.text += text
      last.length += text.length
    }
  }

  finish() {
    while (!(this.new instanceof DocTile)) this.up()
    this.ensureHackNode()
    return this.new
  }
}

function takeAttributes(elt: Element): Attributes {
  let attrs: string[] = []
  for (let i = 0; i < elt.attributes.length; i++) {
    let {name, value} = elt.attributes[i]
    Attributes.push(attrs, name, value)
  }
  return attrs.length ? attrs : Attributes.none
}

export function updateAttributes(dom: Element, a: Attributes, b: Attributes) {
  let changed = false
  for (let iA = 0, iB = 0;;) {
    let match = false
    if (iA < a.length && iB < b.length && a[iA] == b[iB]) {
      if (a[iA + 1] != b[iB + 1]) dom.setAttribute(b[iB], b[iB + 1])
      else match = true
      iA += 2; iB += 2
    } else if (iA < a.length && (iB == b.length || a[iA] < b[iB])) {
      dom.removeAttribute(a[iA])
      iA += 2
    } else if (iB < b.length) {
      dom.setAttribute(b[iB], b[iB + 1])
      iB += 2
    } else {
      break
    }
    if (!match) changed = true
  }
  return changed
}

const brHack = Widget.create({
  render() { return document.createElement("br") },
  editable: true
})

const imgHack = Widget.create({
  render() {
    let img = document.createElement("img")
    img.className = "wg-buffer"
    return img
  },
  editable: true
})

// Change the given sections to make sure that the composition gets
// its replacement section, so that the tile update loop can handle it
// separately from surrounding changes.
function separateComposition(sections: ChangeSet.Sections, comp: CompositionInfo) {
  let result: number[] = [], {fromB, toB} = comp
  let lenI = 0, dLen = 0
  for (let posB = 0, done = false, i = 0; i < sections.length;) {
    let len = sections[i++], ins = sections[i++], endB = posB + (ins < 0 ? len : ins)
    if (fromB > endB || toB < posB) {
      result.push(len, ins)
    } else {
      if (ins >= 0) {
        if (posB < fromB || endB > toB) return null
        dLen = len - ins
      }
      if (posB < fromB) result.push(fromB - posB, ins)
      if (!done) {
        lenI = result.length
        result.push(0, comp.text.length)
        done = true
      }
      if (endB > toB) result.push(endB - toB, ins)
    }
    posB = endB
  }
  result[lenI] = comp.text.length + dLen
  return result
}
