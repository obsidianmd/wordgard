import {Plot, Node, Mark, Pos, Leaf, Token, ChangeSet} from "wordgard/doc"
import {GardSelection, GardState, Transaction} from "wordgard/state"
import {type Wordgard} from "wordgard/editor"
import {Alignment, Direction, Emphasis, Strong, Underline} from "wordgard/types"
import {Command} from "./command"
import {joinForward, joinBackward, liftEmptyBlock, clearNonFitting, autoJoinBlocks,
        deleteSelection, deleteEmptyPlot, deleteForward, deleteBackward,
        splitTextblock, joinListItems, findUnwrappable, doUnwrapBlock,
        findWrappable, wrapBlockRange,
        canAddMarkInRange, selectedTextblocks} from "./helper"
import {findClusterBreak} from "@marijn/find-cluster-break"

/// This command handles text input. To selectively override the
/// behavior of text input, provide a handler that, when the
/// conditions that it requires apply, handles the input and returns
/// true. `userEvent` will generally be one of `"input.type"`,
/// `"input.type.compose"` (text inserted as part as a composition),
/// or `"input.type.compose.start"` (initial text created by a started
/// composition).
export const insertText: Command.Pure<{from: number, to: number, insert: string, userEvent: string}> = (
  {state}, {from, to, insert, userEvent}
) => {
  if (state.readOnly) return false
  let {selection} = state
  let marks = (from == selection.from && to == selection.to && state.sel.activeMarks) ||
    state.doc.resolve(from).marks(state.doc.resolve(to))
  return {
    changes: {from, to, insert: [Leaf.Text.of(insert, marks)], fit: true},
    scrollIntoView: true,
    selection: (cx, changes) => GardSelection.near(cx, changes.mapPos(to, 1), -1),
    userEvent
  }
}

/// Command to insert a line break. The default handler will, if the
/// schema defines a {@link Node.Role.LineBreak line break} node and
/// the selection's parent node allows that, insert such a node.
/// Otherwise, in nodes marked as
/// {@link Plot.Spec.preserveWhitespace whitespace-preserving}, this
/// will insert a line break.
export const insertLineBreak: Command.Pure = ({state}) => {
  if (state.readOnly) return false
  let {doc, sel} = state
  let brk = doc.schema.lineBreak, parent = sel.from.parent.node.type
  let {from, to} = state.selection.replacementRange
  let insertBreak = brk && doc.schema.canContain(parent, brk.type)
  if (!(insertBreak || parent.preserveWhitespace && sel.to.parent.start == sel.from.parent.start)) return false
  let insert = insertBreak ? brk!.withMarks(state.sel.activeMarks) : Leaf.text("\n", state.sel.activeMarks)
  let changes = ChangeSet.create(state.doc, {from, to, insert: [insert], fit: true})
  let pos = changes.findInserted(t => insertBreak ? t.type == brk!.type : t.isText)
  return {
    changes,
    selection: GardSelection.cursor(pos == null ? from : pos + 1, -1),
    scrollIntoView: true,
    userEvent: insertBreak ? "insert.linebreak" : "input"
  }
}

/// The command that handles enter presses. The default handler will,
/// if the selection is not in an inline context, insert an empty
/// default textblock in its position. Otherwise it first tries
/// `liftEmptyBlock`, then `splitTextblock`.
export const enter: Command.Pure = ({state}) => {
  if (state.readOnly) return false
  let {sel, doc} = state
  // When not in an inline context, try to create new empty textblock
  if (!sel.head.parent.node.inlineContent || !sel.anchor.parent.node.inlineContent) {
    let {from, to} = sel.replacementRange
    let wrap = doc.schema.findWrapping(from.parent.node.type, Leaf.Text)
    if (!wrap) return false
    let content: Plot[] = []
    for (let i = wrap.length - 1; i >= 0; i--) content = [wrap[i].create(content)]
    let changes = ChangeSet.create(state.doc, {from: from.pos, to: to.pos, insert: content, fit: true})
    let placed = content.length ? changes.findInserted(t => t == content[0].tag) : null
    return {
      changes,
      selection: placed != null ? (cx => GardSelection.near(cx, placed + wrap.length, -1)) : undefined,
      scrollIntoView: true,
      userEvent: "insert.textblock"
    }
  }
  return liftEmptyBlock(state) || splitTextblock(state)
}

