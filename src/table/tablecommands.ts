import {GardState, GardSelection} from "wordgard/state"
import {Pos, Node, ChangeSet, Schema} from "wordgard/doc"
import {TableRow, Cell, HeaderCell, BlockCell, BlockHeaderCell, ColSpan, RowSpan} from "wordgard/types"
import {Command} from "wordgard/command"

import {TableMap} from "./tablemap"
import {CellSelection} from "./cellselection"

export function tableContext(state: GardState, pos?: number) {
  let table: Pos.Plot | undefined, cells: number[] | undefined
  if (pos != null || !(state.selection instanceof CellSelection)) {
    let ref = pos != null ? state.doc.resolve(pos) : state.sel.head
    let cellPos = ref.matchingParent(node => state.schema.matchNode(node.type, Node.Group.TableCell))
    if (cellPos && cellPos.parent?.parent) {
      table = cellPos.parent.parent
      cells = [cellPos.before]
    }
  } else {
    table = state.sel.anchor.parent!.parent!.parent!
    cells = state.selection.ranges.map(r => r.from - 1)
  }
  return cells ? {cells, map: TableMap.get(table!.node, table!.start)} : null
}

export function cellTag(schema: Schema) {
  if (schema.has(Cell)) return Cell
  if (schema.has(BlockCell)) return BlockCell
  throw new Error(`No cell type in schema`)
}

export function headerCellTag(schema: Schema) {
  if (schema.has(HeaderCell)) return HeaderCell
  if (schema.has(BlockHeaderCell)) return BlockHeaderCell
  return null
}

export const toggleHeaderCell: Command.Pure = ({state}) => {
  let cx = tableContext(state), header = headerCellTag(state.schema)
  if (!cx || !header) return false
  let cells = cx.cells.map(c => cx.map.getCell(c))
  let changes: ChangeSet.Spec[] = []
  if (cells.some(x => x.type != header.type)) {
    for (let i = 0; i < cells.length; i++) {
      let cell = cells[i], pos = cx.cells[i]
      if (cell.type != header.type)
        changes.push({from: pos, to: pos + 1, insert: [state.schema.withMarksFrom(cell.tag, header)]})
    }
  } else {
    let tag = cellTag(state.schema)
    for (let i = 0; i < cells.length; i++) {
      let cell = cells[i], pos = cx.cells[i]
      if (cell.type == header.type)
        changes.push({from: pos, to: pos + 1, insert: [state.schema.withMarksFrom(cell.tag, tag)]})
    }
  }
  return {changes}
}

function selectedRect(state: GardState, cx: {cells: number[], map: TableMap}) {
  return state.selection instanceof CellSelection
    ? cx.map.rectBetween(state.selection.anchorCell, state.selection.headCell)
    : cx.map.cellRect(cx.cells[0])
}

/// Add a column at the given side of the selection. The selection may
/// either be a cell selection or another type of selection inside a
/// table cell.
export const addColumn: Command.Pure<"before" | "after"> = ({state}, side) => {
  let cx = tableContext(state)
  if (!cx) return false
  let {map} = cx, rect = selectedRect(state, cx)
  let col = side == "before" ? rect.startCol : rect.endCol

  let changes: ChangeSet.Spec[] = [], adjusted = new Set<number>()
  for (let row = 0, pos; row < map.height; row++) {
    if (col > 0 && col < map.width && map.cellAt(col - 1, row) == (pos = map.cellAt(col, row)) && pos != null) {
      // Inside a col-spanning cell
      if (!adjusted.has(pos)) {
        let value = map.getCell(pos).mark(ColSpan) ?? 1
        changes.push({from: pos, add: ColSpan.of(value + 1)})
        adjusted.add(pos)
      }
    } else {
      changes.push({from: map.cellInsertionPos(col, row), insert: [state.schema.createAndFill(cellTag(state.schema))]})
    }
  }
  return {
    changes,
    userEvent: "insert.column"
  }
}

