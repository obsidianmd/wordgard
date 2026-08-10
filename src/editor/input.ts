import {GardSelection, GardState, Transaction} from "wordgard/state"
import {Plot, Leaf, ChangeSet, Mark, Slice, ValidationError} from "wordgard/doc"
import {Command, undo, redo, insertLineBreak, enter, insertText,
        deleteWord, deleteUnit, deleteToLineEnd, deleteLine,
        toggleEmphasis, toggleStrong, toggleUnderline,
        transposeChars, deleteSelection, setAlignment, setDirection} from "wordgard/command"
import {findClusterBreak} from "@marijn/find-cluster-break"
import {Wordgard} from "./editor"
import browser from "./browser"
import {getSelection, scrollableParents, DOMNode, textNodeBefore, textNodeAfter, domIndex} from "./dom"
import {readClipboard, writeClipboard} from "./clipboard"
import {eqArray, logException} from "./util"
import {Tile, TextTile, CoordPos} from "./tile"
import {KeyBinding} from "./keymap"

const LOG_input = false

export const eventHandler = GardState.Facet.define<
  {event: string, handler: (event: Event, wg: Wordgard) => boolean | void},
  Record<string, ((event: Event, wg: Wordgard) => boolean | void)[]>
>({
  combine: handlers => {
    let result: Record<string, ((event: Event, wg: Wordgard) => boolean | void)[]> = Object.create(null)
    for (let {event, handler} of handlers)
      (result[event] || (result[event] = [])).push(handler)
    return result
  }
})

export const eventObserver = GardState.Facet.define<
  {event: string, observer: (event: Event, wg: Wordgard) => void},
  Record<string, ((event: Event, wg: Wordgard) => void)[]>
>({
  combine: observers => {
    let result: Record<string, ((event: Event, wg: Wordgard) => void)[]> = Object.create(null)
    for (let {event, observer} of observers)
      (result[event] || (result[event] = [])).push(observer)
    return result
  }
})

type InputEventData = {
  inputType: string
  data: string | null
  domRange: {from: number, to: number} | null
}

export class InputState {
  shiftKey = false
  lastKeyCode: number = 0
  lastKeyTime: number = 0
  lastTouchTime = 0
  lastScrollTop = 0
  lastScrollLeft = 0

  lastContextMenu: number = 0
  scrollHandlers: ((event: Event) => boolean | void)[] = []

  handlers: {[event: string]: {
    observers: readonly HandlerFunction[],
    handlers: readonly HandlerFunction[]
  }} = Object.create(null)

  // Track the current composition. Count changes to determine whether
  // a given change is the first one, and track the text node that
  // composition is happening in.
  composing: null | {changes: number, target: Text | null} = null
  // End time of the previous composition
  compositionEndedAt = 0
  // Used in a kludge to detect when an Enter keypress should be
  // considered part of the composition on Safari, which fires events
  // in the wrong order
  compositionPendingKey = false
  wrappingComposition: Mark.Set | null = null

  mouseSelection: MouseSelection | null = null
  // When a drag from the editor is active, this points at the range
  // being dragged.
  draggedContent: GardSelection | null = null

  notifiedFocused: boolean

  // Between beforeinput and input events, this holds information
  // about the event (because input events no longer provide range
  // information).
  pendingInputEvent: InputEventData | null = null
  // When input events have changed the DOM, this holds the updated
  // document, which we need for the mapping done in `addDOMChange`.
  domDoc: Plot.Doc
  // Mapping between `domDoc` and `state.doc`. See getter.
  _domMapping: ChangeSet
  // Tracks up to which index of `viewState.pending` `_domMapping` has
  // been updated.
  domMappingIndex: number = 0
  // Mapping between the doc at the last flush and `domDoc`.
  domChanges: ChangeSet | null = null

  constructor(readonly wg: Wordgard) {
    this.handleEvent = this.handleEvent.bind(this)
    this.notifiedFocused = wg.hasFocus
    // On Safari adding an input event handler somehow prevents an
    // issue where the composition vanishes when you press enter.
    if (browser.safari) wg.contentDOM.addEventListener("input", () => null)
    this.domDoc = wg.state.doc
    this._domMapping = ChangeSet.empty(this.domDoc.length)
  }

  handleEvent(event: Event) {
    if (!eventBelongsToEditor(this.wg, event) || this.ignoreDuringComposition(event)) return
    if (event.type == "keydown" && this.keydown(event as KeyboardEvent)) return
    if (event.type == "keyup" && (event as KeyboardEvent).keyCode == 16) this.shiftKey = false
    this.runHandlers(event.type, event)
  }