/// Delete the selection, or the unit after or before the selection.
/// If that unit is the start or end of a textblock, this will try to
/// join that textblock to the next one. Otherwise, if it is a
/// character or leaf node, that is deleted. If none of that is
/// possible and the cursor is in an empty textblock, this will delete
/// the textblock.
///
/// When deleting backward at the start of a list item that has a
/// sibling before it, this command will try to join those list items.
export const deleteUnit: Command.Pure<"forward" | "backward"> = ({state}, dir) => {
  if (state.readOnly) return false
  return deleteSelection(state) || (dir == "forward"
    ? joinForward(state) || deleteForward(state) || deleteEmptyPlot(state, 1)
    : joinListItems(state) || joinBackward(state) || deleteBackward(state) || deleteEmptyPlot(state, -1))
}

/// Delete the selection, or the word next to it. Will behave like
/// {@link deleteUnit}, except that, when deleting text, it will
/// delete an entire word.
export const deleteWord: Command.Pure<"forward" | "backward"> = ({state}, dir) => {
  if (state.readOnly) return false
  return deleteSelection(state) || (dir == "forward"
    ? joinForward(state) || deleteForward(state, true) || deleteEmptyPlot(state, 1)
    : joinListItems(state) || joinBackward(state) || deleteBackward(state, true) || deleteEmptyPlot(state, -1))
}

/// Delete to the end or start of the line. Stops at line wrapping
/// points.
export const deleteToLineEnd: Command<"forward" | "backward"> = (wg, dir) => {
  if (wg.state.readOnly) return false
  let tr = deleteSelection(wg.state), {selection} = wg.state
  if (tr) return (wg.dispatch(tr), true)
  if (!(selection instanceof GardSelection.Text)) return false
  let end = wg.moveToLineBoundary(selection, dir == "forward")
  if (!end || end.head == selection.head) return false
  return {
    changes: {correct: dir == "forward" ? {from: selection.head, to: end.head} : {from: end.head, to: selection.head}},
    scrollIntoView: true,
    userEvent: "delete." + dir
  }
}

/// Delete the selection, or if that is empty, the line around the
/// cursor.
export const deleteLine: Command = wg => {
  if (wg.state.readOnly) return false
  let tr = deleteSelection(wg.state), {selection} = wg.state
  if (tr) return (wg.dispatch(tr), true)
  if (!(selection instanceof GardSelection.Text)) return false
  let start = wg.moveToLineBoundary(selection, false), end = wg.moveToLineBoundary(selection, true)
  if (!start || !end || start.head >= end.head) return false
  return {
    changes: {correct: {from: start.head, to: end.head}},
    scrollIntoView: true,
    userEvent: "delete.line"
  }
}

/// Swap the characters before and after the cursor.
export const transposeChars: Command.Pure = ({state}) => {
  if (state.readOnly || !state.selection.isCursor) return false
  let {sel} = state, head = state.selection.head
  let before = sel.head.nodeBefore, after = sel.head.nodeAfter
  if (!before || !before.is(Leaf.Text) || !after || !after.is(Leaf.Text)) return false
  let lenBefore = before.param.length - findClusterBreak(before.param, before.param.length, false)
  let lenAfter = findClusterBreak(after.param, 0)
  return {
    changes: [{from: head - lenBefore, to: head},
              {from: head + lenAfter, insert: [Leaf.text(before.param.slice(before.param.length - lenBefore))]}],
    selection: GardSelection.cursor(head + lenAfter, -1),
    scrollIntoView: true,
    userEvent: "transpose"
  }
}

