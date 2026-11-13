import {Plot, Node, Pos} from "wordgard/doc"
import {GardState, Transaction} from "wordgard/state"
import {Set, RangeSet, PointSet} from "wordgard/set"
import {Decoration} from "./decoration"

function offset<T>(
  add: (value: T, from: number, to?: number) => void,
  offset: number
): (value: T, from: number, to?: number) => void {
  return (v, from, to) => add(v, from + offset, to == null ? undefined : to + offset)
}

type Source<D> = (plot: Plot, offset: number, add: (value: D, from: number, to?: number) => void) => void

function init<D, S extends Set<D>>(
  config: Config,
  create: (source: Set.Source<D>) => S,
  source: Source<D>,
  doc: Plot.Doc
): S {
  return create(add => {
    let {type} = config, current: SetSource<D> | undefined, currentEnd = -1
    doc.resolve(0).walk(doc.contentLength, {
      enterPlot(plot, pos) {
        if (doc.schema.matchNode(plot.type, type)) {
          if (current) {
            current = combineSource(current, add => source(plot as Plot, pos + 1, add))
          } else {
            current = add => source(plot as Plot, pos + 1, add)
            currentEnd = pos + 1 + plot.contentLength
          }
        }
      },
      leavePlot(plot, pos) {
        if (pos == currentEnd) {
          current!(add)
          current = undefined
        }
      },
      skip() {}
    })
  })
}

function refreshByPred<D, S extends Set<D>>(
  config: Config,
  source: Source<D>,
  doc: Plot.Doc,
  deco: S,
  pred: (plot: Plot) => boolean
): S {
  let recreate: Set.Replacement<D>[] = []
  let {type} = config
  doc.iterate((node, pos) => {
    if (doc.schema.matchNode(node.type, type) && pred(node as Plot)) recreate.push({
      from: pos, to: pos + node.length,
      add: add => source(node as Plot, pos + 1, add)
    })
  })
  return recreate.length ? deco.modify({replace: recreate as any}) : deco
}

type SetSource<T> = (add: (value: T, from: number, to?: number) => void) => void

function update<D, S extends Set<D>>(
  config: Config,
  create: (source: Set.Source<D>) => S,
  source: Source<D>,
  deco: S,
  tr: Transaction
): S {
  let doc = tr.newDoc
  let refresh = config.refresh && config.refresh(tr)
  if (refresh === true) return init(config, create, source, doc)
  if (refresh) deco = refreshByPred(config, source, tr.startState.doc, deco, refresh)
  if (!tr.docChanged && !refresh) return deco
  let recreate: {from: number, to: number, add: SetSource<D>}[] = []
  let clear: {from: number, to: number}[] = []
  let scannedTo = 0

  tr.changes.iterChangedRanges((fromA, toA, fromB, toB) => {
    let clearAfter: {from: number, to: number} | undefined
    let scanFrom = fromB, scanTo = toB
    // Check for matching nodes whose start got replaced but that
    // stick out of the range
    for (let scan: Pos.Plot | null = tr.startState.doc.resolve(toA).parent; scan; scan = scan.parent) {
      if (doc.schema.matchNode(scan.node.type, config.type)) {
        scanFrom = Math.min(scanFrom, tr.changes.mapPos(scan.before, -1))
        scanTo = tr.changes.mapPos(scan.after, 1)
        if (scan.before >= fromA) clearAfter = {from: scan.before, to: scan.after}
      }
    }
    if (clearAfter) clear.push(clearAfter)
    scanFrom = Math.max(scannedTo, scanFrom)
    if (scanFrom >= scanTo) return
    doc.iterate(scanFrom, scanTo, (node, pos) => {
      if (doc.schema.matchNode(node.type, config.type)) {
        for (let cur of recreate) {
          if (cur.from == pos) return
          if (cur.from < pos && cur.to > pos) {
            cur.add = combineSource(cur.add, add => source(node as Plot, pos + 1, add))
            return
          }
        }
        recreate.push({
          from: pos, to: pos + node.length,
          add: add => source(node as Plot, pos + 1, add)
        })
      }
    })
    scannedTo = scanTo
  })
  if (clear.length) deco = deco.modify({replace: clear})
  return deco.map(tr.changes, recreate as any)
}

function combineSource<T>(a: SetSource<T>, b: SetSource<T>) {
  return (add: (value: T, from: number, to?: number) => void) => {
    let bValues: {from: number, to: number | undefined, value: T}[] = [], i = 0
    b((value, from, to) => bValues.push({value, from, to}))
    a((value, from, to) => {
      while (i < bValues.length && bValues[i].from < from) {
        let bValue = bValues[i++]
        add(bValue.value, bValue.from, bValue.to)
      }
      add(value, from, to)
    })
    while (i < bValues.length) {
      let bValue = bValues[i++]
      add(bValue.value, bValue.from, bValue.to)
    }
  }
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
  /// on matching transaction, either for the entire document (`true`)
  /// or for any plot where the returned predicate returns `true`.
  refresh?: (tr: Transaction) => boolean | ((plot: Plot) => boolean)
}

/// Create an extension that adds decorations to plots matching the
/// given type.
export function decoratePlots(config: Config): GardState.Extension {
  let result: GardState.Extension[] = []
  let {points, ranges} = config
  if (points) {
    let source: Source<Decoration.Point> = (plot, start, add) => points(plot, offset(add, start))
    let field = GardState.Field.define<Decoration.Point.Set>({
      create(state) { return init<Decoration.Point, Decoration.Point.Set>(config, PointSet.create, source, state.doc) },
      update(value, tr) { return update(config, PointSet.create, source, value, tr) }
    })
    result.push(field, Decoration.Point.source.of(s => s.field(field)))
  }
  if (ranges) {
    let source: Source<Decoration.Range> = (plot, start, add) => ranges(plot, offset(add, start))
    let field = GardState.Field.define<Decoration.Range.Set>({
      create(state) { return init(config, RangeSet.create, source, state.doc) },
      update(value, tr) { return update(config, RangeSet.create, source, value, tr) }
    })
    result.push(field, Decoration.Range.source.of(s => s.field(field)))
  }
  return result
}
