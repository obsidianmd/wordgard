import {GardState} from "wordgard/state"
import {CodeBlock, CodeBlockLanguage} from "wordgard/types"
import {phrases} from "wordgard/phrases"
import {Command, enter, Menu, setTextblockType} from "wordgard/command"
import {KeyBinding} from "wordgard/editor"
import {selectionInType} from "./block"

/// Extensions to add support for code blocks. Includes the {@link
/// CodeBlock schema element}, a {@link codeBlock.keyBinding key
/// binding}, a {@link codeBlock.button menu button}, and an {@link
/// codeBlock.createOnBackticks input rule}.
export function codeBlock(): GardState.Extension {
  return [GardState.schemaElement.of(CodeBlock),
          codeBlock.button, codeBlock.keyBinding, codeBlock.createOnBackticks]
}

export namespace codeBlock {
  /// Binds `Ctrl-Shift-\` to switch the selected textblocks to a code
  /// block.
  export const keyBinding = KeyBinding.of({
    key: "Ctrl-Shift-\\",
    run: Command.bind(setTextblockType, CodeBlock)
  })

  /// Button for the {@link Menu.Submenu.textblockStyle textblock
  /// style} menu that switches to a code block.
  export const button = Menu.Button.define({
    run: Command.bind(setTextblockType, CodeBlock),
    active: selectionInType(CodeBlock),
    label: phrases.ref("code_block"),
    enable: s => !s.readOnly,
    parent: Menu.Submenu.textblockStyle,
    rank: 30
  })

  /// Enter command handler that, when activated at the end of a
  /// textblock containing three backticks and an optional
  /// language, converts the block into a code block.
  export const createOnBackticks = GardState.prec.high(Command.handler(enter, wg => {
    let {sel} = wg.state, parent = sel.head.parent
    if (!sel.selection.isCursor || !parent.node.isTextblock || sel.head.pos != parent.end ||
        parent.node.length > 20 || parent.node.type == CodeBlock.type || !parent.parent ||
        !wg.state.doc.schema.canContain(parent.parent.node.type, CodeBlock.type)) return false
    let text = wg.state.textblockMap(sel.head.parent)
    let match = /^```\s*([^\s`]+\s*)?$/.exec(text.text)
    if (!match) return false
    let tag = CodeBlock
    if (match[1] && wg.state.schema.has(CodeBlockLanguage))
      tag = tag.withMarks([CodeBlockLanguage.of(match[1])])
    return {
      changes: {from: parent.before, to: parent.end, insert: [tag]},
      selection: {anchor: parent.start},
      scrollIntoView: true
    }
  }))
}
