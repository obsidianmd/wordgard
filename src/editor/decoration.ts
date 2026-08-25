import {GardState, GardSelection} from "wordgard/state"
import {Mark, Pos, Plot, Leaf, Node, ChangeSet, Schema, Elt, Attributes} from "wordgard/doc"
import {addSection, Changes, addUpdated} from "./changes"
import {type Wordgard} from "./editor"
import {findAbove} from "./util"

/// A widget describes a piece of DOM content that can be used to
/// render a node, a part of a node, or an extra element added via a
/// decoration. The `Widget` object is separate from its DOM
/// representation. It describes how the DOM widget is to be rendered
/// and how it behaves, but it itself is an immutable value.
export class Widget<Param = unknown> {
  private constructor(
    type: Widget.Type<Param>,
    /// The parameter for this widget.
    readonly value: Param
  ) {
    this.type = type as any
  }

  /// @internal
  static new<Param>(type: Widget.Type<Param>, value: Param) { return new Widget(type, value) }

  /// Compare this widget to another widget object.
  eq(other: any) {
    return other instanceof Widget && other.type == this.type && this.type.eq(this.value as any, other.value)
  }

  /// Define a widget type.
  static define<Param>(spec: Widget.Spec<Param>) {
    return Widget.Type.new(spec)
  }

  /// Create a singleton widget.
  static create(spec: Widget.Spec<null>) {
    return Widget.Type.new<null>(spec).of(null)
  }

  /// This widget's type. The type mangling is a kludge to make sure
  /// `Widget<Param>` is a subtype of `Widget<unknown>`.
  readonly type: Widget.Type<unknown extends Param ? any : Param>

  /// @internal
  render(wg: Wordgard) {
    return this.type.render(this.value, wg)
  }

  /// @internal
  get hasContent() { return false }
}

export namespace Widget {
  /// Specifies a widget type.
  export type Spec<Param> = {
    /// How to render the widget as DOM content.
    render: (value: Param, wg: Wordgard) => Element | Text
    /// Compare the widget value for equality. Will default to `===`.
    eq?: (a: Param, b: Param) => boolean
    /// Called when a widget of this type is added to an editor that
    /// is connected to a DOM document, or an editor with the widget
    /// in it is connected.
    connect?: (value: Param, dom: Element | Text) => void
    /// Called when a widget of this type is removed from an editor
    /// that is connected to a document, or when the editor containing
    /// the widget is disconnected.
    disconnect?: (value: Param, dom: Element | Text) => void
    /// Used to determine whether events originating from the widget's
    /// DOM should ignored by the editor. `false` or a function that
    /// returns `false` for the event will prevent the editor's
    /// regular event handling for the event.
    propagateEvent?: boolean | ((event: Event) => boolean)
    /// Set this to false for widgets that either aren't visible or
    /// are positioned outside of the regular document flow.
    inFlow?: boolean
    /// By default, widgets are set to be ineditable. Set this to
    /// `true` to suppress that.
    editable?: boolean
  }

  /// Each widget has an associated type that describes how it
  /// behaves.
  export class Type<Param> {
    private constructor(
      /// @internal
      readonly render: (value: Param, wg: Wordgard) => Element | Text,
      /// @internal
      readonly eq: (a: Param, b: Param) => boolean,
      /// @internal
      readonly propagateEvent: (event: Event) => boolean,
      /// @internal
      readonly connect: ((value: Param, dom: Element | Text) => void) | null,
      /// @internal
      readonly disconnect: ((value: Param, dom: Element | Text) => void) | null,
      /// @internal
      readonly inFlow: boolean,
      /// @internal
      readonly editable: boolean
    ) {}

    /// @internal
    static new<Param>(spec: Widget.Spec<Param>) {
      let prop = spec.propagateEvent
      let propEvent = typeof prop == "function" ? prop : prop == null ? () => true : () => prop
      return new Type(spec.render, spec.eq || ((a, b) => a === b),
                      propEvent,
                      spec.connect ?? null, spec.disconnect ?? null,
                      spec.inFlow !== false,
                      spec.editable === true)
    }

    /// Create an instance of this widget type.
    of(value: Param) { return Widget.new(this, value) }
  }

  /// @internal
  export const Text = Widget.define<string>({
    render: s => document.createTextNode(s)
  })

  /// @internal
  export const EditableText = Widget.define<string>({
    render: s => document.createTextNode(s)
  })

  /// @internal
  export const img = Widget.create({
    render() {
      let img = document.createElement("img")
      img.className = "wg-buffer"
      return img
    },
    editable: true
  })

  /// @internal
  export const br = Widget.create({
    render() { return document.createElement("br") },
    editable: true
  })
}

export type DecoElt = Elt<Widget | string>

export namespace Decoration {
  /// Node shapes can be either a widget or an element which may
  /// contain widgets.
  export type Shape = Widget | DecoElt

  // FIXME support mark shape overrides
  export namespace Tag {
    /// Override the way a given node type is drawn in the editor. By
    /// default, the {@link doc.Node.Spec.shape `shape`} field in the
    /// type's definition will be used, but extensions created with
    /// this function can provide an alternative shape for a given
    /// type.
    ///
    /// When providing a function for the shape, keep in mind that the
    /// result will be cached by tag, and you should make sure your
    /// function is pure.
    ///
    /// When providing a function that returns a shape that changes
    /// whether the node is rendered as an atom, you need to provide
    /// the `atom`.
    export function shape<T extends Node.Type.Ref<any>>(
      type: T,
      shape: Shape | ((tag: Node.Tag.For<T>) => Shape),
      config?: {atom?: boolean}
    ) {
      let tp = Node.Type.get(type)
      let shapeFunc: (tag: Node.Tag) => Shape = typeof shape == "function"
        ? tag => addMarkAttributes(shape(tag as any), tag)
        : tag => addMarkAttributes(shape, tag)
      let atom = typeof shape == "function" ? config?.atom : !shape.hasContent
      let ext: GardState.Extension = tagShape.of({type: tp, shape: memo(shapeFunc)})
      if (tp.isPlot && atom != null) ext = [ext, GardState.isAtom.of([tp, atom])]
      return ext
    }

    export namespace shape {
      /// This function allows you to define a {@link Decoration.Tag.shape
      /// custom node shape} that depends on the editor state. It will
      /// automatically track what slots (see {@link
      /// GardState.Facet.compute}) you use, and make sure the nodes
      /// are redrawn when those change.
      ///
      /// If your shape function returns a function from a tag, you
      /// must be careful do any state access you need in the _outer_
      /// function, not the returned function, or it won't be tracked.
      ///
      /// You generally don't want to make your shapes depend on
      /// constantly-changing slots like the document or selection,
      /// because when the document is big, there's a non-trivial
      /// amount of work involved when a node shape changes (or may
      /// have changed).
      ///
      /// When providing a shape for a plot that changes whether it is
      /// rendered as an atom, provide the `atom` option.
      export function dynamic<T extends Node.Type<any>>( // FIXME find better name?
        type: T,
        shape: (state: GardState) => Shape | ((tag: Node.Tag.For<T>) => Shape),
        config?: {atom?: boolean}
      ) {
        let tp = Node.Type.get(type)
        let ext = tagShape.compute(state => {
          let s = shape(state)
          return {type: tp, shape: typeof s == "function" ? memo(s as any) : () => s}
        })
        let atom = config?.atom
        if (tp.isPlot && atom != null) ext = [ext, GardState.isAtom.of([tp, atom])]
        return ext
      }
    }