  runHandlers(type: string, event: Event) {
    let handlers = this.handlers[type]
    if (handlers) {
      for (let observer of handlers.observers) observer(this.wg, event)
      for (let handler of handlers.handlers) {
        if (event.defaultPrevented) break
        if (handler(this.wg, event)) { event.preventDefault(); break }
      }
    }
  }

  ensureHandlers(state: GardState) {
    let handlers = computeHandlers(state), prev = this.handlers, dom = this.wg.contentDOM
    for (let type in handlers) if (type != "scroll") {
      let passive = !handlers[type].handlers.length
      let exists: (typeof prev)["type"] | null = prev[type]
      if (exists && passive != !exists.handlers.length) {
        dom.removeEventListener(type, this.handleEvent)
        exists = null
      }
      if (!exists) dom.addEventListener(type, this.handleEvent, {passive})
    }
    for (let type in prev) if (type != "scroll" && !handlers[type])
      dom.removeEventListener(type, this.handleEvent)
    this.handlers = handlers
  }

  keydown(event: KeyboardEvent) {
    LOG_input && console.log("keydown", event.key, ["shift", "alt", "ctrl", "meta"].filter(k => (event as any)[k + "Key"]).join())
    // Must always run, even if a custom handler handled the event
    this.lastKeyCode = event.keyCode
    this.lastKeyTime = Date.now()
    this.shiftKey = event.keyCode == 16 || event.shiftKey
    return false
  }

  ignoreDuringComposition(event: Event): boolean {
    if (!/^key/.test(event.type)) return false
    if (this.composing && this.composing.changes) return true
    // See https://www.stum.de/2016/06/24/handling-ime-events-in-javascript/.
    // On some input method editors (IMEs), the Enter key is used to
    // confirm character selection. On Safari, when Enter is pressed,
    // compositionend and keydown events are sometimes emitted in the
    // wrong order. The key event should still be ignored, even when
    // it happens after the compositionend event.
    if (browser.safari && !browser.ios && this.compositionPendingKey && Date.now() - this.compositionEndedAt < 100) {
      this.compositionPendingKey = false
      return true
    }
    return false
  }

  startMouseSelection(mouseSelection: MouseSelection) {
    if (this.mouseSelection) this.mouseSelection.disconnect()
    this.mouseSelection = mouseSelection
  }

  update(update: Wordgard.Update) {
    if (this.mouseSelection) this.mouseSelection.update(update)
    if (this.draggedContent && update.docChanged) this.draggedContent = this.draggedContent.map(update.changes, update.state)
    if (update.transactions.length) this.lastKeyCode = 0
    this.domDoc = update.state.doc
    this._domMapping = ChangeSet.empty(this.domDoc.length)
    this.domMappingIndex = 0
    this.domChanges = null
  }

  // Create a position in `domDoc` from a DOM position. Needed in
  // order to interpret `beforeinput` event ranges and other DOM
  // positions when there are unflushed DOM changes.
  getDOMPos(node: Node, offset: number) {
    if (node.nodeType == 1 && offset && node.childNodes[offset - 1].nodeType == 3) {
      node = node.childNodes[offset - 1]
      offset = node.nodeValue!.length
    }
    let inText = node.nodeType == 3
    let ref = this.wg.docTile.posFromDOM(node, inText ? 0 : offset)
    let dir: -1 | 1 = -1
    let textBefore = textNodeBefore(node.parentNode!, domIndex(node))
    let prev = textBefore && Tile.get(textBefore)
    if (prev instanceof TextTile && prev.length < prev.dom.nodeValue!.length) dir = 1
    if (this.domChanges) ref = this.domChanges.mapPos(ref, dir)
    return ref + (inText ? offset : 0)
  }

  // Get the current mapping from `domDoc` to `state.doc`. Updated
  // lazily so that `addDOMChange` gets a chance to notice when DOM
  // changes and transaction changes match.
  get domMapping() {
    let {pending} = this.wg.viewState
    while (this.domMappingIndex < pending.length)
      this._domMapping = this._domMapping.compose(pending[this.domMappingIndex++].changes)
    return this._domMapping
  }

  // Assign a position (in `state.doc`) to the given DOM position.
  // Takes unflushed DOM changes into account.
  posAtDOM(node: Node, offset: number, assoc: -1 | 1 = -1) {
    if (this.domMapping.empty && !this.domChanges)
      return this.wg.docTile.posFromDOM(node, offset)
    return this.domMapping.mapPos(this.getDOMPos(node, offset), assoc)
  }

