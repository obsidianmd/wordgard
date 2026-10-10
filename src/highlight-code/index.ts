//- This package provides syntax highlighting for {@link CodeBlock
//- code blocks}. It uses CodeMirror 5 style [stream
//- parsers](https://codemirror.net/docs/ref/#streamparser) for the
//- highlighting. This package exports a bunch of those, but you can
//- {@link Language define} your own, using parsers from
//- `@codemirror/legacy-modes` or third-party parsers.

export {highlightCode} from "./highlight"

export {Language} from "./languages"

//- This package exports constants called `C`, `CSS`, `Clojure`,
//- `Cobol`, `CommonLisp`, `Cpp`, `Csharp`, `Dart`, `Elm`, `Erlang`,
//- `FSharp`, `Go`, `HTML`, `Haskell`, `JSON`, `Java`, `JavaScript`,
//- `Jinja2`, `Julia`, `Kotlin`, `LaTeX`, `Less`, `Lua`, `MSSQL`,
//- `MySQL`, `OCaml`, `ObjectiveC`, `Perl`, `PostgreSQL`, `Python`,
//- `R`, `Ruby`, `Rust`, `SML`, `SQL`, `SQLite`, `Sass`, `Scala`,
//- `Scheme`, `Shell`, `Swift`, `TypeScript`, `WebAssembly`, `XML`,
//- and `YAML` containing {@link Language} objects for those
//- languages.

export {
  baseLanguages,
  C, Cpp, Csharp, Dart, Java, Kotlin, ObjectiveC, Scala, CSS,
  Less, Go, HTML, XML, JavaScript, TypeScript, JSON, Jinja2, SQL, MSSQL,
  MySQL, PostgreSQL, SQLite, Python, Rust, Sass, WebAssembly, YAML, Cobol,
  Clojure, CommonLisp, Elm, Erlang, Haskell, Julia, Lua, OCaml, FSharp,
  SML, Perl, R, Ruby, Scheme, Shell, Swift, LaTeX
} from "./languages"