    /// Define a wrapper to be added around a given node type, or some
    /// part of it. The given elt should include a hole (`0`) to
    /// indicate where the original shape goes.
    ///
    /// If a `target` option is given, and matching some element in
    /// the node's existing shape, only that element will be wrapped.
    /// Uses a subset of CSS selectors that supports only tag name and
    /// class names (`img.x.y`).
    export function wrapper(type: Node.Type.Ref<any>, wrapper: DecoElt, options?: {
      target?: string
    }) {
      if (!wrapper.hasContent) throw new Error("Wrapper elements should have a content hole")
      return tagWrapper.of({
        type: Node.Type.get(type),
        elt: wrapper,
        target: options && options.target ? Elt.Selector.parse(options.target) : null
      })
    }

    function getPlace(place: "before" | "after" | "start" | "end") {
      return place == "before" ? WidgetPlace.Before : place == "after" ? WidgetPlace.After
        : place == "end" ? WidgetPlace.End : WidgetPlace.Start
    }

    /// Add a widget to every instance of the given node type. Such
    /// widgets can appear before or after the node, and for plots
    /// that aren't rendered as atoms, at its start or end.
    ///
    /// When a function, `widget` will be cached by tag, and should be
    /// pure.
    export function widget<T extends Node.Type.Ref<any>>(
      type: T,
      place: "before" | "after" | "start" | "end",
      widget: Widget | ((tag: Node.Tag.For<T>) => Widget)
    ) {
      return tagWidget.of({
        type: Node.Type.get(type),
        place: getPlace(place),
        widget: typeof widget == "function" ? memo(widget as any) : widget
      })
    }

    export namespace widget {
      /// Define a node widget decoration that depends on some aspect
      /// of the editor state. See the notes for {@link
      /// Decoration.Tag.shape.dynamic}.
      export function dynamic<T extends Node.Type.Ref<any>>(
        type: T,
        place: "before" | "after" | "start" | "end",
        widget: (state: GardState) => Widget | ((tag: Node.Tag.For<T>) => Widget)
      ) {
        let tp = Node.Type.get(type)
        let p = getPlace(place)
        return tagWidget.compute(state => {
          let w = widget(state)
          return {
            type: tp,
            place: p,
            widget: typeof w == "function" ? memo(w as any) : w
          }
        })
      }
    }

    /// Add an attribute to the representation of a given node type.
    ///
    /// By default, the attribute is added to the outer element (or a
    /// wrapper element if the node is rendered as a widget). If the
    /// `target` option is given, and
    /// [matches](#editor.Decoration.Tag.wrapper.options.target) an
    /// element in the representation, it will be added to that
    /// element instead.
    export function attribute<T extends Node.Type.Ref<any>>(
      type: T,
      attr: string,
      value: string | ((tag: Node.Tag.For<T>) => string),
      options?: {target?: string}
    ) {
      let tp = Node.Type.get(type)
      return tagAttribute.of({type: tp, attr, value: typeof value == "string" ? () => value : value as any,
                              target: options?.target ? Elt.Selector.parse(options.target) : null})
    }
  }

  /// A point decoration is a decoration that targets a given position
  /// in the document, or the node after a given position. Sets of
  /// point decorations can be provided as point sets through {@link
  /// Decoration.Point.source}.
  export abstract class Point implements PointSet.Value {
    /// @internal
    constructor() {}

    abstract eq(other: PointSet.Value): boolean
    abstract side: number
    abstract trackMode: ChangeSet.TrackMode | undefined

    /// Display a widget at this point.
    static widget(widget: Widget, options?: {
      /// Determines where this widget appears relative to the cursor
      /// (negative means before, positive after, zero means to make
      /// it depend on the cursor's own side) and other widgets in the
      /// same position. Defaults to zero.
      side?: number,
      /// What side to track when changes happen around the widget.
      /// The default is to keep the widget around unless the content
      /// on both sides is deleted. You can pass undefined to indicate
      /// the widget should not be deleted by changes, or
      /// `"before"`/`"after"` to use one specific side.
      trackMode?: ChangeSet.TrackMode | undefined
    }): Point {
      return new WidgetDecoration(widget, options?.side || 0, options && "trackMode" in options ? options.trackMode : "around")
    }

    /// Add a set of attributes to the node after this decoration's
    /// position.
    ///
    /// You can target a [specific
    /// element](#editor.Decoration.Tag.wrapper.options.target) in the
    /// node's representation with the `target` option.
    static attributes(attrs: Record<string, string>, options?: {target?: string}): Point {
      return new AttributeDecoration(Attributes.read(attrs), options?.target ? Elt.Selector.parse(options.target) : null)
    }

    /// Override the shape of the node after the decoration's point
    /// with the given one.
    static shape(shape: Shape): Point {
      return new ShapeDecoration(shape)
    }

    /// Wrap the node, or inner node selected with `target`, at the
    /// given position with a wrapper.
    static wrapper(wrapper: DecoElt, spec?: {target?: string}): Point {
      if (!wrapper.hasContent) throw new Error("Wrapper decoration elements must have a content hole")
      return new WrapperDecoration(wrapper, spec?.target ? Elt.Selector.parse(spec.target) : null)
    }

    /// The facet used to register a point decoration source.
    /// Functions provided in this way will be called on every editor
    /// update, so computing the set on the fly will only perform well
    /// for very simple decoration sets, and you'll usually want to
    /// keep your set in a state field and update it incrementally.
    static source = GardState.Facet.define<(state: GardState) => PointSet<Point>>({
      combine: sources => sources.concat(nodeSelection)
    })
  }

  /// Range decorations apply to a document range. They are stored in
  /// {@link RangeSet}s and registered in an editor configuration with
  /// {@link Decoration.Range.source}.
  export abstract class Range implements RangeSet.Value {
    /// @internal
    readonly query: Node.Query | null
    /// @internal
    readonly scope: DecorationScope
    /// @internal
    readonly inc: Inc

    /// @hidden
    protected constructor(spec: Decoration.Range.Spec) {
      let {query, inclusive} = spec
      this.query = query || null
      this.scope = spec.scope == "inlineatom" ? DecorationScope.InlineAtom
        : spec.scope == "all" ? DecorationScope.All : DecorationScope.Atom
      this.inc = inclusive === "start" ? Inc.Start : inclusive === "end" ? Inc.End : inclusive ? Inc.Start | Inc.End : Inc.None
    }

    get inclusiveStart() { return (this.inc & Inc.Start) > 0 }
    get inclusiveEnd() { return (this.inc & Inc.End) > 0 }

    abstract eq(other: RangeSet.Value): boolean

