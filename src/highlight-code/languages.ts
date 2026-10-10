import {StreamParser} from "@codemirror/streamparser"

/// Object type used to associate a parser with a language name and
/// optional set of aliases.
export class Language {
  private constructor(
    /// The name of this language.
    readonly name: string,
    /// Alternative names for the mode (lowercased, includes `this.name`).
    readonly alias: readonly string[],
    /// The parser that highlights this language.
    readonly parser: StreamParser<unknown>
  ) {}

  /// Create a language object.
  static of(spec: {
    /// The language's name.
    name: string,
    /// An optional array of alternative names.
    alias?: readonly string[],
    /// The parser to use for this language.
    parser: StreamParser<unknown>
  }) {
    return new Language(spec.name, (spec.alias || []).concat(spec.name).map(s => s.toLowerCase()), spec.parser)
  }
}

function lang(name: string, parser: StreamParser<unknown>, alias?: readonly string[]) {
  return Language.of({name, alias, parser})
}

import {c, cpp, java, csharp, objectiveC, dart, scala, kotlin} from "@codemirror/legacy-modes/mode/clike"

/// @hidden
export const C = lang("C", c)
/// @hidden
export const Cpp = lang("C++", cpp, ["cpp"])
/// @hidden
export const Csharp = lang("C#", csharp, ["csharp"])
/// @hidden
export const Dart = lang("Dart", dart)
/// @hidden
export const Java = lang("Java", java)
/// @hidden
export const Kotlin = lang("Kotlin", kotlin)
/// @hidden
export const ObjectiveC = lang("ObjectiveC", objectiveC, ["objective-c", "objc"])
/// @hidden
export const Scala = lang("Scala", scala)

import {css, less} from "@codemirror/legacy-modes/mode/css"

/// @hidden
export const CSS = lang("CSS", css)
/// @hidden
export const Less = lang("Less", less)

import {go} from "@codemirror/legacy-modes/mode/go"

/// @hidden
export const Go = lang("Go", go)

import {html, xml} from "@codemirror/legacy-modes/mode/xml"

/// @hidden
export const HTML = lang("HTML", html, ["xhtml"])
/// @hidden
export const XML = lang("XML", xml, ["rss","wsdl","xsd"])

import {javascript, typescript, json} from "@codemirror/legacy-modes/mode/javascript"

/// @hidden
export const JavaScript = lang("JavaScript", javascript, ["ecmascript", "js", "node"])
/// @hidden
export const TypeScript = lang("TypeScript", typescript, ["ts"])
/// @hidden
export const JSON = lang("JSON", json, ["json5"])

import {jinja2} from "@codemirror/legacy-modes/mode/jinja2"

/// @hidden
export const Jinja2 = lang("Jinja2", jinja2)

import {msSQL, standardSQL, mySQL, pgSQL, sqlite} from "@codemirror/legacy-modes/mode/sql"

/// @hidden
export const SQL = lang("SQL", standardSQL)
/// @hidden
export const MSSQL = lang("MSSQL", msSQL)
/// @hidden
export const MySQL = lang("MySQL", mySQL)
/// @hidden
export const PostgreSQL = lang("PostgreSQL", pgSQL, ["postgres", "pgsql"])
/// @hidden
export const SQLite = lang("SQLite", sqlite)

import {python} from "@codemirror/legacy-modes/mode/python"

/// @hidden
export const Python = lang("Python", python)

import {rust} from "@codemirror/legacy-modes/mode/rust"

/// @hidden
export const Rust = lang("Rust", rust)

import {sass} from "@codemirror/legacy-modes/mode/sass"

/// @hidden
export const Sass = lang("Sass", sass)

import {wast} from "@codemirror/legacy-modes/mode/wast"

/// @hidden
export const WebAssembly = lang("WebAssembly", wast, ["wast"])

import {yaml} from "@codemirror/legacy-modes/mode/yaml"

/// @hidden
export const YAML = lang("YAML", yaml, ["yml"])

import {cobol} from "@codemirror/legacy-modes/mode/cobol"

/// @hidden
export const Cobol = lang("Cobol", cobol)

import {clojure} from "@codemirror/legacy-modes/mode/clojure"

/// @hidden
export const Clojure = lang("Clojure", clojure, ["clojurescript"])

import {commonLisp} from "@codemirror/legacy-modes/mode/commonlisp"

/// @hidden
export const CommonLisp = lang("CommonLisp", commonLisp, ["lisp", "cl"])

import {elm} from "@codemirror/legacy-modes/mode/elm"

/// @hidden
export const Elm = lang("Elm", elm)

import {erlang} from "@codemirror/legacy-modes/mode/erlang"

/// @hidden
export const Erlang = lang("Erlang", erlang)

import {haskell} from "@codemirror/legacy-modes/mode/haskell"

/// @hidden
export const Haskell = lang("Haskell", haskell)

import {julia} from "@codemirror/legacy-modes/mode/julia"

/// @hidden
export const Julia = lang("Julia", julia)

import {lua} from "@codemirror/legacy-modes/mode/lua"

/// @hidden
export const Lua = lang("Lua", lua)

import {oCaml, sml, fSharp} from "@codemirror/legacy-modes/mode/mllike"

/// @hidden
export const OCaml = lang("OCaml", oCaml)
/// @hidden
export const FSharp = lang("F#", fSharp, ["fsharp"])
/// @hidden
export const SML = lang("SML", sml)

import {perl} from "@codemirror/legacy-modes/mode/perl"

/// @hidden
export const Perl = lang("Perl", perl)

import {r} from "@codemirror/legacy-modes/mode/r"

/// @hidden
export const R = lang("R", r)

import {ruby} from "@codemirror/legacy-modes/mode/ruby"

/// @hidden
export const Ruby = lang("Ruby", ruby, ["jruby", "rb"])

import {scheme} from "@codemirror/legacy-modes/mode/scheme"

/// @hidden
export const Scheme = lang("Scheme", scheme)

import {shell} from "@codemirror/legacy-modes/mode/shell"

/// @hidden
export const Shell = lang("Shell", shell, ["bash", "sh", "zsh"])

import {swift} from "@codemirror/legacy-modes/mode/swift"

/// @hidden
export const Swift = lang("Swift", swift)

import {stex} from "@codemirror/legacy-modes/mode/stex"

/// @hidden
export const LaTeX = lang("LaTeX", stex, ["stex", "tex"])

/// An array of common languages. Contains `C`, `CSS`, `Cpp`, `HTML`,
/// `Java`, `JavaScript`, `JSON`, `Python`, `Ruby`, `Rust`,
/// `TypeScript`, and `XML`.
export const baseLanguages: readonly Language[] = [C, CSS, Cpp, HTML, Java, JavaScript, JSON, Python, Ruby, Rust, TypeScript, XML]