/// Set the type of the textblock(s) around the selection to the given
/// tag.
export const setTextblockType: Command.Pure<Plot.Tag> = ({state}, tag) => {
  if (state.readOnly) return false
  let changes: ChangeSet.Spec[] = [], {schema} = state.doc
  for (let block of selectedTextblocks(state)) {
    if (!block.node.tag.eq(tag) && block.parent && schema.canContain(block.parent.node.type, tag.type)) {
      changes.push({from: block.before, to: block.before + 1, insert: [schema.withMarksFrom(block.node.tag, tag)]})
      changes.push(clearNonFitting(schema, block, tag.type))
    }
  }
  if (!changes.length) return false
  return autoJoinBlocks(state, {changes, scrollIntoView: true, userEvent: "settype"})
}

/// Try to unwrap blocks around the selection. The second argument, if
/// given, indicates what kind of wrapping plots may be removed.
/// Returns null when no unwrapping is possible.
export const unwrapBlock: Command.Pure<Node.Query | null> = ({state}, query) => {
  if (state.readOnly) return false
  let targets: Pos.Node[] = [], changes: ChangeSet.Spec[] = []
  for (let {from, to} of state.selection.ranges) {
    if (!targets.some(t => t.after > from && t.before < to)) {
      let result = findUnwrappable(state.schema, state.doc.resolve(from), state.doc.resolve(to), query ?? undefined)
      if (result) for (let node of result) {
        targets.push(node)
        changes.push(doUnwrapBlock(node, from, to))
      }
    }
  }
  if (!targets.length) return false
  return autoJoinBlocks(state, {
    changes,
    scrollIntoView: true,
    userEvent: "unwrap"
  })
}

/// Try to wrap selected textblocks in the given wrapper. Will return
/// null if no wrapping is possible.
export const wrapBlock: Command.Pure<Plot.Tag> = ({state}, wrapper) => {
  if (state.readOnly) return false
  let changes: ChangeSet.Spec[] = [], lastTo = -1
  for (let {from, to} of state.selection.ranges) {
    let range = findWrappable(state.doc.resolve(from), state.doc.resolve(to), wrapper)
    if (!range || range.from.pos < lastTo) continue
    changes.push(wrapBlockRange(range, wrapper))
    lastTo = range.to.pos
  }
  if (!changes.length) return false
  return autoJoinBlocks(state, {changes, scrollIntoView: true, userEvent: "wrap"})
}

/// If the selection is in a block of the given type, unwap it.
/// Otherwise, try to wrap the selected blocks in such a tag.
export const toggleBlock: Command.Pure<Plot.Tag> = (target, tag) => {
  return unwrapBlock(target, tag) || wrapBlock(target, tag)
}

/// Toggle the given mark. If there is no selection, it is added to
/// the cursor's active marks, or removed if it is already in there.
/// Otherwise, if any selected content allows for the mark to be
/// added, it is added. If not, remove the mark from the selection.
export const toggleMark: Command.Pure<Mark> = ({state}, mark) => {
  if (state.readOnly) return false
  let {selection, doc} = state
  if (selection instanceof GardSelection.Text && selection.empty) {
    let selMarks = selection.marks || state.sel.head.marks(), add = !mark.isInSet(selMarks)
    let newMarks = add ? mark.addToSet(selMarks) : mark.removeFromSet(selMarks)
    return {
      selection: GardSelection.Text.create({anchor: selection.anchor, headSide: selection.headSide,
                                            goalColumn: selection.goalColumn, marks: newMarks}),
      userEvent: add ? "mark.add" : "mark.remove"
    }
  } else if (selection.ranges.some(r => canAddMarkInRange(doc, r.from, r.to, mark))) {
    return {
      changes: selection.ranges.map(r => ({from: r.from, to: r.to, add: mark})),
      userEvent: "mark.add"
    }
  } else {
    return {
      changes: selection.ranges.map(r => ({from: r.from, to: r.to, remove: mark})),
      userEvent: "mark.remove"
    }
  }
}