/// Delete the selected columns. Will act on a cell selection or
/// another type of selection inside a cell.
export const deleteColumn: Command.Pure = ({state}) => {
  let cx = tableContext(state)
  if (!cx) return false
  let {map} = cx, rect = selectedRect(state, cx)
  if (rect.startCol == 0 && rect.endCol == map.width) {
    return {
      changes: {from: map.tablePos, to: map.tablePos + map.table.length, fit: true},
      selection: cx => GardSelection.near(cx, map.tablePos, 1, -1),
      userevent: "delete.table"
    }
  }

  let changes: ChangeSet.Spec[] = [], handled = new Set<number>(), delPos = state.selection.from
  for (let row = 0; row < map.height; row++) {
    for (let col = rect.startCol; col < rect.endCol;) {
      let cell = map.cellAt(col, row)
      if (cell == null) continue
      let node = map.getCell(cell), span = node.mark(ColSpan) ?? 1
      if (col == rect.startCol && col > 0 && map.cellAt(col - 1, row) == cell) {
        // Part of a col-spanning cell starting before this col
        let cellRect = map.cellRect(cell)
        if (!handled.has(cell)) {
          let newSpan = rect.startCol - cellRect.startCol + (Math.max(0, cellRect.endCol - rect.endCol))
          changes.push(newSpan == 1 ? {from: cell, remove: ColSpan.isInSet(node.marks)!}
            : {from: cell, add: ColSpan.of(newSpan)})
          handled.add(cell)
        }
        col = cellRect.endCol
      } else if (col + span > rect.endCol) {
        // Col-spanning cell that sticks out
        if (!handled.has(cell)) {
          let newSpan = col + span - rect.endCol
          changes.push(newSpan == 1 ? {from: cell, remove: ColSpan.isInSet(node.marks)!}
            : {from: cell, add: ColSpan.of(newSpan)})
          handled.add(cell)
        }
        break
      } else {
        if (!handled.has(cell)) {
          changes.push({from: cell, to: cell + node.length})
          delPos = Math.min(delPos, cell)
          handled.add(cell)
        }
        col += span
      }
    }
  }
  return {
    changes,
    selection: cx => GardSelection.near(cx, delPos, -1, -1),
    userEvent: "delete.column"
  }
}

/// Add a row next to the selected cells, on the side indicated.
export const addRow: Command.Pure<"before" | "after"> = ({state}, side) => {
  let cx = tableContext(state)
  if (!cx) return false
  let {map} = cx, rect = selectedRect(state, cx)
  let row = side == "before" ? rect.startRow : rect.endRow

  let changes: ChangeSet.Spec[] = [], adjusted = new Set<number>()
  let cellCount = map.width
  if (row > 0 && row < map.height) {
    // Look for row-spanning cells overlapping the new row
    for (let col = 0; col < map.width; col++) {
      let above = map.cellAt(col, row - 1), below = map.cellAt(col, row)
      if (above != null && above == below) {
        cellCount--
        if (!adjusted.has(above)) {
          let value = map.getCell(above).mark(RowSpan)!
          changes.push({from: above, add: RowSpan.of(value + 1)})
          adjusted.add(above)
        }
      }
    }
  }
  let cell = state.schema.createAndFill(cellTag(state.schema)), content: Node[] = []
  for (let i = 0; i < cellCount; i++) content.push(cell)
  changes.push({from: map.rowPos(row), insert: [TableRow.create(content)]})

  return {
    changes,
    userEvent: "insert.row"
  }
}