    /// Create a range decoration that wraps nodes in a range with
    /// an element, using the given tag name.
    static wrapper(tagName: string, spec: Decoration.Range.WrapperSpec): Range {
      return new WrapperRangeDecoration(tagName, spec)
    }

    /// Create a range decoration that adds an attribute to nodes in a
    /// range.
    static attribute(attr: string, value: string, options: Decoration.Range.Spec = {}): Range {
      return new AttributeRangeDecoration(attr, value, options)
    }

    /// The facet used to register range decoration sources. The
    /// source function will be called on every update. Generating big
    /// range sets on the fly will not perform well, so you'll often
    /// want to store these in a state field.
    static source = GardState.Facet.define<(state: GardState) => RangeSet<Range>>()
  }

  export namespace Range {
    /// Configuration object for range decorations.
    export interface Spec {
      /// Determines whether content inserted next to the range is
      /// included when mapping the range through a change. Defaults
      /// to false.
      inclusive?: boolean | "start" | "end"
      /// If given, apply this decoration only to matching nodes.
      query?: Node.Query
      /// The type of nodes in the range to apply the decoration to.
      /// Defaults to `"atom"`.
      scope?: "atom" | "inlineatom" | "all"
    }

    /// Configuration object for wrapper range decorations.
    export interface WrapperSpec extends Decoration.Range.Spec {
      /// Attributes to add to the wrapper element.
      attributes?: Record<string, string>
      /// A wrapper's rank determines the nesting order between it and
      /// other wrappers created by range decorations or marks. Should be
      /// a number between 0 and 100, if given.
      rank?: number
      /// Whether this wrapper may span multiple sibling nodes.
      /// Non-spanning wrappers will be created separately for each
      /// node. Defaults to true.
      spanning?: boolean
    }
  }
}

type TagShape = {type: Node.Type, shape: (tag: Node.Tag) => Decoration.Shape}

const tagShape = GardState.Facet.define<TagShape>()

type TagWrapper = {type: Node.Type, elt: DecoElt, target: Elt.Selector | null}

const tagWrapper = GardState.Facet.define<TagWrapper>()

const enum WidgetPlace { Before, After, Start, End }

type TagWidget = {type: Node.Type, place: WidgetPlace, widget: Widget | ((tag: Node.Tag) => Widget)}

const tagWidget = GardState.Facet.define<TagWidget>()

type TagAttribute = {
  type: Node.Type,
  attr: string,
  value: (tag: Node.Tag) => string,
  target: Elt.Selector | null
}

const tagAttribute = GardState.Facet.define<TagAttribute>()

function memo<T, A extends Object>(f: (arg: A) => T) {
  let map = new WeakMap<A, T>()
  return (arg: A) => {
    let found = map.get(arg)
    if (found === undefined) map.set(arg, found = f(arg))
    return found
  }
}

function addMarkAttributes(shape: Decoration.Shape, tag: Node.Tag) {
  let attrs: readonly string[] | undefined
  for (let mark of tag.marks) {
    if (mark.type.attribute && (mark.spanning || !tag.isText)) {
      let {get, target} = mark.type.attribute
      let markAttrs = get(mark.value)
      if (markAttrs.length) {
        if (target && shape instanceof Elt) shape = shape.addAttrs(markAttrs, target)
        else attrs = attrs ? Attributes.merge(attrs, markAttrs) : markAttrs
      }
    }
  }
  return attrs ? addAttrs(shape, attrs, tag.type.isInline) : shape
}

function addAttrs(shape: Decoration.Shape, attrs: Attributes, inline: boolean) {
  return shape instanceof Elt ? shape.addAttrs(attrs) : Elt.create(inline ? "span" : "div", attrs, [shape])
}

function applyDeco(shape: Decoration.Shape, deco: Decoration.Point, tag: Node.Tag) {
  if (deco instanceof AttributeDecoration) {
    return deco.selector && shape instanceof Elt ? shape.addAttrs(deco.attrs, deco.selector)
      : addAttrs(shape, deco.attrs, tag.type.isInline)
  } else if (deco instanceof WrapperDecoration) {
    return deco.selector && shape instanceof Elt ? shape.wrap(deco.elt, deco.selector) : deco.elt.fill([shape])
  }
  return shape
}

const baseTagShape = memo((tag: Node.Tag): Decoration.Shape => {
  return addMarkAttributes(tag.is(Leaf.Text) ? Widget.EditableText.of(tag.param as string)
    : tag.type.shape.create(tag.param), tag)
})

export function renderMarks(marks: Mark.Set, around: string) {
  let result = addMarkAttributes(Elt.create("span", Attributes.none, [around]), Leaf.text(around, marks))
  for (let i = marks.length - 1; i >= 0; i--) {
    let mark = marks[i]
    if (mark.type.element) result = renderMarkWrapper(mark).fill([result])
  }
  return (result as Elt<string>).toDOM()
}

const enum DecorationScope {
  Atom = 1,
  InlineAtom = 2,
  All = 4,
}

const enum Inc { None = 0, Start = 1, End = 2 }

class AttributeRangeDecoration extends Decoration.Range {
  constructor(
    readonly attribute: string,
    readonly value: string,
    options: Decoration.Range.Spec
  ) {
    super(options)
  }

  eq(other: RangeSet.Value): boolean {
    return this == other ||
      other instanceof AttributeRangeDecoration && other.attribute == this.attribute && other.value == this.value &&
      other.inc == this.inc
  }
}

class WrapperRangeDecoration extends Decoration.Range {
  readonly elt: Elt
  readonly rank: number
  readonly spanning: boolean

  constructor(element: string, spec: Decoration.Range.WrapperSpec) {
    super(spec)
    let {attributes} = spec
    this.rank = Math.max(0, Math.min(spec.rank ?? 100))
    this.spanning = spec.spanning !== false
    this.elt = Elt.create(element, attributes ? Attributes.read(attributes) : Attributes.none, Elt.hole)
  }

  eq(other: RangeSet.Value): boolean {
    return this == other ||
      other instanceof WrapperRangeDecoration && other.elt.eq(this.elt) &&
      other.rank == this.rank && other.spanning == this.spanning && other.inc == this.inc
  }
}

const enum Side { After = 1e9 }

class ShapeDecoration extends Decoration.Point {
  constructor(readonly shape: Decoration.Shape) { super() }

  eq(other: PointSet.Value): boolean {
    return this == other || other instanceof ShapeDecoration && other.shape.eq(this.shape)
  }

  get trackMode() { return "after" as const }
  get side() { return Side.After }
}

class WidgetDecoration extends Decoration.Point {
  constructor(readonly widget: Widget, readonly side: number, readonly trackMode: ChangeSet.TrackMode | undefined) {
    super()
    if (side >= Side.After) throw new Error("Invalid widget side")
  }

  eq(other: PointSet.Value): boolean {
    return this == other || other instanceof WidgetDecoration && other.widget.eq(this.widget) &&
      other.side == this.side && other.trackMode == this.trackMode
  }
}

