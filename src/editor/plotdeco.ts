import {Plot, Node, Pos} from "wordgard/doc"
import {GardState, Transaction} from "wordgard/state"
import {Set, RangeSet, PointSet} from "wordgard/set"
import {Decoration} from "./decoration"
import {addRange} from "./changes"

type Source<D> = (plot: Plot, add: (value: D, from: number, to?: number) => void) => void

type UpdatePlan = {pos: number, plot: Plot, children: UpdatePlan}[]

function planFor(query: Node.Query, doc: Plot.Doc, from: number, to: number) {
  let plan: UpdatePlan = []
  doc.iterate(from, to, (node, pos) => {
    if (doc.schema.matchNode(node.type, query)) {
      let parent: UpdatePlan = plan
      for (;;) {
        if (!parent.length) break
        let last = parent[parent.length - 1]
        if (last.pos + last.plot.length <= pos) break
        parent = last.children
      }
      parent.push({pos, plot: node as Plot, children: []})
    }
  })
  return plan
}

function runPlan<D>(plan: UpdatePlan, source: Source<D>, add: (value: D, from: number, to?: number) => void) {
  let runPlot = ({plot, pos, children}: {plot: Plot, pos: number, children: UpdatePlan}) => {
    let i = 0, next = children.length ? children[0] : null
    let off = pos + 1
    source(plot, (deco, from, to = from) => {
      from += off; to += off
      while (next && to > next.pos) {
        if (from < next.pos + next.plot.length)
          throw new Error("plotDecoration sources must not create decorations inside matching descendent nodes")
        runPlot(next)
        next = ++i < children.length ? children[i] : null
      }
      add(deco, from, to)
    })
    while (i < children.length) runPlot(children[i++])
  }
  plan.forEach(runPlot)
}

function init<D, S extends Set<D>>(
  config: Config,
  create: (source: Set.Source<D>) => S,
  source: Source<D>,
  doc: Plot.Doc
): S {
  let plan = planFor(config.type, doc, 0, doc.length)
  return create(add => runPlan(plan, source, add))
}

function update<D, S extends Set<D>>(
  config: Config,
  create: (source: Set.Source<D>) => S,
  source: Source<D>,
  deco: S,
  tr: Transaction
): S {
  let doc = tr.newDoc
  if (config.refresh?.(tr)) return init(config, create, source, doc)
  if (!tr.docChanged) return deco
  let updateRanges: number[] = []
  tr.changes.iterChangedRanges((fromA, toA, fromB, toB) => {
    addRange(updateRanges, fromB, toB)
    // Check for matching nodes that stuck out of the end of this
    // range in the old doc
    for (let scan: Pos.Plot | null = tr.startState.doc.resolve(toA).parent; scan; scan = scan.parent) {
      if (doc.schema.matchNode(scan.node.type, config.type) && scan.before >= fromA)
        addRange(updateRanges, fromB, tr.changes.mapPos(scan.after, 1))
    }
    // Add ranges for any changed matching nodes
    doc.iterate(fromB, toB, (node, pos) => {
      if (doc.schema.matchNode(node.type, config.type)) {
        addRange(updateRanges, pos, pos + node.length)
        return false
      }
    })
  })
  let recreate: Set.Replacement<D>[] = []
  for (let i = 0; i < updateRanges.length;) {
    let from = updateRanges[i++], to = updateRanges[i++]
    let plan = planFor(config.type, doc, from, to)
    recreate.push({from, to, add: add => runPlan(plan, source, add)})
  }
  return deco.map(tr.changes, recreate)
}

type Config = {
  /// The type of plot to decorate.
  type: Node.Query,
  /// A function that produces range decorations for a plot. `from`
  /// and `to` should be relative to the start of the plot's content,
  /// and be fall entirely within the plot.
  ranges?: (node: Plot, range: (deco: Decoration.Range, from: number, to: number) => void) => void
  /// A function that produces point decorations for a plot. `pos`
  /// should be relative to the start of the plot's content.
  points?: (node: Plot, point: (deco: Decoration.Point, pos: number) => void) => void
  /// An optional function that causes the decorations to be recreated
  /// on matching transaction.
  refresh?: (tr: Transaction) => boolean
}

/// Create an extension that adds decorations to plots matching the
/// given type.
///
/// Decorations can only be added _inside_ the plot's content. If the
/// matched type of plot can nest, decorations for an outer plot may
/// not occur inside an inner plot's content range.
export function decoratePlots(config: Config): GardState.Extension {
  let result: GardState.Extension[] = []
  let {points, ranges} = config
  if (points) {
    let field = GardState.Field.define<Decoration.Point.Set>({
      create(state) { return init<Decoration.Point, Decoration.Point.Set>(config, PointSet.create, points, state.doc) },
      update(value, tr) { return update(config, PointSet.create, points, value, tr) }
    })
    result.push(field, Decoration.Point.source.of(s => s.field(field)))
  }
  if (ranges) {
    let field = GardState.Field.define<Decoration.Range.Set>({
      create(state) { return init(config, RangeSet.create, ranges, state.doc) },
      update(value, tr) { return update(config, RangeSet.create, ranges, value, tr) }
    })
    result.push(field, Decoration.Range.source.of(s => s.field(field)))
  }
  return result
}