  // Update the editor state for a beforeinput event.
  beforeInput(event: InputEvent, data: InputEventData) {
    let type = event.inputType, range: {from: number, to: number} | undefined
    let {wg} = this, sel = wg.state.selection
    if (data.domRange) {
      range = {from: this.domMapping.mapPos(data.domRange.from),
               to: this.domMapping.mapPos(data.domRange.to)}
      if (!this.domMapping.empty && type == "insertText" && !this.composing && range.from == range.to) {
        let fromMax = this.domMapping.mapPos(data.domRange.from, 1)
        if (range.from <= sel.from && fromMax >= sel.to)
          range = sel
      }
    }

    let command = inputTypeCommands[type]
    if ((type == "deleteContentBackward" || type == "deleteContentForward") && range &&
        (sel.empty
          ? !isSingleChar(this.domDoc, data.domRange!.from, data.domRange!.to) ||
            sel.head != (type == "deleteContentBackward" ? range.to : range.from)
          : sel.from != range.from || sel.to != range.to)) {
      // The browser is firing a deleteContent event to delete a random range.
      wg.dispatch({changes: {from: range.from, to: range.to, fit: true}, userEvent: "delete"})
    } else if (command) {
      Command.dispatch(wg, command)
    } else if (type == "insertText") {
      let insert = event.data!.replace(/\r\n?|\n/g, " ")
      Command.dispatch(wg, insertText, {from: range!.from, to: range!.to, insert, userEvent: "input.type"})
    } else if ((type == "insertReplacementText" || type == "insertFromYank")) {
      let read = readClipboard(wg.state, event.dataTransfer!, wg.state.sel.head, true)
      let {from, to} = range!
      let sel = wg.state.selection, touchesSel = from <= sel.to && to >= sel.from
      if (read) wg.dispatch({
        changes: {from, to, insert: read.slice, fit: read.context},
        selection: touchesSel ? (cx, changes) => {
          return GardSelection.near(cx, changes.mapPos(to, 1), -1)
        } : undefined,
        scrollIntoView: touchesSel,
        userEvent: "insert.replacementText"
      })
    } else if (type == "insertCompositionText") {
      let compositionStart = !wg.inputState.composing!.changes
      wg.inputState.composing!.changes++
      let sel = wg.observer.selectionRange
      if (!sel.focusNode) return false
      let userEvent = "input.type.compose" + (compositionStart ? ".start" : "")
      Command.dispatch(wg, insertText, {from: range!.from, to: range!.to, insert: event.data!, userEvent})
    } else if (type == "formatSetBlockTextDirection") {
      if (event.data == "ltr" || event.data == "rtl")
        Command.dispatch(wg, setDirection, event.data)
    }
  }

  // Add a given DOM change (as made by an input event) to the tracked
  // DOM state. If there's a pending transaction that matches the
  // change, map `this._domMapping` and drop both. Otherwise, put the
  // inverse of this change at the start of `_domMapping`.
  addDOMChange(change: ChangeSet) {
    let {pending} = this.wg.viewState, {domDoc} = this
    try {
      this.domDoc = change.apply(domDoc)
    } catch (e) {
      if (!(e instanceof ValidationError)) throw e
      // Generated an invalid change from an input event. Force an
      // early flush.
      this.wg.flush()
      return
    }
    this.domChanges = this.domChanges ? this.domChanges.compose(change) : change
    while (this.domMappingIndex < pending.length) {
      let next = pending[this.domMappingIndex]
      if (!next.docChanged) {
        this.domMappingIndex++
      } else {
        let {a: mapping, b: expected} = ChangeSet.transform(domDoc, this._domMapping, change)
        if (next.changes.sections.length != expected.sections.length ||
            next.changes.sections.some((v, i) => v != expected.sections[i]))
          break
        this.domMappingIndex++
        this._domMapping = mapping
        return
      }
    }
    this._domMapping = change.invert(domDoc).compose(this._domMapping)
  }

  findComposition(prev: Text | null): Text | null {
    let {focusNode, focusOffset} = this.wg.observer.selectionRange
    if (!focusNode) return null
    let before = textNodeBefore(focusNode, focusOffset), after = textNodeAfter(focusNode, focusOffset)
    if (!before || !after || before == after) {
      return before || after
    } else {
      let tileBefore = Tile.get(before), tileAfter = Tile.get(after)
      return !tileBefore || (tileBefore as any).text != before.nodeValue ? before
        : !tileAfter || (tileAfter as any).text != after.nodeValue ? after
        : prev == after ? after : before
    }
  }

