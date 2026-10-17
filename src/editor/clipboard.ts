import {Slice, Leaf, Plot, Node, Pos, serialize, parse, Token} from "wordgard/doc"
import {GardState} from "wordgard/state"
import browser from "./browser"

export const clipboardOutputFilter = GardState.Facet.define<(content: Slice, state: GardState) => Slice>()
export const clipboardOutputHTMLFilter = GardState.Facet.define<(html: string, state: GardState) => string>()
export const clipboardTextSerializer = GardState.Facet.define<
  (slice: Slice, state: GardState) => string | null
>()
export const clipboardOutputTextFilter = GardState.Facet.define<(html: string, state: GardState) => string>()

export const clipboardInputFilter = GardState.Facet.define<(content: Slice, state: GardState) => Slice>()
export const clipboardInputHTMLFilter = GardState.Facet.define<(html: string, state: GardState) => string>()
export const clipboardTextParser = GardState.Facet.define<(text: string, state: GardState) => Slice | null>()
export const clipboardInputTextFilter = GardState.Facet.define<(html: string, state: GardState) => string>()

export function writeClipboard(state: GardState, slice: Slice, data: DataTransfer) {
  for (let filter of state.facet(clipboardOutputFilter)) slice = filter(slice, state)

  let includeContext = 0
  for (let i = 0; i < slice.context.length; i++) {
    let next = slice.context[i]
    if (next.type.defining && (!includeContext || next.type != slice.context[includeContext - 1].type)) includeContext = i + 1
    else if (next.type.defining || !next.isTextblock) break
  }
  let doc = detachedDoc(), dom = serialize.slice(slice, {
    includeContext,
    openAttr: "wg-open"
  }).toDOM()

  let needsWrap, wrappers = 0
  while (dom.firstChild && dom.firstChild.nodeType == 1 && (needsWrap = wrapMap[dom.firstChild.nodeName.toLowerCase()])) {
    for (let i = needsWrap.length - 1; i >= 0; i--) {
      let wrapper = doc.createElement(needsWrap[i])
      wrapper.setAttribute("wg-wrap", "true")
      while (dom.firstChild) wrapper.appendChild(dom.firstChild)
      dom.appendChild(wrapper)
      wrappers++
    }
  }

  if (dom.firstChild && dom.firstChild.nodeType == 1)
    (dom.firstChild as Element).setAttribute("wg-content", "true")

  let wrap = doc.createElement("div")
  wrap.appendChild(dom)

  let html = wrap.innerHTML
  for (let filter of state.facet(clipboardOutputHTMLFilter)) html = filter(html, state)
  data.setData("text/html", html)

  let text: string | undefined | null
  for (let serialize of state.facet(clipboardTextSerializer)) {
    if ((text = serialize(slice, state)) != null) break
  }
  if (text == null) text = slice.textContent({blockSeparator: "\n\n"})
  for (let filter of state.facet(clipboardOutputTextFilter)) text = filter(text, state)
  data.setData("text/plain", text)
}

function isOpen(elt: Element) {
  return (elt.getAttribute("wg-open") || null) as "start" | "end" | "start end" | null
}

export function readClipboard(state: GardState, data: DataTransfer, targetContext: Pos, plain: boolean): Slice | null {
  let html = data.getData("text/html")
  let text = data.getData("text/plain") || data.getData("Text") || data.getData("text/uri-list").replace(/\r?\n/g, " ")
  let slice: Slice
  if (text && (targetContext.parent.node.type.hasRole(Node.Role.Code) || !html || plain)) {
    for (let filter of state.facet(clipboardInputTextFilter)) text = filter(text, state)
    slice = readClipboardText(state, text, targetContext, plain)
  } else if (!html) {
    return null
  } else {
    for (let filter of state.facet(clipboardInputHTMLFilter)) html = filter(html, state)
    let dom = readHTML(html)
    if (browser.webkit) restoreReplacedSpaces(dom)

    let fromWordgard = dom.querySelector("[wg-content=true]")
    slice = parse.slice(state.schema, dom, {
      collapseWhiteSpace: !fromWordgard,
      isOpen: fromWordgard ? isOpen : undefined
    })
  }
  for (let filter of state.facet(clipboardInputFilter)) slice = filter(slice, state)
  return slice
}

