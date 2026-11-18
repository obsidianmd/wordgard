import {GardState, GardSelection, Transaction} from "wordgard/state"
import {Decoration, Wordgard} from "wordgard/editor"
import {Node, Plot, Pos, Slice, ChangeSet, ValidationError} from "wordgard/doc"
import {Table} from "wordgard/types"
import {Command, moveByUnit, moveByLine, moveByWord, moveToLineSide} from "wordgard/command"

import {TableMap} from "./tablemap"

const cellSelectionDeco = GardState.Field.define<Decoration.Point.Set>({
  name: "cellSelectionDeco",
  create: getCellDeco,
  update: (deco, tr) => {
    return tr.docChanged || tr.selection ? getCellDeco(tr.state) : deco
  },
  provide: f => Decoration.Point.source.of(s => s.field(f))
})

const selectedCell = Decoration.Point.attributes({class: "wg-selected-cell"})

function getCellDeco(state: GardState): Decoration.Point.Set {
  if (!(state.selection instanceof CellSelection)) return Decoration.Point.none
  return Decoration.Point.set(state.selection.ranges.map(({from}) => [selectedCell, from - 1]))
}

const tableSelectionFilter = GardState.prec.low(Transaction.extender.of(tr => {
  let normalized = CellSelection.normalize(tr.newSelection, tr.newDoc)
  return normalized ? {selection: normalized, sequential: true} : null
}))

type Dir = "left" | "right" | "forward" | "backward" | "up" | "down"

function resolveDir(dir: "left" | "right", state: GardState): "forward" | "backward" {
  let block = state.sel.head.textblockParent
  return (dir == "right") == (block ? state.textblockLTR(block.node) : state.textLTR)
    ? "forward" : "backward"
}

function cursorCommand(wg: Wordgard, {dir, extend}: {dir: Dir, extend?: boolean}) {
  let {state} = wg, {selection} = state
  if (!(selection instanceof CellSelection)) return false
  let newSel
  if (!extend) {
    newSel = GardSelection.near(state, selection.from, -1)
  } else {
    if (dir == "left" || dir == "right") dir = resolveDir(dir, state)
    newSel = selection.moveHead(state.doc, dir)
    if (!newSel) {
      let forward = dir == "forward" || dir == "down", dirSig: -1 | 1 = forward ? 1 : -1
      let table = state.sel.from.parent!.parent!
      let next = GardSelection.near(state, forward ? table.after : table.before, -dirSig as -1 | 1, dirSig)
      newSel = GardSelection.range(forward ? table.before : table.after, next.head, next.headSide)
    }
  }
  wg.dispatch({
    selection: newSel,
    scrollIntoView: true,
    userEvent: "select"
  })
  return true
}

function moveToRowSide(wg: Wordgard, {dir, extend}: {dir: "left" | "right" | "forward" | "backward", extend?: boolean}) {
  let {state} = wg, {selection} = state
  if (!(selection instanceof CellSelection)) return false
  if (dir == "left" || dir == "right") dir = resolveDir(dir, state)
  for (;;) {
    let next: CellSelection | null = (selection as CellSelection).moveHead(state.doc, dir)
    if (!next) break
    selection = next
  }
  if (selection != state.selection) wg.dispatch({
    selection,
    scrollIntoView: true,
    userEvent: "select"
  })
  return true
}

const cellSelectionTripleClick = Wordgard.mouseSelectionStyle.of((wg, event) => {
  if (event.detail == 3) {
    let pos = wg.state.doc.resolve(wg.posAtCoords({x: event.clientX, y: event.clientY}).pos)
    let cell = pos.matchingParent(n => wg.state.schema.matchNode(n.type, Node.Group.TableCell))
    if (cell) {
      let from = cell.before, to = cell.after
      return {
        get(event) { return CellSelection.create(wg.state.doc, cell.before) || GardSelection.near(wg.state, from, 1) },
        update(update) { from = update.changes.mapPos(from, 1); to = Math.max(from, update.changes.mapPos(to, -1)) }
      }
    }
  }
  return null
})

/// A cell selection is a custom selection type that, instead of
/// spanning the range between two document positions, spans the
/// rectangle between two cells in the same table. It comes with
/// extensions that make sure it is drawn in a recognizeable way,
/// automatically created when a selection crosses cell boundaries,
/// and adjusted appropriately in response to keyboard and mouse
/// actions.
export class CellSelection extends GardSelection {
  private constructor(
    /// The position directly in front of the cell that acts as this
    /// selection's anchor.
    readonly anchorCell: number,
    /// The position directly in front of the cell acting as the
    /// selection head.
    readonly headCell: number,
    /// @internal
    readonly _ranges: readonly {from: number, to: number}[],
    /// @internal
    headRange: number
  ) {
    let {from, to} = _ranges[headRange]
    super(from, to)
  }

  get ranges() { return this._ranges }

  toSlice(doc: Plot.Doc) {
    let base = doc.resolve(this.anchorCell), table = base.parent!.parent!
    let map = TableMap.get(table.node, table.start)
    let rect = map.rectBetween(this.anchorCell, this.headCell)
    let rows: Plot[] = [], added = new Set<number>()
    for (let row = rect.startRow; row < rect.endRow; row++) {
      let rowContent: Plot[] = []
      for (let col = rect.startCol; col < rect.endCol; col++) {
        let cell = map.cellAt(col, row)!
        if (added.has(cell)) continue
        added.add(cell)
        rowContent.push(map.getCell(cell))
      }
      rows.push((table.node.content[row] as Plot).tag.create(rowContent))
    }
    return Slice.of(rows, [table.node.tag])
  }

  eq(other: GardSelection) {
    return other instanceof CellSelection && other.anchorCell == this.anchorCell && other.headCell == this.headCell
  }