  connect() {
    this.ensureHandlers(this.wg.state)
  }

  disconnect() {
    if (this.mouseSelection) this.mouseSelection.disconnect()
  }
}

function isSingleChar(doc: Plot.Doc, from: number, to: number) {
  if (to > from + 10) return false
  let after = doc.resolve(from).nodeAfter
  return !!after && after.is(Leaf.Text) && from + findClusterBreak(after.param, 0) == to
}

function inlineContext(doc: Plot.Doc, range: {from: number, to: number}) {
  let from = doc.resolve(range.from), to = doc.resolve(range.to)
  return from.parent.node.inlineContent && to.parent.start == from.parent.start
}

type HandlerFunction = (wg: Wordgard, event: Event) => boolean | void

function bindHandler(
  handler: (event: Event, wg: Wordgard) => boolean | void
): HandlerFunction {
  return (wg, event) => {
    try { return handler(event, wg) }
    catch (e) { logException(wg.state, e) }
  }
}

function computeHandlers(state: GardState) {
  let result: {[event: string]: {
    observers: HandlerFunction[],
    handlers: HandlerFunction[]
  }} = Object.create(null)
  function record(type: string) {
    return result[type] || (result[type] = {observers: [], handlers: []})
  }
  let h = state.facet(eventHandler), o = state.facet(eventObserver)
  for (let type in h) for (let handler of h[type]) record(type).handlers.push(bindHandler(handler))
  for (let type in o) for (let observer of o[type]) record(type).observers.push(bindHandler(observer))
  for (let type in baseHandlers) record(type).handlers.push((baseHandlers as any)[type])
  for (let type in baseObservers) record(type).observers.push((baseObservers as any)[type])
  return result
}

// Key codes for modifier keys
export const modifierCodes = [16, 17, 18, 20, 91, 92, 224, 225]

const dragScrollMargin = 6

export const mouseSelectionStyle = GardState.Facet.define<MakeSelectionStyle>()

export type MakeSelectionStyle = (wg: Wordgard, event: MouseEvent) => Wordgard.MouseSelectionStyle | null

function dragScrollSpeed(dist: number) {
  return Math.max(0, dist) * 0.7 + 8
}

function dist(a: MouseEvent, b: MouseEvent) {
  return Math.max(Math.abs(a.clientX - b.clientX), Math.abs(a.clientY - b.clientY))
}

class MouseSelection {
  dragging: null | boolean
  extend: boolean
  lastEvent: MouseEvent
  scrollParents: {x?: HTMLElement, y?: HTMLElement}
  scrollSpeed = {x: 0, y: 0}
  scrolling = -1

  constructor(private wg: Wordgard,
              private startEvent: MouseEvent,
              private style: Wordgard.MouseSelectionStyle,
              private mustSelect: boolean) {
    this.lastEvent = startEvent
    this.scrollParents = scrollableParents(wg.contentDOM)
    let doc = wg.contentDOM.ownerDocument!
    doc.addEventListener("mousemove", this.move = this.move.bind(this))
    doc.addEventListener("mouseup", this.up = this.up.bind(this))

    this.extend = startEvent.shiftKey
    this.dragging = isInPrimarySelection(wg, startEvent) && startEvent.detail == 1 ? null : false
  }

  start(event: MouseEvent) {
    // When clicking outside of the selection, immediately apply the
    // effect of starting the selection
    if (this.dragging === false) this.select(event)
  }

  move(event: MouseEvent) {
    if (event.buttons == 0) return this.disconnect()
    if (this.dragging || this.dragging == null && dist(this.startEvent, event) < 10) return
    this.select(this.lastEvent = event)

    let sx = 0, sy = 0
    let left = 0, top = 0, right = this.wg.win.innerWidth, bottom = this.wg.win.innerHeight
    if (this.scrollParents.x) ({left, right} = this.scrollParents.x.getBoundingClientRect())
    if (this.scrollParents.y) ({top, bottom} = this.scrollParents.y.getBoundingClientRect())
    let margins = this.wg.getScrollMargins()

    if (event.clientX - margins.left <= left + dragScrollMargin)
      sx = -dragScrollSpeed(left - event.clientX)
    else if (event.clientX + margins.right >= right - dragScrollMargin)
      sx = dragScrollSpeed(event.clientX - right)
    if (event.clientY - margins.top <= top + dragScrollMargin)
      sy = -dragScrollSpeed(top - event.clientY)
    else if (event.clientY + margins.bottom >= bottom - dragScrollMargin)
      sy = dragScrollSpeed(event.clientY - bottom)
    this.setScrollSpeed(sx, sy)
  }