function readClipboardText(state: GardState, text: string, context: Pos, plain: boolean) {
  if (!plain) for (let parser of state.facet(clipboardTextParser)) {
    let slice = parser(text, state)
    if (slice) return slice
  }

  let marks = plain ? [] : context.marks()
  if (context.parent.node.type.hasRole(Node.Role.Code)) return Slice.of([Leaf.text(text.replace(/\r?\n|\r/g, "\n"), marks)])
  let lines = text.split(/(?:\r\n?|\n)+/)
  let content: Token[] = lines[0] ? [Leaf.text(lines[0], marks)] : []
  if (lines.length == 1) return Slice.of(content)
  let parent = (context.parent.node.inlineContent ? context.parent.parent || context.parent : context.parent).node.tag
  let wrapping = state.schema.findWrapping(parent.type, Leaf.Text)
  if (!wrapping || !wrapping.length) return Slice.of([Leaf.text(text.replace(/\r?\n|\r/g, " "), marks)])
  let wrapper = wrapping[wrapping.length - 1]
  content.push(Plot.End)
  for (let i = 1; i < lines.length - 1; i++)
    content.push(wrapper.create(lines[i] ? [Leaf.text(lines[i], marks)] : []))
  content.push(wrapper)
  let last = lines[lines.length - 1]
  if (last) content.push(Leaf.text(last, marks))
  return Slice.of(content)
}

// Trick from jQuery -- some elements must be wrapped in other
// elements for innerHTML to work. I.e. if you do `div.innerHTML =
// "<td>..</td>"` the table cells are ignored.
const wrapMap: {[node: string]: string[]} = {
  thead: ["table"],
  tbody: ["table"],
  tfoot: ["table"],
  caption: ["table"],
  colgroup: ["table"],
  col: ["table", "colgroup"],
  tr: ["table", "tbody"],
  td: ["table", "tbody", "tr"],
  th: ["table", "tbody", "tr"]
}

let _detachedDoc: Document | null = null
function detachedDoc() {
  return _detachedDoc || (_detachedDoc = document.implementation.createHTMLDocument("title"))
}

function maybeWrapTrusted(html: string): string {
  let trustedTypes = (window as any).trustedTypes
  if (!trustedTypes) return html
  // With the require-trusted-types-for CSP, Chrome will block
  // innerHTML, even on a detached document. This wraps the string in
  // a way that makes the browser allow us to use its parser again.
  return trustedTypes.createPolicy("detachedDocument", {createHTML: (s: string) => s}).createHTML(html)
}

function readHTML(html: string) {
  let metas = /^(\s*<meta [^>]*>)*/.exec(html)
  if (metas) html = html.slice(metas[0].length)
  let elt = detachedDoc().createElement("div")
  let firstTag = /<([a-z][^>\s]+)/i.exec(html), wrap
  if (wrap = firstTag && wrapMap[firstTag[1].toLowerCase()])
    html = wrap.map(n => "<" + n + ">").join("") + html + wrap.map(n => "</" + n + ">").reverse().join("")
  elt.innerHTML = maybeWrapTrusted(html)
  if (wrap) for (let i = 0; i < wrap.length; i++) elt = elt.querySelector(wrap[i]) || elt
  return elt
}

// Webkit browsers do some hard-to-predict replacement of regular
// spaces with non-breaking spaces when putting content on the
// clipboard. This tries to convert such non-breaking spaces (which
// will be wrapped in a plain span on Chrome, a span with class
// Apple-converted-space on Safari) back to regular spaces.
function restoreReplacedSpaces(dom: HTMLElement) {
  let nodes = dom.querySelectorAll(browser.chrome ? "span:not([class]):not([style])" : "span.Apple-converted-space")
  for (let i = 0; i < nodes.length; i++) {
    let node = nodes[i]
    if (node.childNodes.length == 1 && node.textContent == "\u00a0" && node.parentNode)
      node.parentNode.replaceChild(dom.ownerDocument.createTextNode(" "), node)
  }
}
