import {Plot, Leaf} from "wordgard/doc"
import {GardState} from "wordgard/state"
import {CodeBlock, CodeBlockLanguage, LineBreak} from "wordgard/types"
import {Wordgard, Decoration, decoratePlots} from "wordgard/editor"
import {codeBlockLanguage} from "wordgard/schema"
import {Language} from "./languages"
import {StringStream} from "@codemirror/streamparser"

type TokenClass = "keyword" | "atom" | "bool" | "label" | "literal" |
  "number" | "string" | "name" | "prop" | "local" | "def" | "type" |
  "namespace" | "class" | "macro" | "special" | "comment" | "error"

const theme = Wordgard.styles({
  ".wg-t-keyword": {color: "#708"},
  ".wg-t-atom, .wg-t-bool, .wg-t-label": {color: "#219"},
  ".wg-t-literal, .wg-t-number": {color: "#164"},
  ".wg-t-string": {color: "#a11"},
  ".wg-t-name, .wg-t-prop": {},
  ".wg-t-local": {color: "#30a"},
  ".wg-t-def": {color: "#00f"},
  ".wg-t-type, .wg-t-namespace, .wg-t-class": {color: "#085"},
  ".wg-t-macro, .wg-t-special": {color: "#256"},
  ".wg-t-comment": {color: "#940"},
  ".wg-t-error": {color: "#f00"}
})

const tokenMap: Map<string, TokenClass | null> = new Map

function tokenClass(token: string): TokenClass | null {
  let cls = tokenMap.get(token)
  if (cls === undefined) tokenMap.set(token, cls = getTokenClass(token))
  return cls
}

function getTokenClass(token: string): TokenClass | null {
  if (/\.local/.test(token)) return "local"
  if (token == "variable-2" || token == "variableName.special") return "special"
  if (token == "def" || token == "variableName.definition") return "def"
  if (/^keyword/.test(token)) return "keyword"
  if (/^string/.test(token)) return "string"
  if (/^(variable|name)/.test(token)) return "name"
  if (/^(type|tag)/.test(token)) return "type"
  if (/^(attribute|prop)/.test(token)) return "prop"
  if (/^type/.test(token)) return "type"
  if (/^(error|invalid)/.test(token)) return "error"
  if (/^string/.test(token)) return "string"
  if (/^number/.test(token)) return "number"
  if (/^bool/.test(token)) return "bool"
  if (/^atom/.test(token)) return "atom"
  if (/^(literal|regexp|color)/.test(token)) return "literal"
  if (/^label/.test(token)) return "label"
  if (/^class/.test(token)) return "class"
  if (/^namespace/.test(token)) return "namespace"
  if (/^label/.test(token)) return "label"
  if (/^macro/.test(token)) return "macro"
  if (/comment/i.test(token)) return "comment"
  return null
}

const tokenDeco: Record<TokenClass, Decoration.Range> = {
  keyword: Decoration.Range.attribute("class", "wg-t-keyword"),
  atom: Decoration.Range.attribute("class", "wg-t-atom"),
  bool: Decoration.Range.attribute("class", "wg-t-bool"),
  label: Decoration.Range.attribute("class", "wg-t-label"),
  literal: Decoration.Range.attribute("class", "wg-t-literal"),
  number: Decoration.Range.attribute("class", "wg-t-number"),
  string: Decoration.Range.attribute("class", "wg-t-string"),
  name: Decoration.Range.attribute("class", "wg-t-name"),
  prop: Decoration.Range.attribute("class", "wg-t-prop"),
  local: Decoration.Range.attribute("class", "wg-t-local"),
  def: Decoration.Range.attribute("class", "wg-t-def"),
  type: Decoration.Range.attribute("class", "wg-t-type"),
  namespace: Decoration.Range.attribute("class", "wg-t-namespace"),
  class: Decoration.Range.attribute("class", "wg-t-class"),
  macro: Decoration.Range.attribute("class", "wg-t-macro"),
  special: Decoration.Range.attribute("class", "wg-t-special"),
  comment: Decoration.Range.attribute("class", "wg-t-comment"),
  error: Decoration.Range.attribute("class", "wg-t-error")
}

function blockText(plot: Plot): string | null {
  let text = ""
  for (let ch of plot.content) {
    if (ch.is(Leaf.Text)) text += ch.param
    else if (ch.type == LineBreak.type) text += "\n"
    else if (ch.isLeaf) text += " "
    else return null
  }
  return text
}

function readToken<State>(token: (stream: StringStream, state: State) => string | null, stream: StringStream, state: State) {
  stream.start = stream.pos
  for (let i = 0; i < 10; i++) {
    let result = token(stream, state)
    if (stream.pos > stream.start) return result
  }
  stream.skipToEnd()
  return ""
}

const maxHighlight = 10000

function highlightBlock(
  text: string,
  language: Language,
  add: (deco: Decoration.Range, from: number, to: number) => void
) {
  let {parser} = language
  let pos = 0, state = parser.startState ? parser.startState(2) : true
  hl: for (let line of text.split("\n")) {
    let stream = new StringStream(line, 4, 2)
    if (stream.eol()) {
      parser.blankLine?.(state, 2)
    } else {
      while (!stream.eol()) {
        let token = readToken(parser.token, stream, state)
        if (token) {
          let cls = tokenClass(token)
          if (cls) add(tokenDeco[cls], pos + stream.start, pos + stream.pos)
        }
        if (pos + stream.pos > maxHighlight) break hl
      }
    }
    pos += line.length + 1
  }
}

/// Returns an extension that highlights {@link CodeBlock code
/// blocks}. Will add {@link codeBlockLanguage.options options} for
/// the block language menu for the provided languages.
export function highlightCode(options: {
  /// A set of languages to use for highlighting. A given language
  /// will be used if the block's {@link CodeBlockLanguage} mark
  /// matches its name or one of it aliases.
  languages?: readonly Language[]
  /// An optional function to override the way a language is
  /// determined for a block. Can be used to provide a default
  /// highlighting language, language detection, or more advanced
  /// language name matching.
  getLanguage?: (block: Plot) => Language | null
} = {}): GardState.Extension {
  let map: Map<string, Language> = new Map
  let langOptions: string[] = []
  for (let lang of options.languages || []) {
    langOptions.push(lang.name)
    for (let alias of lang.alias) map.set(alias, lang)
  }

  return [
    theme,
    codeBlockLanguage.options.of(langOptions),
    decoratePlots({
      type: CodeBlock,
      ranges: (block, add) => {
        let lang = options.getLanguage ? options.getLanguage(block) : undefined
        if (!lang) {
          let langName = block.mark(CodeBlockLanguage)
          if (langName) lang = map.get(langName)
        }
        if (lang) {
          let text = blockText(block)
          if (text) highlightBlock(text, lang, add)
        }
      }
    })
  ]
}