  up(event: MouseEvent) {
    if (this.dragging == null) this.select(this.lastEvent)
    if (!this.dragging) event.preventDefault()
    this.disconnect()
  }

  disconnect() {
    this.setScrollSpeed(0, 0)
    let doc = this.wg.dom.ownerDocument
    doc.removeEventListener("mousemove", this.move)
    doc.removeEventListener("mouseup", this.up)
    this.wg.inputState.mouseSelection = this.wg.inputState.draggedContent = null
  }

  setScrollSpeed(sx: number, sy: number) {
    this.scrollSpeed = {x: sx, y: sy}
    if (sx || sy) {
      if (this.scrolling < 0) this.scrolling = setInterval(() => this.scroll(), 50)
    } else if (this.scrolling > -1) {
      clearInterval(this.scrolling)
      this.scrolling = -1
    }
  }

  scroll() {
    let {x, y} = this.scrollSpeed
    if (x && this.scrollParents.x) {
      this.scrollParents.x.scrollLeft += x
      x = 0
    }
    if (y && this.scrollParents.y) {
      this.scrollParents.y.scrollTop += y
      y = 0
    }
    if (x || y) this.wg.win.scrollBy(x, y)
    if (this.dragging === false) this.select(this.lastEvent)
  }

  select(event: MouseEvent) {
    let {wg} = this, selection = this.style.get(event, this.extend)
    if (this.mustSelect || !selection.eqPos(wg.state.selection))
      this.wg.dispatch({
        selection,
        userEvent: "select.pointer"
      })
    this.mustSelect = false
  }

  update(update: Wordgard.Update) {
    if (update.transactions.some(tr => tr.isUserEvent("input.type")))
      this.disconnect()
    else if (this.style.update(update))
      setTimeout(() => this.select(this.lastEvent), 20)
  }
}

export const dragBehavior = GardState.Facet.define<(event: MouseEvent) => boolean>()

function dragMovesSelection(wg: Wordgard, event: MouseEvent) {
  let facet = wg.state.facet(dragBehavior)
  return facet.length ? facet[0](event) : browser.mac ? !event.altKey : !event.ctrlKey
}

function isInPrimarySelection(wg: Wordgard, event: MouseEvent) {
  let {selection} = wg.state
  if (selection.empty) return false
  // On boundary clicks, check whether the coordinates are inside the
  // selection's client rectangles
  let sel = getSelection(wg.root)
  if (!sel || sel.rangeCount == 0) return true
  let rects = sel.getRangeAt(0).getClientRects()
  for (let i = 0; i < rects.length; i++) {
    let rect = rects[i]
    if (rect.left <= event.clientX && rect.right >= event.clientX &&
      rect.top <= event.clientY && rect.bottom >= event.clientY) return true
  }
  return false
}

const focusEvents = new Set(["input", "beforeinput", "keydown", "keyup", "keypress", "copy", "cut", "paste"])

function eventBelongsToEditor(wg: Wordgard, event: Event): boolean {
  if (event.defaultPrevented) return false
  if (!event.bubbles) return true
  let active = wg.root.activeElement
  for (let node = event.target as DOMNode | null, tile; node != wg.contentDOM; node = node.parentNode)
    if (!node || node.nodeType == 11 ||
        (tile = Tile.get(node)) && tile.ignoreEvent(event) ||
        node == active && focusEvents.has(event.type))
      return false
  return true
}

function queryPos(wg: Wordgard, event: MouseEvent) {
  return wg.posAtCoords({x: event.clientX, y: event.clientY}) as CoordPos
}

function rangeForClick(wg: Wordgard, pos: CoordPos, type: number): GardSelection {
  if (type < 3 && pos.target != null) {
    let target = wg.state.doc.nodeAt(pos.target)
    if (target && target.type.isSelectable && wg.state.isAtom(target.type))
      return GardSelection.node(pos.target, target)
  }
  if (type == 1) { // Single click
    return GardSelection.near(wg.state, pos.pos, pos.side || -1)
  } else if (type == 2) { // Double click
    return wg.state.wordAt(pos.pos, pos.side || 1)
  } else { // Triple click
    let cx = wg.state.doc.resolve(pos.pos), block = cx.textblockParent
    if (block) return GardSelection.range(block.start, block.end)
    else return GardSelection.near(wg.state, pos.pos, pos.side || -1)
  }
}