  map(changes: ChangeSet, cx: GardSelection.Context, assoc: -1 | 1 = -1): GardSelection {
    let anchor = mapCellPos(this.anchorCell, changes, cx, this.anchorCell < this.headCell)
    let head = mapCellPos(this.headCell, changes, cx, this.anchorCell >= this.headCell)
    if (head && anchor) {
      let found = CellSelection.create(cx.doc, anchor.pos, head.pos)
      if (found) return found
    }
    return GardSelection.near(cx, changes.mapPos(this.anchor), -1, assoc)
  }

  /// Move the head cell in the given direction, returning a new cell
  /// selection if the selection can be extended that way.
  moveHead(doc: Plot.Doc, dir: "up" | "down" | "forward" | "backward"): CellSelection | null {
    let anchor = doc.resolve(this.anchorCell), table = anchor.parent!.parent!
    let map = TableMap.get(table.node, table.start), rect = map.cellRect(this.headCell)
    let col = dir == "backward" ? rect.startCol - 1 : dir == "forward" ? rect.endCol : rect.startCol
    let row = dir == "up" ? rect.startRow - 1 : dir == "down" ? rect.endRow : rect.startRow
    if (col < 0 || col >= map.width || row < 0 || row >= map.height) return null
    let newHead = map.cellAt(col, row)
    if (newHead == null) return null
    return CellSelection.create(doc, this.anchorCell, newHead)
  }

  /// Create a cell selection between the cells at the two given
  /// positions. If the positions don't point in front of cells or the
  /// cells are not in the same table, this will return `null`.
  static create(doc: Plot.Doc, anchorCell: number, headCell = anchorCell) {
    let anchor = doc.resolve(anchorCell), head = doc.resolve(headCell)
    let anchorNode = anchor.nodeAfter, headNode = head.nodeAfter
    if (!anchorNode || !doc.schema.matchNode(anchorNode.type, Node.Group.TableCell) ||
        !headNode || !doc.schema.matchNode(headNode.type, Node.Group.TableCell))
      return null
    let table = anchor.parent!.parent!
    if (head.parent!.parent!.start != table.start) return null
    let map = TableMap.get(table.node, table.start)
    let cells = map.cellsInRect(map.rectBetween(anchorCell, headCell))
    return new CellSelection(anchorCell, headCell,
                             cells.map(pos => ({from: pos + 1, to: map.cellEnd(pos) - 1})),
                             cells.indexOf(headCell))
  }

  /// Given a selection, this returns null if that selection is valid
  /// (is a cell selection, or a selection that starts and ends outside
  /// of tables, or in the same table cell). Otherwise, it will expand a
  /// selection within a single table to a cell selection, or expand a
  /// selection that crosses table boundaries to cover the entire table(s).
  static normalize(sel: GardSelection, doc: Plot.Doc): GardSelection | null {
    if (sel instanceof CellSelection) return null
    let {from, to} = sel, modified = false
    for (let parent: Pos.Plot | null = doc.resolve(from).parent, cell: Pos.Plot | null = null;
         parent; parent = parent.parent) {
      if (doc.schema.matchNode(parent.node.type, Node.Group.TableCell)) cell = parent
      if (parent.node.type == Table.type) {
        if (to > parent.end) {
          // Move out of a partially covered table
          from = parent.before
          modified = true
        } else if (!cell || to > cell.end) {
          // Inside this table, but not in same cell
          let map = TableMap.get(parent.node, parent.start)
          let start = map.nearestCell(from, 1), end = map.nearestCell(to, -1)
          if (start > end) end = start
          return sel.anchor < sel.head
            ? CellSelection.create(doc, start, end)
            : CellSelection.create(doc, end, start)
        }
      }
    }
    for (let parent: Pos.Plot | null = doc.resolve(sel.to).parent; parent; parent = parent.parent) {
      if (parent.node.type == Table.type && from < parent.start) {
        to = parent.after
        modified = true
      }
    }
    return !modified ? null : sel.anchor < sel.head ? GardSelection.range(from, to) : GardSelection.range(to, from)
  }

  /// This object can be used as an extension to enable cell selection.
  static extension: GardState.Extension = [
    GardSelection.define<CellSelection, {anchor: number, head: number}>(
      "cell", CellSelection as any,
      sel => ({anchor: sel.anchorCell, head: sel.headCell}),
      (doc, json) => {
        if (!json || typeof json.anchor != "number" || typeof json.head != "number")
          throw new ValidationError("Invalid JSON data for CellSelection")
        let sel = CellSelection.create(doc, json.anchor, json.head)
        if (!sel) throw new ValidationError("Cell selection from JSON doesn't span actual cells")
        return sel
      }),
    cellSelectionDeco,
    tableSelectionFilter,
    Command.handler(moveByUnit, cursorCommand),
    Command.handler(moveByWord, cursorCommand),
    Command.handler(moveByLine, cursorCommand),
    Command.handler(moveToLineSide, moveToRowSide),
    cellSelectionTripleClick
  ]
}

function mapCellPos(pos: number, changes: ChangeSet, cx: GardSelection.Context, forward: boolean) {
  let cellPos = changes.mapPos(pos, 1, "after")
  if (cellPos == null) { // Cell was deleted
    let newPos = cx.doc.resolve(changes.mapPos(pos, -1))
    let next = forward ? newPos.nodeAfter : newPos.nodeBefore
    return next && cx.doc.schema.matchNode(next.type, Node.Group.TableCell)
      ? cx.doc.resolve(newPos.pos - (forward ? 0 : next.length)) : null
  }
  let newPos = cx.doc.resolve(cellPos), after = newPos.nodeAfter
  return after && cx.doc.schema.matchNode(after.type, Node.Group.TableCell)
    ? newPos : null
}