function selectorEq(a: Elt.Selector | null, b: Elt.Selector | null) {
  return a ? !!b && a.eq(b) : !b
}

class AttributeDecoration extends Decoration.Point {
  constructor(readonly attrs: Attributes, readonly selector: Elt.Selector | null) { super() }

  eq(other: PointSet.Value): boolean {
    return this == other || other instanceof AttributeDecoration && Attributes.eq(other.attrs, this.attrs) &&
      selectorEq(other.selector, this.selector)
  }

  get trackMode() { return "after" as const }
  get side() { return Side.After }
}

class WrapperDecoration extends Decoration.Point {
  constructor(readonly elt: DecoElt, readonly selector: Elt.Selector | null) { super() }

  eq(other: PointSet.Value): boolean {
    return this == other || other instanceof WrapperDecoration && other.elt.eq(this.elt) &&
      selectorEq(other.selector, this.selector)
  }

  get trackMode() { return "after" as const }
  get side() { return Side.After }
}

const nodeSelectionDeco = Decoration.Point.attributes({class: "wg-selected-node"})

function nodeSelection(state: GardState) {
  if (state.selection instanceof GardSelection.Node)
    return PointSet.create([[state.selection.from, nodeSelectionDeco]])
  return PointSet.empty
}

const none: readonly any[] = []

/// Data structure used to store sets of points and then track them
/// across document changes. Mostly used for {@link Decoration.Point
/// point decorations}, but can also track your own types, if you make
/// sure they implement the {@link PointSet.Value} interface.
export class PointSet<T extends PointSet.Value = PointSet.Value> {
  private constructor(
    /// The values in this set.
    readonly values: readonly T[],
    /// The positions of the values in this set.
    readonly positions: readonly number[],
  ) {}

  /// The number of points in this set.
  get length() { return this.positions.length }

  /// Adjust the points for a set of document changes. Returns a new
  /// set with the adjusted points. May delete points when the content
  /// around them was deleted.
  map(changes: ChangeSet) {
    if (changes.empty) return this
    let positions = this.positions.slice()
    let pos = 0, i = 0
    let deleted: number[] = [], deletions = 0
    changes.iterGaps((fromA, toA, fromB, _toB, last) => {
      let off = fromB - fromA, end = last ? toA : toA - 1
      if (end > pos) {
        let nextI = findAbove(positions, i, end)
        if (off) for (; i < nextI; i++) positions[i] += off
        else i = nextI
        pos = end
      }
    }, (_fromA, toA, fromB, toB) => {
      let nextI = findAbove(positions, i, toA + 1)
      for (; i < nextI; i++) {
        let mapped = changes.mapPos(positions[i], this.values[i].side < 0 ? -1 : 1, this.values[i].trackMode)
        if (mapped == null) { addDel(deleted, i); deletions++ }
        else positions[i] = mapped
      }
      pos = toA + 1
    })
    if (!deletions) return new PointSet<T>(this.values, positions)
    return new PointSet<T>(applyDel(deleted, deletions, this.values), applyDel(deleted, deletions, positions))
  }

  /// Returns the union of this set and the given set. If
  /// `maskFrom`/`maskTo` are given, drop any points from `this`
  /// between or at those positions.
  merge(other: PointSet<T>, maskFrom?: number, maskTo = maskFrom) {
    if (!this.length) return other
    if (!other.length) return this
    let posA = this.positions, posB = other.positions
    let pos: number[] = new Array((maskFrom == null ? posA.length : 0) + posB.length), values: T[] = new Array(pos.length)
    for (let i = 0, a = 0, b = 0;;) {
      if (a < posA.length && (b == posB.length || (posA[a] - posB[b] || this.values[a].side - other.values[b].side) < 0)) {
        if (maskFrom == null || maskFrom > posA[a] || maskTo! < posA[a]) {
          pos[i] = posA[a]
          values[i++] = this.values[a]
        }
        a++
      } else if (b < posB.length) {
        pos[i] = posB[b]
        values[i++] = other.values[b++]
      } else {
        return new PointSet<T>(values, pos)
      }
    }
  }

  /// @internal
  compareRange(fromA: number, b: PointSet<T>, fromB: number, len: number, change: (pos: number, val: T) => void) {
    let a = this, endB = fromB + len
    if (a != b || fromA != fromB) {
      let iA = findAbove(a.positions, 0, fromA - 1), lA = a.positions.length
      let iB = findAbove(b.positions, 0, fromB - 1), lB = b.positions.length
      let off = fromB - fromA
      let sameVal = a.values == b.values
      for (;;) {
        let nextA = iA < lA ? a.positions[iA] + off : 1e9
        let nextB = iB < lB ? b.positions[iB] : 1e9
        let next = Math.min(nextA, nextB)
        if (next > endB) break
        if (nextA == nextB) {
          if (!sameVal && !a.values[iA].eq(b.values[iB])) change(next, a.values[iA])
          iA++
          iB++
        } else if (nextA < nextB) {
          change(nextA, a.values[iA++])
        } else {
          change(nextB, b.values[iB++])
        }
      }
    }
  }

  /// @internal
  iter(): PointIterator<T> {
    return new PointIterator<T>(this)
  }

  /// Get the value at the given position, if any. If there's multiple
  /// values at that position, the one with the lowest side is
  /// returned.
  at(pos: number): T | undefined {
    let index = findAbove(this.positions, 0, pos - 1)
    return index < this.positions.length && this.positions[index] == pos ? this.values[index] : undefined
  }

  /// Create a point set from an iterable of `[position, value]`
  /// tuples, or a function that calls its argument for every point to
  /// add.
  static create<T extends PointSet.Value>(
    source: Iterable<[number, T]> | ((add: (pos: number, value: T) => void) => void)
  ): PointSet<T> {
    if (typeof source != "function") {
      let array = source
      source = add => { for (let [pos, value] of array) add(pos, value) }
    }
    let positions: number[] = [], values: T[] = [], curPos = -1, curVal: T | undefined
    source((pos: number, value: T) => {
      if (curPos > pos || curPos == pos && curVal!.side > value.side) {
        for (let i = positions.length;;) {
          positions[i] = positions[i - 1]
          values[i] = values[i - 1]
          --i
          if (!i || (positions[i - 1] - pos || values[i - 1].side - value.side) <= 0) {
            positions[i] = pos
            values[i] = value
            break
          }
        }
      } else {
        positions.push(pos)
        values.push(value)
        curPos = pos
        curVal = value
      }
    })
    return new PointSet(values, positions)
  }

  /// The empty point set.
  static empty: PointSet<any> = new PointSet(none, none)
}

export namespace PointSet {
  /// Objects stored in a point set must conform to this interface.
  export interface Value {
    /// The side of the point. Used to provide a sorting of points at
    /// the same position
    side: number
    /// Specifies whether the point should be deleted when content
    /// next to it is deleted. See {@link ChangeSet.mapPos}.
    trackMode: ChangeSet.TrackMode | undefined
    /// Method to compare this value to another.
    eq(other: PointSet.Value): boolean
  }
}