function basicMouseSelection(wg: Wordgard, event: MouseEvent) {
  let start = queryPos(wg, event), type = event.detail
  let startSel = wg.state.selection
  return {
    update(update) {
      if (update.docChanged) {
        start = start.map(update.changes)
        startSel = startSel.map(update.changes, update.state)
      }
    },
    get(event, extend) {
      let cur = queryPos(wg, event), range = rangeForClick(wg, cur, type), {from, to} = range
      if (extend) {
        if (from < startSel.anchor)
          return GardSelection.range(startSel.anchor, from, from < to ? 1 : cur.side)
        else
          return GardSelection.range(startSel.anchor, to, from < to ? -1 : cur.side)
      }
      if (start.pos != cur.pos) {
        let startRange = rangeForClick(wg, start, type)
        from = Math.min(startRange.from, from)
        to = Math.max(startRange.to, to)
      }
      return from == range.from && to == range.to ? range : GardSelection.range(from, to, cur.side)
    }
  } as Wordgard.MouseSelectionStyle
}

export const dropHandler = GardState.Facet.define<(
  wg: Wordgard,
  event: DragEvent,
  pos: number,
  move: {from: number, to: number} | null,
  slice: Slice,
  context: readonly Plot.Tag[]
) => boolean>()

export const pasteHandler = GardState.Facet.define<(
  wg: Wordgard,
  event: ClipboardEvent,
  slice: Slice,
  context: readonly Plot.Tag[]
) => boolean>()

function selectionSlice(state: GardState) {
  return {
    slice: state.doc.slice(state.selection.from, state.selection.to),
    context: state.doc.contextAt(state.selection.from)
  }
}

function copy(wg: Wordgard, event: ClipboardEvent) {
  let {state} = wg
  if (!state.selection.empty && event.clipboardData) { // FIXME block-wise copying
    let {slice, context} = selectionSlice(state)
    writeClipboard(state, slice, context, event.clipboardData)
    if (event.type == "cut" && !state.readOnly)
      wg.dispatch({
        changes: state.selection.ranges.map(r => ({from: r.from, to: r.to, fit: true})),
        selection: (cx, changes) => GardSelection.near(cx, changes.mapPos(state.selection.from, -1), 1),
        scrollIntoView: true,
        userEvent: "delete.cut"
      })
  }
  return true
}

export const isFocusChange = Transaction.Annotation.define<boolean>()

function updateForFocusChange(wg: Wordgard) {
  setTimeout(() => {
    let focus = wg.hasFocus
    if (focus != wg.inputState.notifiedFocused) {
      wg.inputState.notifiedFocused = focus
      wg.dispatch({annotations: isFocusChange.of(focus)})
    }
  }, 10)
}

export type CompositionInfo = {
  fromB: number, toB: number,
  text: string,
  target: Text | null,
  wrapCursor?: Mark.Set | null
}

export function getCompositionInfo(wg: Wordgard): CompositionInfo | null {
  let wrap = wg.inputState.wrappingComposition
  if (wrap) {
    let sel = wg.state.selection.head
    return {
      fromB: sel, toB: sel,
      text: "",
      target: null,
      wrapCursor: wrap
    }
  }

  let comp = wg.inputState.composing
  if (!comp || !(comp.target = wg.inputState.findComposition(comp.target))) return null
  let value = comp.target.nodeValue!
  let pos = wg.inputState.posAtDOM(comp.target, 0)
  return {
    fromB: pos, toB: pos + value.length,
    text: value,
    target: comp.target
  }
}

function compositionEnd(wg: Wordgard) {
  let comp = wg.inputState.composing
  wg.inputState.composing = null
  wg.inputState.compositionEndedAt = Date.now()
  if (comp && comp.target) {
    let pos = wg.inputState.posAtDOM(comp.target, 0)
    wg.observer.addDirtyRange(pos, pos + comp.target.nodeValue!.length)
    wg.flush()
  }
}

function compositionUpdate(wg: Wordgard, event: CompositionEvent) {
  LOG_input && console.log(event.type, !!wg.inputState.composing)
  if (!wg.inputState.composing) {
    wg.inputState.composing = {changes: 0, target: null}

    let wrap: Mark.Set | null = null
    if (!wg.inputState.composing.changes && !event.data) {
      let sel = wg.state.selection, rSel = wg.state.sel
      if (sel.empty && (sel instanceof GardSelection.Text && sel.marks || !rSel.head.inText && rSel.head.index) &&
        !eqArray(rSel.head.nodeBefore?.tag.marks, rSel.activeMarks))
        wrap = rSel.activeMarks
    }

    if (wrap) try {
      wg.inputState.wrappingComposition = wrap
      wg.flush()
    } finally { wg.inputState.wrappingComposition = null }
  }
}