/// Toggle emphasis. The default implementation uses the {@link
/// Emphasis} mark.
export const toggleEmphasis: Command.Pure = target => toggleMark(target, Emphasis)

/// Toggle strong emphasis. The default implementation uses the {@link
/// Strong} mark.
export const toggleStrong: Command.Pure = target => toggleMark(target, Strong)

/// Toggle underlining. The default implementation uses the {@link
/// Underline} mark.
export const toggleUnderline: Command.Pure = target => toggleMark(target, Underline)

/// Set the selected textblocks to the given alignment. `"left"` and
/// `"right"` will be normalized to `"start"` or `"end"` depending on
/// the editor's text direction. The default implementation uses the
/// {@link Alignment} mark.
export const setAlignment: Command.Pure<null | "start" | "end" | "center" | "left" | "right"> = ({state}, align) => {
  let {schema} = state.doc
  if (state.readOnly || !schema.has(Alignment)) return false
  if (align == "start") align = null
  if (align == "left" || align == "right") align = ltrAtCursor(state) == (align == "left") ? null : "end"
  let changes: ChangeSet.Spec[] = []
  for (let block of selectedTextblocks(state)) {
    let cur = block.node.tag.mark(Alignment)
    if (cur != align && schema.markAllowed(Alignment, block.node.type))
      changes.push(align ? {from: block.before, add: Alignment.of(align)} : {from: block.before, remove: Alignment.of(cur!)})
  }
  if (!changes.length) return false
  return {
    changes,
    userEvent: "mark.set.alignment",
  }
}

/// Set the text direction for the selected textblocks. `null` will
/// remove an explicit direction mark, defaulting the blocks back to
/// the editor's base direction. The default implementation uses the
/// {@link Direction} mark.
export const setDirection: Command.Pure<null | "ltr" | "rtl" | "auto"> = ({state}, dir) => {
  let {schema} = state.doc
  if (state.readOnly || !schema.has(Direction)) return false
  let changes: ChangeSet.Spec[] = []
  for (let block of selectedTextblocks(state)) {
    let cur = block.node.tag.mark(Direction)
    if (cur != dir && schema.markAllowed(Direction, block.node.type))
      changes.push(dir ? {from: block.before, add: Direction.of(dir)} : {from: block.before, remove: Direction.of(cur!)})
  }
  if (!changes.length) return false
  return {
    changes,
    userEvent: "mark.set.direction",
  }
}

/// Toggle list wrapping with the given list tag for the selected
/// blocks.
export const toggleList: Command.Pure<Plot.Tag> = ({state}, listTag) => {
  if (state.readOnly) return false
  let blocks = selectedTextblocks(state)
  if (!blocks.length) return false
  return addList(state, blocks, listTag) || removeList(state, blocks, listTag)
}

/// Returns true when all selected textblocks are wrapped in a list of
/// the given type.
export const listIsActive = (listTag: Plot.Tag): (state: GardState) => boolean => state => {
  return selectedTextblocks(state).every(b => {
    let item = isListItem(b)
    return item && item.parent!.node.type == listTag.type
  })
}

function isListItem(node: Pos.Node): Pos.Plot | null {
  for (let first = true;;) {
    let {parent} = node
    if (!parent) return null
    if (parent.node.tag.type.hasRole(Node.Role.List)) return first ? node as Pos.Plot : null
    first = node.isFirst
    node = parent
  }
}

function autoJoin(a: Plot.Tag, b: Plot.Tag) {
  let {autoJoin} = a.type.spec
  return typeof autoJoin == "function" ? autoJoin(a, b) : typeof autoJoin == "boolean" ? autoJoin : a.eq(b)
}