class PointIterator<T extends PointSet.Value> {
  declare value: T | null
  done = false
  declare pos: number
  declare i: number

  constructor(readonly set: PointSet<T>) {
    this.fill(0)
  }

  private fill(i: number) {
    this.i = i
    if (i < this.set.positions.length) {
      this.pos = this.set.positions[i]
      this.value = this.set.values[i]
    } else {
      this.pos = 1e8
      this.value = null
      this.done = true
    }
  }

  next() {
    if (!this.done) this.fill(this.i + 1)
  }

  get side() {
    return this.done ? 1 : this.value!.side
  }

  goto(pos: number, inclusive: boolean) {
    this.done = false
    let i = findAbove(this.set.positions, 0, pos - 1)
    if (!inclusive) {
      while (i < this.set.values.length && this.set.values[i].side < Side.After) i++
    }
    this.fill(i)
  }
}

function addDel(deleted: number[], i: number) {
  let last = deleted.length - 1
  if (last >= 0 && deleted[last] == i) deleted[last] = i + 1
  else deleted.push(i, i + 1)
}

function applyDel<T>(deleted: number[], deletions: number, array: readonly T[]): T[] {
  let result = new Array(array.length - deletions)
  for (let iA = 0, iR = 0, iD = 0;;) {
    let last = iD == deleted.length, from = last ? array.length : deleted[iD++]
    while (iA < from) result[iR++] = array[iA++]
    if (last) return result
    let to = deleted[iD++]
    iA += to - from
  }
}

export type DecoSet = {points: Map<(state: GardState) => PointSet<Decoration.Point>, PointSet<Decoration.Point>>,
                       ranges: Map<(state: GardState) => RangeSet<Decoration.Range>, RangeSet<Decoration.Range>>}

export function getDecoSet(state: GardState) {
  let set: DecoSet = {points: new Map, ranges: new Map}
  for (let src of state.facet(Decoration.Point.source)) set.points.set(src, src(state))
  for (let src of state.facet(Decoration.Range.source)) set.ranges.set(src, src(state))
  return set
}

/// Data structure that stores sets of ranges, for use with {@link
/// Decoration.Range range decorations} or other data types
/// implementing {@link RangeSet.Value}.
export class RangeSet<T extends RangeSet.Value = RangeSet.Value> {
  private constructor(
    /// The value associated with the ranges in the set.
    readonly values: readonly T[],
    /// The start positions of the ranges in this set.
    readonly from: readonly number[],
    /// The end positions of the ranges.
    readonly to: readonly number[],
  ) {}

  /// The number of ranges stored in this set.
  get length() { return this.from.length }

  /// Adjust the positions of the ranges for the given change set.
  /// Returns a set with the updated ranges.
  map(changes: ChangeSet) {
    if (changes.empty || !this.length) return this
    let from = this.from.slice(), to = this.to.slice()
    let pos = 0, i = 0
    let deleted: number[] = [], deletions = 0
    changes.iterGaps((fromA, toA, fromB, _toB, last) => {
      let off = fromB - fromA, end = last ? toA : toA - 1
      if (end > pos) {
        let nextI = findAbove(to, i, end)
        if (off) for (; i < nextI; i++) { from[i] += off; to[i] += off }
        else i = nextI
        pos = end
      }
    }, (_fromA, toA) => {
      let nextI = findAbove(from, i, toA)
      for (; i < nextI; i++) {
        let value = this.values[i]
        let mappedFrom = changes.mapPos(from[i], value.inclusiveStart ? -1 : 1)
        let mappedTo = changes.mapPos(to[i], value.inclusiveEnd ? 1 : -1)
        if (mappedFrom >= mappedTo) { addDel(deleted, i); deletions++ }
        else { from[i] = mappedFrom; to[i] = mappedTo }
      }
      pos = toA + 1
    })
    if (!deletions) return new RangeSet<T>(this.values, from, to)
    return new RangeSet<T>(applyDel(deleted, deletions, this.values),
                           applyDel(deleted, deletions, from),
                           applyDel(deleted, deletions, to))
  }

  /// Merge this set with another set. If `maskFrom`/`maskTo` are
  /// given, any ranges overlapping the masked range in `this` are
  /// not included in the merged set.
  merge(other: RangeSet<T>, maskFrom?: number, maskTo = maskFrom) {
    if (!this.length) return other
    if (!other.length) return this
    let fromA = this.from, fromB = other.from
    let from: number[] = new Array((maskFrom == null ? fromA.length : 0) + fromB.length)
    let to: number[] = new Array(from.length), values: T[] = new Array(from.length)
    for (let i = 0, a = 0, b = 0, at = 0;;) {
      if (a < fromA.length && (b == fromB.length || fromA[a] < fromB[b])) {
        if (maskFrom == null || maskFrom >= this.to[a] || maskTo! <= this.from[a]) {
          if ((from[i] = fromA[a]) < at) throw new Error("Overlapping ranges")
          at = to[i] = this.to[a]
          values[i++] = this.values[a]
        }
        a++
      } else if (b < fromB.length) {
        if ((from[i] = fromB[b]) < at) throw new Error("Overlapping ranges")
        at = to[i] = other.to[b]
        values[i++] = other.values[b++]
      } else {
        return new RangeSet<T>(values, from, to)
      }
    }
  }

  /// @internal
  iter(): RangeIterator<T> {
    return new RangeIterator<T>(this)
  }

  /// @internal
  compareRange(fromA: number, b: RangeSet<T>, fromB: number, len: number, change: (from: number, to: number) => void) {
    let a = this, toB = fromB + len
    if (a != b || fromA != fromB) {
      let iA = findAbove(a.to, 0, fromA - 1), lA = a.from.length
      let iB = findAbove(b.to, 0, fromB - 1), lB = b.from.length
      let off = fromB - fromA
      let sameVals = a.values == b.values
      for (;;) {
        let [startA, endA] = iA < lA ? [a.from[iA] + off, a.to[iA] + off] : [1e9, 1e9]
        let [startB, endB] = iB < lB ? [b.from[iB], b.to[iB]] : [1e9, 1e9]
        let start = Math.min(startA, startB)
        if (start > toB) break
        if (startA == startB) {
          if (endA != endB || !sameVals && !a.values[iA].eq(b.values[iB])) change(start, Math.max(endA, endB))
          iA++
          iB++
        } else if (startA < startB) {
          change(startA, endA)
          iA++
        } else {
          change(startB, endB)
          iB++
        }
      }
    }
  }

  /// Create a range set from an iterable of `[from, to, value]`
  /// tuples, or a function that calls its argument for every range to
  /// add.
  static create<T extends RangeSet.Value>(
    source: Iterable<[number, number, T]> | ((add: (from: number, to: number, value: T) => void) => void)
  ): RangeSet<T> {
    if (typeof source != "function") {
      let array = source
      source = add => { for (let [from, to, value] of array) add(from, to, value) }
    }
    let from: number[] = [], to: number[] = [], values: T[] = [], curPos = -1
    source((f, t, value) => {
      if (f >= t) throw new Error("Ranges cannot be empty")
      if (f < curPos) throw new Error("Ranges must be added in order and cannot overlap")
      from.push(f)
      to.push(t)
      curPos = t
      values.push(value)
    })
    return new RangeSet<T>(values, from, to)
  }