function isDeletionInputEvent(type: string) { return /^delete(Content|Word)/.test(type) }

const inputTypeCommands: {[inputType: string]: Command.Bound | Command} = {
  historyUndo: undo,
  historyRedo: redo,
  insertLineBreak: insertLineBreak,
  insertParagraph: enter,
  deleteContentBackward: Command.bind(deleteUnit, "backward"),
  deleteContentForward: Command.bind(deleteUnit, "forward"),
  deleteWordBackward: Command.bind(deleteWord, "backward"),
  deleteWordForward: Command.bind(deleteWord, "forward"),
  deleteSoftLineBackward: Command.bind(deleteToLineEnd, "backward"),
  deleteSoftLineForward: Command.bind(deleteToLineEnd, "forward"),
  deleteHardLineBackward: Command.bind(deleteToLineEnd, "backward"),
  deleteHardLineForward: Command.bind(deleteToLineEnd, "forward"),
  deleteContent: wg => {
    let tr = deleteSelection(wg.state)
    if (tr) wg.dispatch(tr)
    return !!tr
  },
  insertTranspose: transposeChars,
  deleteEntireSoftLine: deleteLine,
  formatBold: toggleStrong,
  formatItalic: toggleEmphasis,
  formatUnderline: toggleUnderline,
  formatJustifyCenter: Command.bind(setAlignment, "center"),
  formatJustifyLeft: Command.bind(setAlignment, "left"),
  formatJustifyRight: Command.bind(setAlignment, "right")
}