function addList(state: GardState, blocks: Pos.Plot[], listTag: Plot.Tag): Transaction.Spec | false {
  let plan: ({wrap: Pos.Plot, item: Plot.Tag} | {change: Pos.Node, item: Pos.Node})[] = []
  let chBefore: Set<number> = new Set, chAfter: Set<number> = new Set
  let lastItem = -1, {schema} = state.doc
  for (let block of blocks) {
    let item = isListItem(block), wrap
    if (!item && block.parent && schema.canContain(block.parent.node.type, listTag.type) &&
        ((wrap = schema.findWrapping(listTag.type, block.node.type)) && wrap.length == 1 ||
          (wrap = schema.findWrapping(listTag.type, Leaf.Text)) && wrap.length == 1)) {
      chAfter.add(block.before)
      chBefore.add(block.after)
      plan.push({wrap: block, item: wrap[0]})
      lastItem = block.before
    } else if (item?.parent && item.parent.node.tag.type != listTag.type &&
               schema.canContain(listTag.type, item.node.type) &&
               item.parent.parent && schema.canContain(item.parent.parent.node.type, listTag.type) &&
               item.before != lastItem) {
      chAfter.add(item.before)
      chBefore.add(item.after)
      if (item.isFirst) chAfter.add(item.parent.before)
      if (item.isLast) chBefore.add(item.parent.after)
      plan.push({change: block, item})
      lastItem = item.before
    }
  }
  if (!plan.length) return false
  let changes: ChangeSet.Spec[] = []
  for (let step of plan) {
    if ("wrap" in step) { // Wrap block in a list
      let {wrap, item} = step, prev, next
      let openTo = item.isTextblock ? wrap.start : wrap.before, openFrom = wrap.before, open: Token[] = [item]
      if (chBefore.has(wrap.before)) {} // Block above is also included in change
      else if ((prev = wrap.previousSibling) && prev.tag.eq(listTag)) openFrom-- // Join to list above
      else open.unshift(listTag) // Start new list
      changes.push({from: openFrom, to: openTo, insert: open})
      let closeFrom = item.isTextblock ? wrap.end : wrap.after, closeTo = wrap.after, close: Token[] = [Plot.End]
      if (chAfter.has(wrap.after)) {} // Block below included in change
      else if ((next = wrap.nextSibling) && next.isPlot && next.type == listTag.type && autoJoin(next.tag, listTag))
        closeTo++ // Join
      else close.push(Plot.End) // End list
      changes.push({from: closeFrom, to: closeTo, insert: close})
    } else { // Change other list
      let {item} = step, prev, next
      if (item.isFirst) {
        if (chBefore.has(item.before - 1)) // Right after an item produced by another change, delete open token
          changes.push({from: item.before - 1, to: item.before})
        else if ((prev = item.parent!.previousSibling) && prev.tag.type == listTag.type) // Join to list above
          changes.push({from: item.before - 2, to: item.before})
        else // Change open token
          changes.push({from: item.before - 1, to: item.before, insert: [listTag]})
      } else if (!chBefore.has(item.before)) { // Start a new list
        changes.push({from: item.before, insert: [Plot.End, listTag]})
      }
      if (item.isLast) {
        if (chAfter.has(item.after + 1)) { // Before item produced by other change, drop close token
          changes.push({from: item.after, to: item.after + 1})
        } else if ((next = item.parent!.nextSibling) && next.isPlot && autoJoin(next.tag, listTag)) { // Join to list below
          changes.push({from: item.after, to: item.after + 2})
        }
      }
    }
  }
  return {changes, userEvent: "wrap.list"}
}