  /// The empty range set.
  static empty: RangeSet<any> = new RangeSet(none, none, none)
}

export namespace RangeSet {
  /// Values stored in a range set must conform to this interface.
  export interface Value {
    /// Whether content inserted at the start of this value's range is
    /// included in the range.
    inclusiveStart: boolean
    /// Whether content inserted at the end is included.
    inclusiveEnd: boolean
    /// Compare this value to another.
    eq(other: Value): boolean
  }
}

class RangeIterator<T extends RangeSet.Value> {
  declare value: T | null
  declare from: number
  declare to: number
  done = false
  declare i: number

  constructor(readonly set: RangeSet<T>) {
    this.fill(0)
  }

  fill(i: number) {
    this.i = i
    if (i < this.set.from.length) {
      this.from = this.set.from[i]
      this.to = this.set.to[i]
      this.value = this.set.values[i]
    } else {
      this.from = this.to = 1e8
      this.value = null
      this.done = true
    }
  }

  next() {
    if (!this.done) this.fill(this.i + 1)
  }

  goto(pos: number) {
    this.done = false
    this.fill(findAbove(this.set.to, 0, pos))
  }
}

function addRange(ranges: number[], from: number, to: number) {
  let last = ranges.length - 1
  if (last < 0 || ranges[last] < from) ranges.push(from, to)
  else ranges[last] = Math.max(to, ranges[last])
}

function joinRanges(ranges: number[][]) {
  if (ranges.length == 1) return ranges[0]
  let result: number[] = [], index = ranges.map(() => 0)
  for (;;) {
    let minI = -1, minFrom = -1
    for (let i = 0; i < ranges.length; i++) {
      let idx = index[i], set = ranges[i]
      if (idx < set.length && (minI < 0 || set[idx] < minFrom)) {
        minI = i
        minFrom = set[idx]
      }
    }
    if (minI < 0) return result
    let idx = index[minI], set = ranges[minI]
    addRange(result, set[idx], set[idx + 1])
    index[minI] += 2
  }
}

function compareDecoSet<T>(setA: Map<(state: GardState) => T, T>, setB: Map<(state: GardState) => T, T>,
                           cmp: (a: T | null, b: T | null) => void) {
  for (let [srcA, valA] of setA) cmp(valA, setB.get(srcA) || null)
  for (let [srcB, valB] of setB) if (!setA.has(srcB)) cmp(null, valB)
}

function compareGlobal(stateA: GardState, stateB: GardState, facet: GardState.Facet<any>) {
  return stateA.facet(facet) != stateB.facet(facet)
}

// Compare ranges and points in decoration facets for unchanged ranges
// in the given change desc. Returns an array using the section format
// used in change descs.
export function findChangedRanges(
  prevState: GardState, prevDeco: DecoSet,
  state: GardState, deco: DecoSet,
  sections: ChangeSet.Sections
): Changes {
  let result: number[] = []
  let globalChange = compareGlobal(prevState, state, tagShape) || compareGlobal(prevState, state, tagWidget) ||
    compareGlobal(prevState, state, tagWrapper) || compareGlobal(prevState, state, tagAttribute)
  // When node shapes change, we need a separate pass to see whether
  // their atomicity changed, and mark a replace for the whole node if
  // it did.
  let shapeChanges: number[] = []
  for (let i = 0, posA = 0, posB = 0; i < sections.length;) {
    let len = sections[i++], ins = sections[i++]
    if (ins == -1 && globalChange) {
      addSection(result, len, -2)
    } else if (ins == -1) {
      let endB = posB + len
      // Unchanged section. See which parts have potentially updated
      // decorations, and tag those as changed
      let cur: number[] = [], curPos = 0, ranges: number[][] = [cur]
      let add = (from: number, to: number) => {
        if (from < curPos) { ranges.push(cur = []); curPos = 0 }
        addRange(cur, from, to)
        curPos = to
      }
      compareDecoSet(prevDeco.ranges, deco.ranges, (a, b) => {
        (a || RangeSet.empty).compareRange(posA, b || RangeSet.empty, posB, len, add)
      })
      compareDecoSet(prevDeco.points, deco.points, (a, b) => {
        (a || PointSet.empty).compareRange(posA, b || PointSet.empty, posB, len, (pos, val) => {
          add(pos, Math.min(pos + (val instanceof WidgetDecoration ? 0 : 1), endB))
          if (val instanceof ShapeDecoration && !globalChange) {
            let idx = findAbove(shapeChanges, 0, pos - 1)
            if (idx == shapeChanges.length || shapeChanges[idx] != pos) shapeChanges.splice(idx, 0, pos)
          }
        })
      })
      let joined = joinRanges(ranges), pos = posB, end = pos + len, j = 0
      // Skip empty update if not after a preserved section.
      if (joined.length && joined[0] == pos && joined[1] == pos && result.length && result[result.length - 1] != -1)
        j = 2
      for (; j < joined.length;) {
        let from = Math.max(pos, joined[j++]), to = Math.min(end, joined[j++])
        if (from > pos) addSection(result, from - pos, -1)
        if (from <= to) addSection(result, to - from, -2)
        pos = to
      }
      if (pos < end) addSection(result, end - pos, -1)
      posA += len; posB = endB
    } else {
      posA += len
      posB += ins < 0 ? len : ins
      if (ins >= 0 && result.length && result[result.length - 2] == 0 && result[result.length - 1] == -2) {
        result.pop(); result.pop()
      }
      addSection(result, len, ins)
    }
  }
  if (shapeChanges.length) return addAtomicityChanges(result, prevState, shapeChanges)
  return result
}

function addAtomicityChanges(
  changes: Changes,
  prev: GardState,
  nodes: number[]
): Changes {
  let added: number[] = []
  let scan = prev.doc.resolve(0), sectionPos = 0, sectionI = 0, off = 0
  for (let posB of nodes) {
    while (posB >= sectionPos) {
      let len = changes[sectionI++], ins = changes[sectionI++]
      if (ins < 0) {
        sectionPos += len
      } else {
        sectionPos += ins
        off += len - ins
      }
    }
    let posA = posB - off
    if (scan.pos < posA) scan = scan.advance(posA - scan.pos)
    let node = scan.nodeAfter
    if (!node) continue
    added.push(posA, posA + node.length)
  }
  return added.length ? addUpdated(changes, added) : changes
}

export interface DecoWalker {
  enter(node: Plot, shape: DecoElt, wrappers: readonly WrapperSource[]): void
  leave(): void
  node(node: Node, shape: Decoration.Shape, wrappers: readonly WrapperSource[], partial: number | undefined): void
  nodePart(node: Node, length: number, done: boolean): void
  widget(widget: Widget, side: number): void
}

class HeapIterator<R extends RangeSet.Value, P extends PointSet.Value> {
  active: RangeIterator<R>[] = []
  from: number
  to: number
  point: PointIterator<P> | null = null
  done = false