const baseHandlers: {[e in keyof HTMLElementEventMap]?: (wg: Wordgard, event: HTMLElementEventMap[e]) => boolean} = {
  keydown(wg, event) {
    if ((browser.ios || browser.android) && (event.key == "Backspace" || event.key == "Enter")) return false
    return KeyBinding.runScopeHandlers(wg, event, "editor")
  },

  mousedown(wg, event) {
    wg.inputState.shiftKey = event.shiftKey
    if (wg.inputState.lastTouchTime > Date.now() - 500 || // Ignore touch interaction
        !wg.focusable) return false
    let style: Wordgard.MouseSelectionStyle | null = null
    for (let makeStyle of wg.state.facet(mouseSelectionStyle)) {
      style = makeStyle(wg, event)
      if (style) break
    }
    if (!style && event.button == 0) style = basicMouseSelection(wg, event)
    if (style) {
      let mustFocus = !wg.hasFocus
      wg.inputState.startMouseSelection(new MouseSelection(wg, event, style, mustFocus))
      if (mustFocus) wg.observer.ignore(() => {
        // FIXME on Firefox this somehow focuses the cell selection
        wg.contentDOM.focus({preventScroll: true})
        let active = wg.root.activeElement
        if (active && !active.contains(wg.contentDOM)) (active as HTMLElement).blur()
      })
      let mouseSel = wg.inputState.mouseSelection
      if (mouseSel) {
        mouseSel.start(event)
        return mouseSel.dragging === false
      }
    }
    return false
  },

  dragstart(wg, event) {
    let {selection} = wg.state
    let {inputState} = wg
    if (inputState.mouseSelection) inputState.mouseSelection.dragging = true
    inputState.draggedContent = selection

    if (event.dataTransfer) {
      let {slice, context} = selectionSlice(wg.state)
      writeClipboard(wg.state, slice, context, event.dataTransfer)
      event.dataTransfer.effectAllowed = "copyMove"
    }
    return false
  },

  dragend(wg) {
    wg.inputState.draggedContent = null
    return false
  },
  
  copy,
  cut: copy,

  drop(wg, event) {
    if (!event.dataTransfer || wg.state.readOnly) return true
    let content = readClipboard(wg.state, event.dataTransfer, wg.state.sel.head, false)
    if (!content) return false

    let dropPos = wg.posAtCoords({x: event.clientX, y: event.clientY}).pos
    let {draggedContent} = wg.inputState
    let del = draggedContent && dragMovesSelection(wg, event)
      ? {from: draggedContent.from, to: draggedContent.to} : null
    if (wg.state.facet(dropHandler).some(f => f(wg, event, dropPos, del, content.slice, content.context)))
      return true
    let ins = {from: dropPos, insert: content.slice, fit: content.context}
    let changes = ChangeSet.create(wg.state.doc, del ? [del, ins] : ins)
    wg.focus()
    wg.dispatch({
      changes,
      selection: GardSelection.range(changes.mapPos(dropPos, -1), changes.mapPos(dropPos, 1)),
      userEvent: del ? "move.drop" : "input.drop"
    })
    wg.inputState.draggedContent = null
    return true
  },

  paste(wg, event) {
    if (wg.state.readOnly || !event.clipboardData) return true
    let {state} = wg
    let content = readClipboard(state, event.clipboardData, state.sel.head, wg.inputState.shiftKey)
    if (wg.state.facet(pasteHandler).some(h => h(wg, event, content ? content.slice : Slice.empty,
                                                 content ? content.context : [])))
      return true
    if (content) { // FIXME proper multi-selection pasting
      wg.dispatch({
        changes: {
          from: state.selection.from,
          to: state.selection.to,
          insert: content.slice,
          fit: content.context
        },
        selection: (cx, changes) => GardSelection.near(cx, changes.mapPos(state.selection.to, 1), -1),
        userEvent: "input.paste",
        scrollIntoView: true
      })
    }
    return true
  },

  beforeinput(wg, event) {
    let type = event.inputType
    // Safari will occasionally forget to fire compositionend at the end of a dead-key composition
    if (browser.safari && type == "insertText" && wg.inputState.composing) compositionEnd(wg)
    if (type == "insertCompositionText" && !wg.inputState.composing)
      wg.inputState.composing = {changes: 0, target: null}

    let data: InputEventData = {
      inputType: type,
      data: event.data,
      domRange: null,
    }
    let ranges = event.getTargetRanges()
    if (ranges.length) {
      let r = ranges[0]
      data.domRange = {from: wg.inputState.getDOMPos(r.startContainer, r.startOffset),
                       to: wg.inputState.getDOMPos(r.endContainer, r.endOffset)}
    }
    wg.inputState.beforeInput(event, wg.inputState.pendingInputEvent = data)
    wg.scheduleFlush()
    // Composition cannot be canceled. Also let through simple
    // insertion and deletion to avoid confusing virtual keyboards and
    // Safari autocapitalize.
    let allow = type == "insertCompositionText" ||
      (type == "insertText" || isDeletionInputEvent(type) &&
       data.domRange && inlineContext(wg.inputState.domDoc, data.domRange))
    LOG_input && console.log(`beforeinput ${data.inputType} ${data.domRange ? data.domRange.from + "-" + data.domRange.to : ""} ${
      data.data ? JSON.stringify(data.data) : ""}, allow=${allow}`)
    return !allow
  },

  input(wg, event) {
    let pending = wg.inputState.pendingInputEvent
    LOG_input && console.log(`input ${event.inputType}${pending && pending.inputType == event.inputType ? "" : " (missing)"}`)
    if (!pending || pending.inputType != event.inputType || !pending.domRange) return false
    wg.inputState.pendingInputEvent = null
    let change: ChangeSet.Change | undefined
    if (event.inputType == "insertCompositionText" || event.inputType == "insertText") {
      change = {from: pending.domRange.from, to: pending.domRange.to, insert: [Leaf.text(pending.data!)]}
    } else if (isDeletionInputEvent(event.inputType)) {
      change = {from: pending.domRange.from, to: pending.domRange.to}
    } else {
      return false
    }
    wg.inputState.addDOMChange(ChangeSet.create(wg.inputState.domDoc, change))
    return false
  }
}

const baseObservers: {[e in keyof HTMLElementEventMap]?: (wg: Wordgard, event: HTMLElementEventMap[e]) => void} = {
  scroll(wg) {
    wg.inputState.lastScrollTop = wg.scrollDOM.scrollTop
    wg.inputState.lastScrollLeft = wg.scrollDOM.scrollLeft
  },

  touchstart(wg, e) {
    wg.inputState.lastTouchTime = Date.now()
  },

  touchmove(wg) {
    wg.inputState.lastTouchTime = Date.now()
  },

  focus(wg) {
    // When focusing reset the scroll position, move it back to where it was
    if (!wg.scrollDOM.scrollTop && (wg.inputState.lastScrollTop || wg.inputState.lastScrollLeft)) {
      wg.scrollDOM.scrollTop = wg.inputState.lastScrollTop
      wg.scrollDOM.scrollLeft = wg.inputState.lastScrollLeft
    }
    updateForFocusChange(wg)
  },

  blur(wg) {
    wg.observer.clearSelectionRange()
    updateForFocusChange(wg)
  },

  compositionstart: compositionUpdate,
  compositionupdate: compositionUpdate,

  compositionend(wg) {
    LOG_input && console.log("compositionend", !!wg.inputState.composing)
    compositionEnd(wg)
  },

  contextmenu(wg) {
    wg.inputState.lastContextMenu = Date.now()
  }
}