/// Delete the selected row(s).
export const deleteRow: Command.Pure = ({state}) => {
  let cx = tableContext(state)
  if (!cx) return false
  let {map} = cx, rect = selectedRect(state, cx)
  if (rect.startRow == 0 && rect.endRow == map.height) {
    return {
      changes: {from: map.tablePos, to: map.tablePos + map.table.length, fit: true},
      selection: cx => GardSelection.near(cx, map.tablePos, 1, -1),
      userEvent: "delete.table"
    }
  }

  let changes: ChangeSet.Spec[] = [], handled = new Set<number>()
  // Look for cells that stick into or out of the deleted rows through rowspan
  for (let col = 0; col < map.width; col++) {
    if (rect.startRow > 0) {
      let above = map.cellAt(col, rect.startRow - 1)
      if (above != null && !handled.has(above) && map.cellAt(col, rect.startRow) == above) {
        let cellRect = map.cellRect(above)
        let rowsAbove = rect.startRow - cellRect.startRow, rowsBelow = Math.max(0, cellRect.endRow - rect.endRow)
        let rows = rowsAbove + rowsBelow
        changes.push(rows == 1 ? {from: above, remove: RowSpan.isInSet(map.getCell(above).marks)!}
          : {from: above, add: RowSpan.of(rows)})
        handled.add(above)
      }
    }
    if (rect.endRow < map.height) {
      let below = map.cellAt(col, rect.endRow)
      if (below != null && !handled.has(below) && map.cellAt(col, rect.endRow - 1) == below) {
        let cell = map.getCell(below), cellRect = map.cellRect(below)
        let rowSpan = cellRect.endRow - rect.endRow
        changes.push({from: below, to: below + cell.length})
        let copy = cell.withMarks(rowSpan == 1 ? RowSpan.removeFromSet(cell.marks) : RowSpan.of(rowSpan).addToSet(cell.marks))
        changes.push({from: map.cellInsertionPos(cellRect.startCol, rect.endRow), insert: [copy]})
        handled.add(below)
      }
    }
  }

  let delPos = state.selection.from
  for (let row = rect.startRow; row < rect.endRow; row++) {
    let rowPos = map.rowPos(row), rowNode = map.table.content[row]
    delPos = Math.min(delPos, rowPos)
    changes.push({from: rowPos, to: rowPos + rowNode.length})
  }
  return {
    changes,
    selection: cx => GardSelection.near(cx, delPos, 1, -1),
    userEvent: "delete.row"
  }
}

/// If the current selection is a multi-cell cell selection, merge the
/// cells into a single cell by giving it a {@link types.RowSpan}
/// and/or {@link types.ColSpan}. The content from the cells is all
/// put into the resulting merged cell.
export const mergeCells: Command.Pure = ({state}) => {
  if (!(state.selection instanceof CellSelection) || state.selection.ranges.length == 1) return false
  let cx = tableContext(state)!
  let {map} = cx, rect = selectedRect(state, cx)
  if (map.cellsOverlapRectangle(rect)) return false

  let movedContent: Node[] = [], changes: ChangeSet.Spec[] = []
  for (let i = 1; i < cx.cells.length; i++) {
    let pos = cx.cells[i], node = map.getCell(pos)
    if (node.content.length && !(node.content[0].isPlot && !node.content[0].content.length))
      movedContent = movedContent.concat(node.content)
    changes.push({from: pos, to: pos + node.length})
  }
  let pos = cx.cells[0]
  let width = rect.endCol - rect.startCol, height = rect.endRow - rect.startRow
  if (width > 1) changes.push({from: pos, add: ColSpan.of(width)})
  if (height > 1) changes.push({from: pos, add: RowSpan.of(height)})
  if (movedContent.length) changes.push({from: map.cellEnd(pos) - 1, insert: movedContent})
  return {
    changes,
    selection: cx => CellSelection.create(cx.doc, pos)!,
    userEvent: "join.cell"
  }
}

/// When the selection is in or on a merged cell, split it again. Any
/// content is left in the first split-off cell.
export const splitCell: Command.Pure = ({state}) => {
  let cx = tableContext(state)
  if (!cx || cx.cells.length > 1) return false
  let {map} = cx, pos = cx.cells[0], node = map.getCell(pos)
  let colSpan = ColSpan.isInSet(node.marks), rowSpan = RowSpan.isInSet(node.marks)
  if (!colSpan && !rowSpan) return false

  let changes: ChangeSet.Spec[] = [], rect = map.cellRect(pos), lastInsert = -1
  for (let row = rect.startRow, first = true; row < rect.endRow; row++) {
    let insertPos = lastInsert = map.cellInsertionPos(rect.endCol, row)
    let cell = state.schema.createAndFill(node.type.default!)
    for (let col = rect.startCol; col < rect.endCol; col++) {
      if (first) { first = false; continue }
      changes.push({from: insertPos, insert: [cell]})
    }
  }
  if (colSpan) changes.push({from: pos, remove: colSpan})
  if (rowSpan) changes.push({from: pos, remove: rowSpan})
  return {
    changes,
    selection: (cx, changes) => {
      let end = cx.doc.resolve(changes.mapPos(lastInsert, 1))
      let before = end.nodeBefore
      return before && CellSelection.create(cx.doc, pos, end.pos - before.length)
    },
    userEvent: "split.cell"
  }
}