  constructor(readonly rangeHeap: RangeIterator<R>[],
              readonly pointHeap: PointIterator<P>[],
              start: number,
              readonly end: number) {
    for (let i = rangeHeap.length >> 1; i >= 0; i--) bubble(rangeHeap, i, cmpRangeFrom)
    for (let i = pointHeap.length >> 1; i >= 0; i--) bubble(pointHeap, i, cmpPoint)
    this.from = this.to = start
  }

  next() {
    if (this.done) return this
    if (this.point) {
      this.point.next()
      if (this.point.done) popHeap(this.pointHeap, cmpPoint)
      else bubble(this.pointHeap, 0, cmpPoint)
      this.point = null
    }
    let {rangeHeap, pointHeap, active} = this
    while (true) {
      let [startPos, startSide] = rangeHeap.length
        ? [rangeHeap[0].from, rangeHeap[0].value!.inclusiveStart ? -1 : 1]
        : [1e9, 0]
      let [endPos, endSide] = active.length ? [active[0].to, active[0].value!.inclusiveEnd ? 1 : -1] : [1e9, 0]
      let {pos: pointPos, side: pointSide} = pointHeap.length ? pointHeap[0] : {pos: 1e9, side: 1}
      let nextPos = Math.min(startPos, endPos, pointPos)
      if (this.to == this.end && nextPos > this.to) {
        this.done = true
        break
      } else if (nextPos > this.to) {
        this.from = this.to
        this.to = Math.min(this.end, nextPos)
        break
      } else if (pointPos == nextPos && (startPos > pointPos || pointSide < 0) && (endPos > pointPos || pointSide < 0)) {
        this.point = this.pointHeap[0]
        this.from = this.to = pointPos
        break
      } else if ((startPos - endPos || startSide - endSide) < 0) {
        let first = rangeHeap[0]
        sink(active, active.push(first) - 1, cmpRangeTo)
        popHeap(rangeHeap, cmpRangeFrom)
      } else {
        let first = active[0]
        first.next()
        if (!first.done)
          sink(rangeHeap, rangeHeap.push(first) - 1, cmpRangeFrom)
        popHeap(active, cmpRangeTo)
      }
    }
    return this
  }
}

function bubble<T>(heap: T[], index: number, cmp: (a: T, b: T) => number) {
  for (let cur = heap[index];;) {
    let childIndex = (index << 1) + 1
    if (childIndex >= heap.length) break
    let child = heap[childIndex]
    if (childIndex + 1 < heap.length && cmp(child, heap[childIndex + 1]) >= 0) {
      child = heap[childIndex + 1]
      childIndex++
    }
    if (cmp(cur, child) < 0) break
    heap[childIndex] = cur
    heap[index] = child
    index = childIndex
  }
}

function sink<T>(heap: T[], index: number, cmp: (a: T, b: T) => number) {
  let elt = heap[index]
  while (index > 0) {
    let parent = (index - 1) >> 1
    if (cmp(heap[parent], elt) < 0) break
    heap[index] = heap[parent]
    heap[parent] = elt
    index = parent
  }
}

function popHeap<T>(heap: T[], cmp: (a: T, b: T) => number) {
  let last = heap.pop()!
  if (heap.length) {
    heap[0] = last
    bubble(heap, 0, cmp)
  }
}

function cmpBool(a: boolean, b: boolean) {
  return a ? (b ? 0 : 1) : (b ? -1 : 0)
}

function cmpRangeFrom(a: RangeIterator<RangeSet.Value>, b: RangeIterator<RangeSet.Value>) {
  return a.from - b.from || cmpBool(b.value!.inclusiveStart, a.value!.inclusiveStart)
}

function cmpRangeTo(a: RangeIterator<RangeSet.Value>, b: RangeIterator<RangeSet.Value>) {
  return a.to - b.to || cmpBool(a.value!.inclusiveEnd, b.value!.inclusiveEnd)
}

function cmpPoint(a: PointIterator<PointSet.Value>, b: PointIterator<PointSet.Value>) {
  return a.pos - b.pos || a.side - b.side
}

export type WrapperSource = Mark<any> | WrapperRangeDecoration

// Enumerate all wrapper elements for a given node. Spanning wrappers
// are always moved to the front of the result. Within the
// spanning/non-spanning wrappers, the ordering is determined by rank.
//
// Note that the return value contains range iterators, and those will
// become invalid as soon as they are advanced further.
function nodeWrappers(
  schema: Schema,
  tag: Node.Tag,
  active: readonly RangeIterator<Decoration.Range>[],
  atom: boolean
): readonly WrapperSource[] {
  let wrappers: WrapperSource[] | undefined

  for (let mark of tag.marks) if (mark.type.element) (wrappers || (wrappers = [])).push(mark)
  if (active.length) {
    for (let cur of active) {
      let val = cur.value!
      if (val instanceof WrapperRangeDecoration && (tagScope(tag, atom) & val.scope) &&
          (!val.query || schema.matchNode(tag.type, val.query)))
        (wrappers || (wrappers = [])).push(val)
    }
  }

  if (!wrappers) return none
  if (wrappers.length > 1) wrappers.sort((a, b) => (a.spanning == b.spanning ? 0 : a.spanning ? -1 : 1) || a.rank - b.rank)
  return wrappers
}

function tagScope(tag: Node.Tag, atom: boolean): DecorationScope {
  return DecorationScope.All |
    (atom ? DecorationScope.Atom | (tag.type.isInline ? DecorationScope.InlineAtom : 0) : 0)
}

export function renderWrapper(src: WrapperSource): DecoElt {
  if (src instanceof WrapperRangeDecoration) return src.elt
  return renderMarkWrapper(src)
}

export const renderMarkWrapper = memo((mark: Mark<any>): DecoElt => {
  let shape = mark.type.element!
  return Elt.create(shape.name, shape.attrs(mark.value), Elt.hole)
})

export class DecoIterator {
  tagShapes: readonly TagShape[]
  globalWidgets: readonly TagWidget[]
  globalWrappers: readonly TagWrapper[]
  globalAttrs: readonly TagAttribute[]
  schema: Schema
  pos: Pos
  rangeIter: RangeIterator<Decoration.Range>[] = []
  pointIter: PointIterator<Decoration.Point>[] = []
  endWidgets: boolean

  constructor(readonly state: GardState, readonly decoSet: DecoSet) {
    this.tagShapes = state.facet(tagShape)
    this.globalWidgets = state.facet(tagWidget)
    this.endWidgets = this.globalWidgets
      .some(w => (w.place == WidgetPlace.After || w.place == WidgetPlace.End) && typeof w.widget == "function")
    this.globalWrappers = state.facet(tagWrapper)
    this.globalAttrs = state.facet(tagAttribute)
    this.pos = state.doc.resolve(0)
    this.schema = state.schema
    for (let s of state.facet(Decoration.Range.source)) {
      let set = decoSet.ranges.get(s)
      if (set?.length) this.rangeIter.push(set.iter())
    }
    for (let s of state.facet(Decoration.Point.source)) {
      let set = decoSet.points.get(s)
      if (set?.length) this.pointIter.push(set.iter())
    }
  }