function removeList(state: GardState, blocks: Pos.Node[], listTag: Plot.Tag): Transaction.Spec | false {
  let plan: {item: Pos.Plot, rewrap: Plot.Tag | null}[] = [], lastItem = -1
  let chBefore: Set<number> = new Set, chAfter: Set<number> = new Set
  let {schema} = state.doc
  for (let block of blocks) {
    let item = isListItem(block)
    if (!item) continue
    let list = item.parent!, parent = list.parent, rewrap: Node.Tag | null = null
    if (parent && list.node.isPlot && list.node.type == listTag.type && item.before != lastItem &&
        (item.node.isTextblock
          ? (rewrap = schema.defaultContentPlot(parent.node.type)) && rewrap.isTextblock
          : schema.canContain(parent.node.type, block.node.type))) {
      lastItem = item.before
      plan.push({item, rewrap: rewrap as Plot.Tag})
      chAfter.add(item.before)
      chBefore.add(item.after)
    }
  }
  if (!plan.length) return false
  let changes: ChangeSet.Spec[] = []
  for (let {item, rewrap} of plan) {
    let openFrom = item.before, openTo = item.start, open: Token[] = rewrap ? [rewrap] : []
    if (item.isFirst) openFrom--
    else if (!chBefore.has(item.before)) open.unshift(Plot.End)
    changes.push({from: openFrom, to: openTo, insert: open})
    let closeFrom = rewrap ? item.after : item.end, closeTo = item.after, close: Token[] = []
    if (item.isLast) closeTo++
    else if (!chAfter.has(item.after)) close.push(listTag)
    changes.push({from: closeFrom, to: closeTo, insert: close})
  }
  return {changes, userEvent: "unwrap.list"}
}

function setSelection(selection: GardSelection): Transaction.Spec {
  return {
    selection: selection,
    scrollIntoView: true,
    userEvent: "select"
  }
}

function ltrAtCursor(state: GardState) {
  let block = state.sel.head.textblockParent
  return block ? state.textblockLTR(block.node) : state.textLTR
}

function isForward(dir: "left" | "right" | "forward" | "backward", state: GardState) {
  return dir == "forward" ? true : dir == "backward" ? false : (dir == "right") == ltrAtCursor(state)
}

function asTextSel(sel: GardSelection, forward: boolean): GardSelection.Text {
  if (sel instanceof GardSelection.Text) return sel
  let {from, to} = sel.replacementRange
  return forward ? GardSelection.range(from, to) : GardSelection.range(to, from)
}

function extendSel(base: GardSelection, head: GardSelection.Text) {
  return GardSelection.range(base.anchor, head.head, head.headSide, head.goalColumn)
}

/// Move the selection head one unit (text cluster, atomic node, or
/// node boundary) in the indicated direction. When `extend` is true,
/// keep the selection anchor in place. The default handler moves
/// visually through bidirectional text, so when going left, the
/// motion will go back in left-to-right text, and
/// forward in right-to-left text.
export const moveByUnit: Command.Pure<{dir: "left" | "right" | "forward" | "backward", extend?: boolean}> = (
  {state}, {dir, extend}
) => {
  let forward = isForward(dir, state), selection = asTextSel(state.selection, forward)
  if (!selection.empty && !extend) {
    return setSelection(GardSelection.near(state, forward ? selection.to : selection.from, forward ? -1 : 1))
  } else {
    let next: GardSelection | null = selection.nextNormalCursor(state, forward)
    if (!next) return false
    if (!extend) state.doc.iterate(Math.min(selection.head, next.head), Math.max(selection.head, next.head), (node, pos) => {
      if (node.type.isSelectable && state.isAtom(node.type))
        next = GardSelection.node(pos, node)
      if (node.isPlot) return !node.type.isolating
    })
    return setSelection(extend ? extendSel(selection, next as GardSelection.Text) : next)
  }
}

/// Move the selection head one word in the indicated direction. Keep
/// the anchor in place if `extend` is true. The default handler moves
/// visually.
export const moveByWord: Command.Pure<{dir: "left" | "right", extend?: boolean}> = ({state}, {dir, extend}) => {
  let forward = (dir == "right") == ltrAtCursor(state)
  let selection = asTextSel(state.selection, forward)
  let moved = selection.skipWord(state, forward)
  return moved ? setSelection(extend ? extendSel(selection, moved) : moved) : false
}

function nextVertical(wg: Wordgard, sel: GardSelection, forward: boolean,
                      distance?: number, allowNode?: boolean) {
  let next = wg.moveVertically(sel, forward, distance, allowNode)
  if (next) return next
  let end = (forward ? GardSelection.atEnd : GardSelection.atStart)(wg.state)
  return end.head == wg.state.selection.head ? null : end
}

