import cr from "crelt"
import {KeyBinding, currentPlatform, normalizeKeyName} from "./keymap"
import {PhraseSet, phrases} from "wordgard/phrases"
import {GardState} from "wordgard/state"
import {Command, Menu} from "wordgard/command"
import {Dialog} from "./dialog"

type Descs = {group: KeyBinding.Group | null, bindings: {key: string, desc: string | PhraseSet.Ref}[]}[]

function collectKeyDescs(bindings: readonly KeyBinding[]) {
  let groups: Descs = []
  let add = (group: KeyBinding.Group | null, key: string, desc: string | PhraseSet.Ref) => {
    let found = groups.find(g => g.group == group)
    if (!found) groups.push(found = {group, bindings: []})
    found.bindings.push({key, desc})
  }
  for (let binding of bindings) {
    let group = binding.spec.group || null
    let name = binding.spec[currentPlatform] || binding.spec.key
    if (name) {
      if (binding.spec.description)
        add(group, normalizeKeyName(name, currentPlatform), binding.spec.description)
      if (binding.spec.shiftDescription)
        add(group, "Shift-" + normalizeKeyName(name, currentPlatform), binding.spec.shiftDescription)
    }
  }
  return groups.sort((a, b) => (a.group?.rank ?? 0) - (b.group?.rank || 0))
}

function resolveText(state: GardState, text: string | PhraseSet.Ref) {
  return typeof text == "string" ? text : text(state)
}

function renderKeyDescs(state: GardState, groups: Descs) {
  let frag = document.createDocumentFragment()
  frag.append(cr("h3", {class: "wg-dialog-title"}, phrases.get(state, "key_bindings")))
  frag.append(cr("div", {class: "wg-key-list", tabindex: "-1"}, groups.map(group => [
    group.group ? cr("h4", resolveText(state, group.group.description)) : null,
    group.bindings.map(({key, desc}) => [
      cr("div", cr("kbd", key)),
      cr("div", resolveText(state, desc))
    ])])))
  return frag
}

/// Returns an extension that binds `Mod-?` to {@link
/// keyBindingHelp.showKeyBindings}.
export function keyBindingHelp(): GardState.Extension {
  return [keyBindingHelp.keyBindings, keyBindingHelp.button]
}

export namespace keyBindingHelp {
  /// This command opens a dialog displaying the key bindings that
  /// have a description associated with them.
  export const showKeyBindings: Command = wg => {
    let open = Dialog.get(wg, showKeyBindings)
    if (open) {
      open.close()
      return true
    }
    let descs = collectKeyDescs(wg.state.field(KeyBinding.keymap))
    if (!descs.length) return false
    Dialog.show(wg, {
      key: showKeyBindings,
      content: () => renderKeyDescs(wg.state, descs),
      class: "wg-key-help",
      focus: ".wg-key-list",
      positioningHint: true
    })
    return true
  }

  /// A menu button that, when clicked, displays the available key bindings.
  export const button = Menu.Button.define({
    run: showKeyBindings,
    label: {icon: "M24 31c-2 0-4-2-4-4C22 14 32 5 49 5c17 0 28 10 28 24 0 10-5 17-13 22-8 5-11 8-11 15v0a4 4 0 0 1-4 4h-6a4 4 0 0 1-4-4l0-1c0-9 4-15 12-20 8-5 10-9 10-15 0-7-6-13-14-13-8 0-13 4-15 11 0 2-2 3-4 3h-6ZM46 95c5 0 8-4 8-8 0-5-4-8-8-8-5 0-8 4-8 8S42 95 46 95"},
    description: phrases.ref("show_keys"),
    parent: Menu.Group.top,
    rank: 99
  })

  /// Bind `Mod-?` to {@link keyBindingHelp.showKeyBindings `showKeyBindings`}.
  export const keyBindings = [
    KeyBinding.of({key: "Mod-?", run: showKeyBindings, description: phrases.ref("show_keys"),
                   shift: showKeyBindings}),
    KeyBinding.of({key: "Mod-Shift-/", run: showKeyBindings}),
  ]
}