  widgets(tag: Node.Tag, place: WidgetPlace, walker: DecoWalker) {
    if (place == WidgetPlace.Start && tag.type.isInline)
      walker.widget(Widget.img, -1)
    for (let src of this.globalWidgets) {
      if (src.place == place && tag.type == src.type) {
        let widget = typeof src.widget == "function" ? src.widget(tag) : src.widget
        if (widget) walker.widget(widget, place == WidgetPlace.Before || place == WidgetPlace.End ? 1 : -1)
      }
    }
    if (place == WidgetPlace.End && tag.type.isInline)
      walker.widget(Widget.img, 1)
  }

  hasEndWidget(type: Node.Type) {
    return this.globalWidgets.some(tw => tw.type == type &&
      (tw.place == WidgetPlace.End || tw.place == WidgetPlace.After) &&
      typeof tw.widget == "function")
  }

  walk(from: number, inclusiveStart: boolean, to: number, walker: DecoWalker) {
    for (let i of this.rangeIter) i.goto(from)
    for (let i of this.pointIter) i.goto(from, inclusiveStart)
    let iter = new HeapIterator<Decoration.Range, Decoration.Point>(
      this.rangeIter.filter(i => !i.done), this.pointIter.filter(i => !i.done), from, to)
    let pos = this.pos.advance(from - this.pos.pos), started = inclusiveStart
    let atomParent: Pos.Plot | undefined
    for (let p: Pos.Plot | null = pos.parent; p; p = p.parent)
      if (this.state.isAtom(p.node.type)) atomParent = p

    // Track points that may apply to the node at the start of the next range
    let pendingDeco: Decoration.Point[] = [], pendingPos = -1
    let pendingShape: ShapeDecoration | null = null, pendingShapeSet: PointSet | null = null

    let wrap: Pos.Walker = {
      skip: (node, pos) => { // Only done for leaf nodes.
        if (started) this.widgets(node.tag, WidgetPlace.Before, walker)
        else started = true
        let hasPending = pendingPos == pos && !node.isText
        let shape = hasPending && pendingShape ? pendingShape.shape : this.tagShape(node.tag, iter.active)
        if (hasPending) for (let deco of pendingDeco) shape = applyDeco(shape, deco, node.tag)
        if (shape.hasContent) throw new Error("Leaf nodes shapes shouldn't have a content hole")
        walker.node(node, shape, nodeWrappers(this.schema, node.tag, iter.active, true), undefined)
        this.widgets(node.tag, WidgetPlace.After, walker)
      },
      enterPlot: (node, pos) => {
        if (started) this.widgets(node.tag, WidgetPlace.Before, walker)
        else started = true
        let shape = pendingShape && pendingPos == pos ? pendingShape.shape
          : this.tagShape(node.tag, iter.active)
        if (pendingPos == pos) for (let deco of pendingDeco) shape = applyDeco(shape, deco, node.tag)
        let wrappers = nodeWrappers(this.schema, node.tag, iter.active, !shape.hasContent)
        let atom = !shape.hasContent
        if (atom) walker.node(node!, shape, wrappers, pos + node.length > to ? to - pos : undefined)
        else walker.enter(node!, shape as DecoElt, wrappers)
        this.widgets(node.tag, WidgetPlace.Start, walker)
        return !atom
      },
      leavePlot: tag => {
        if (started) this.widgets(tag, WidgetPlace.End, walker)
        else started = true
        walker.leave()
        this.widgets(tag, WidgetPlace.After, walker)
      }
    }

    if (inclusiveStart) {
      let before = pos.nodeBefore
      if (before) this.widgets(before.tag, WidgetPlace.After, walker)
      else this.widgets(pos.parent.node.tag, WidgetPlace.Start, walker)
    }

    for (; !iter.next().done;) {
      if (atomParent) {
        let end = Math.min(to, atomParent.after), done = atomParent.after <= to
        walker.nodePart(atomParent.node, end - pos.pos, done)
        pos = pos.advance(end - pos.pos)
        if (done) this.widgets(atomParent.node.tag, WidgetPlace.After, walker)
        atomParent = undefined
        while (iter.point && iter.from < end) iter.next()
      } else if (iter.point) {
        let value = iter.point.value!
        if (value instanceof WidgetDecoration) {
          walker.widget(value.widget, value.side)
        } else {
          if (pendingPos < pos.pos) {
            pendingDeco.length = 0
            pendingShape = null
            pendingPos = pos.pos
          }
          if (value instanceof ShapeDecoration &&
              (!pendingShape || compareSetPrec(pendingShapeSet!, iter.point.set, this.pointIter))) {
            pendingShape = value
            pendingShapeSet = iter.point.set
          } else {
            pendingDeco.push(value)
          }
        }
      } else {
        pos = pos.walk(iter.to - iter.from, wrap)
      }
    }
    if (pos.pos < to) pos = pos.walk(to - pos.pos, wrap)

    if (atomParent) {
      walker.nodePart(atomParent.node, 0, atomParent.after == to)
    } else {
      let after = pos.nodeAfter
      if (after) this.widgets(after!.tag, WidgetPlace.Before, walker)
      else this.widgets(pos.parent.node.tag, WidgetPlace.End, walker)
    }
    this.pos = pos
  }

  tagShape(tag: Node.Tag, active: RangeIterator<Decoration.Range>[]) {
    let shape
    if (!tag.is(Leaf.Text)) for (let src of this.tagShapes) if (src.type == tag.type) {
      shape = src.shape(tag)
      break
    }
    if (!shape) shape = baseTagShape(tag)
    let add: string[] | undefined
    for (let src of this.globalAttrs) if (tag.type == src.type) {
      if (src.target && shape instanceof Elt) shape = shape.addAttrs([src.attr, src.value(tag)], src.target)
      else Attributes.push(add || (add = []), src.attr, src.value(tag))
    }
    let scope = tagScope(tag, !shape.hasContent)
    for (let {type, elt, target} of this.globalWrappers) if (tag.type == type) {
      shape = target && shape instanceof Elt ? shape.wrap(elt, target) : elt.fill([shape])
    }
    for (let iter of active) {
      let deco = iter.value!
      if (deco instanceof AttributeRangeDecoration && (scope & deco.scope) &&
          (!deco.query || this.schema.matchNode(tag.type, deco.query)))
        Attributes.push(add || (add = []), deco.attribute, deco.value)
    }
    if (add) {
      if (shape instanceof Elt) shape = Elt.create(shape.tagName, Attributes.merge(shape.attrs, add), shape.children)
      else shape = Elt.create(tag.type.isBlock ? "div" : "span", add, [shape])
    }
    return shape
  }
}

function compareSetPrec(setA: PointSet, setB: PointSet, array: readonly PointIterator<PointSet.Value>[]) {
   if (setA != setB) for (let i of array) {
     if (i.set == setA) return -1
     if (i.set == setB) return 1
  }
  return 0
}