/// Move the selection head one line up or down. When `extend` is
/// true, keep the anchor in place.
export const moveByLine: Command<{dir: "up" | "down", extend?: boolean}> = (wg, {dir, extend}) => {
  let {state} = wg, {selection} = state, forward = dir == "down"
  if (selection instanceof GardSelection.Node) {
    let next = !extend && GardSelection.near(state, forward ? selection.to : selection.from, forward ? -1 : 1)
    if (next && !state.doc.resolve(next.head).parent.node.inlineContent)
      return setSelection(GardSelection.cursor(next.head, next.headSide, selection.goalColumn))
    selection = GardSelection.cursor(forward ? selection.to : selection.from, undefined, selection.goalColumn)
  } else {
    selection = asTextSel(state.selection, forward)
  }
  let moved = nextVertical(wg, selection, forward, undefined, !extend)
  return moved ? setSelection(extend ? extendSel(selection, moved as GardSelection.Text) : moved) : false
}

function pageHeight(wg: Wordgard) {
  let marginTop = 0, marginBottom = 0
  for (let source of wg.state.facet((wg.constructor as typeof Wordgard).coveredMargins)) {
    let margins = source(wg)
    if (margins?.top) marginTop = Math.max(margins?.top, marginTop)
    if (margins?.bottom) marginBottom = Math.max(margins?.bottom, marginBottom)
  }
  return Math.max(10, Math.min(wg.scrollDOM.clientHeight - marginTop - marginBottom,
                               (wg.dom.ownerDocument.defaultView || window).innerHeight) - 10)
}

/// Move the selection head one page up or down. Extend the selection
/// when the `extend` flag is true.
export const moveByPage: Command<{dir: "up" | "down", extend?: boolean}> = (wg, {dir, extend}) => {
  let {state} = wg, {selection} = state, forward = dir == "down"
  let moved = selection.empty || extend ? nextVertical(wg, selection, forward, pageHeight(wg), !extend)
    : forward ? GardSelection.cursor(selection.to, -1) : GardSelection.cursor(selection.from, 1)
  return moved ? setSelection(extend ? extendSel(selection, moved as GardSelection.Text) : moved) : false
}

/// Move to the indicated side of the current line. Will stop at line
/// wrap points. `"left"` and `"right"` will be interpreted based on
/// the editor's text direction.
export const moveToLineSide: Command<{
  dir: "left" | "right" | "forward" | "backward", extend?: boolean,
}> = (wg, {dir, extend}) => {
  let pos = wg.moveToLineBoundary(wg.state.selection, isForward(dir, wg.state))
  return pos ? setSelection(extend ? extendSel(wg.state.selection, pos) : pos) : false
}

/// Move to the start or end of the textblock that has the selection
/// head.
export const moveToTextblockSide: Command<{
  dir: "left" | "right" | "forward" | "backward", extend?: boolean,
}> = (wg, {dir, extend}) => {
  let {state} = wg, block = state.sel.head.textblockParent
  if (!block) return false
  let pos = isForward(dir, wg.state) ? GardSelection.atEnd(state, block) : GardSelection.atStart(state, block)
  return setSelection(extend ? extendSel(wg.state.selection, pos) : pos)
}

/// Move to the start or end of the document.
export const moveToDocSide: Command.Pure<{side: "start" | "end", extend?: boolean}> = (target, {side, extend}) => {
  let {state} = target
  let pos = side == "start" ? GardSelection.atStart(state) : GardSelection.atEnd(state)
  if (state.selection.empty && pos.head == state.selection.head) return false
  return setSelection(extend ? extendSel(state.selection, pos) : pos)
}

/// Select the entire document.
export const selectAll: Command.Pure = ({state}) => {
  return {
    selection: GardSelection.range(0, state.doc.length),
    userEvent: "select.all"
  }
}

/// Undo an edit. Does not have a default handler, but a handler is
/// added by the history extension.
export const undo: Command = () => false

/// Redo an edit. Does not have a default handler.
export const redo: Command = () => false
