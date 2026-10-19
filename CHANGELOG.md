## 0.6.0 (2026-10-17)

### Breaking changes

The interface to `RangeSet` and `PointSet` changed, and these are now exported from wordgard/set.

`handlePaste` handlers now get passed an `InputEvent` rather than a `ClipboardEvent`.

Dialogs are no longer shown as panels, but rather as floating elements on top of the editor.

The `close` value returned by `Dialog.show` is now a function, not an effect.

`Dialog.close` no longer exist. Instead, look up your dialog via its key with `Dialog.get`, and call the `close` method on the result.

Change sets now store plain token arrays rather than `Slice` objects. This is visible in `iterChanges` and the type's JSON representation.

`Plot.Doc.slice` now returns a token array rather than a `Slice` object.

Several clipboard-related facets that were passed their context as a separate argument lost that argument and need to take it from the slice now.

`parse.slice` no longer returns a wrapping object with a slice and context, since the context is now included in the slice.

`serialize.slice` no longer takes the slice's context as an option, but instead takes it from the slice object.

The 'scope' feature of key bindings is no longer supported.

Key binding specifications no longer allow aliases (like `s-`) for modifiers and modifier names are now case-sensitive.

`Decoration.Tag.shape.dynamic` and `.widget.dynamic` are now called `.derived`.

`TextblockMap.visualSide` no longer exists (positions at the start/end of a block are now always represented with the actual start/end position of the content).

`Facet.compute`/`computeN` have been renamed to `derive`/`deriveN`.

### Bug fixes

Fix an issue that caused submenus to immediately close when the editor in wrapped in a shadow root.

Make sure pending selection changes are used when interpreting input event ranges.

Avoid overflowing the stack when `posAtCoords` cannot find a position.

More eagerly use defining context nodes when fitting a replacement.

Fix an issue where `nodeFromDOM` could return an outdated version of the node.

Fix an issue where text inserted next to a composition would disrupt the composition.

Make sure a composition that's disrupted by content changes is cleanly terminated.

Handle Safari's outdated implementation of beforeinput events for composition.

Fix an issue where a custom selection type would get reset to a plain text selection if the browser tab lost and regained focus.

The type declarations for wordgard/doc no longer provide the wrong type for `Pos.nextSibling`/`previousSibling`.

Make sure `splitTextblock` won't try to split isolating blocks.

Fix an issue where pressing End in a table cell would take you to the next cell.

Make sure Delete/Backspace won't try to cross table cells or other isolating nodes.

Cell selections how have a `toSlice` method that produces a proper slice with their content, so that copying a cell selection does the right thing.

Fire an update with a `geometryChanged` flag when the height of the editor content changes. Makes sure the cursor stays in the right place.

### New features

The `decoratePlots` function can be used to add decorations to the content of all plots of a given type.

The wordgard/highlight-code package provides basic code block syntax highlighting.

Support paste events that affect content other than the selection.

`codeBlock` now comes with some styles to make code blocks easier to recognize.

Selection classes now have a `toSlice` method that is called to convert the selected content to a slice.

Dialogs may now specify a `tooltip` option to be positioned near a document position.

Dialogs now support a `closedBy` option that makes them close themselves for specific types of transactions.

The new `PositioningHint` object can be used to provide dialogs (or other UI elements) a suggestion of where to appear.

`Slice` objects can now hold a context array. `Slice.get` builds a slice with associated context.

The new `keyBindingHelp` extension can display the editor's active key bindings in a dialog.

`KeyBinding.lookupByDescription` can now be used to look up the key assigned to a feature.

The menu bar now displays key bindings, both in item's `title` attribute and in `aria-keyshortcuts` attributes.

`Decoration.Mark.shape` can now be used to change the way marks are rendered inside the editor.

Selections created by actions like double-clicking now don't have a direction until the first time they are extended.

The new `GardState.Field.Derived` class can be used to define derived values for a state in a way that allows you to read them via `state.field(...)`.

## 0.5.2 (2026-09-06)

### Bug fixes

Fix a bug that could cause `PointSet.create` to emit an unsorted set.

Fix inconsistent handling of empty update ranges, make sure text insert in the wrong place in the DOM gets moved.

Fix an issue where if the editor is part of a form, clicking a menu button would submit the form.

Fix an issue where missing table cells sitting before a rowspan cell sticking into the column from another column weren't fixed.

Fix an issue that caused the `Pos` resolution cache to hold on to documents that should be garbage-collected.

Disallow non-text content in code blocks.

The `enter` command will now behave more reasonable in code blocks.

Fix a bug where `posAtCoords` would return the wrong position for empty lines created with line break nodes.

Fix a bug in normal cursor position finding that caused an infinite loop.

Fix an issue where the undo history could get corrupted by transaction extenders (or corrections).

Fix an issue where input could end up in the wrong place next to widgets rendered as plain text.

Prevent native behavior for input events that would happen in ineditable parts of the DOM.

Fix a bug that caused block-joining commands to create invalid change sets in some circumstances.

### New features

`RangeSet`/`PointSet.merge` now allow masking off part of the set.

The `enterInCode` command helper function implements special Enter behavior in whitespace-preserving textblocks.

Add support for macOS-style Ctrl-k and Ctrl-y keybindings through the new `killToLineEnd` and `yankKilled` commands.

## 0.5.1 (2026-08-22)

### Bug fixes

Work around an issue where the browser moves the selection out of inline plots after the user inputs text.

Fix bad handling of change boundaries in `RangeSet.map`.

Fix a bug that caused the DOM to get corrupted when inserting content at the end of a plot rendered with multiple wrapper elements.

Make sure browsers see an additional cursor position at inline plot boundaries, so that touch drag selection stops there.

Fix a bug in `RangeSet` and `PointSet` where they wouldn't properly map positions at the very end of the document.

### New features

Range sets now have a `merge` method.

## 0.5.0 (2026-08-14)

### Breaking changes

`deleteEmptyTextblock` is now called `deleteEmptyPlot` and can delete empty inline plots.

Drop support for `Plot.Spec.cursorInsideBounds` (making it the default behavior).

### Bug fixes

Fix backspacing out leaf nodes on Chrome Android.

Fix an issue where change fitting would sometimes move insertions out of parent plots for no reason.

Fix a number of bugs in cursor position normalization.

Snap input ranges reported by browser events to the selection if normalizing them yields a selection endpoint.

Make sure typing into an empty inline plot doesn't replace the whole plot.

Fix a bug that caused `domAtPos` to fail to properly enter plots with extra wrappers around their content.

Support selection by touch in positions that the native browser selection doesn't handle.

### New features

Cursor height, color, slant, and thickness now tries to follow the style of the content that would be inserted when typing at the cursor position.

Nodes now have direct `isInline`/`isBlock` getters.

## 0.4.0 (2026-08-10)

### Breaking changes

Drop support for `Widget.Spec.handleEvent`, which was unreliable, and provide `propagateEvent` instead.

### Bug fixes

Fix an issue in the handling of inline nodes with content.

Fix a crash in `parse.slice` when running into multiple block elements that don't match any parse rule.

Make autocapitalization work better on iOS and Android by not handling Enter and Backspace on the key event level.

Fix an issue where comparing attributes would sometimes fail to pick up changes.

Make the link button work properly when the document was changed while the link dialog was open.

Fix bug where `TableMap` refused to read tables with marks.

Fix an issue where range decoration updates sometimes don't affect the rendered document after a document change.

Fix an issue where point decorations affecting the node after the point would sometimes get dropped when replacing content before the node.

Make sure tag widgets at end of or after a plot get updated when the plot's tag changes.

Fix a crash when a correction matched a text node that was merged to an adjacent node by the change.

Mark widgets and atom nodes inside the editor as uneditable to avoid odd editing behavior.

### New features

`Widget.Spec.inFlow` can now be used to indicate that a widget isn't part of the regular document flow.

The new `codeBlockLanguage` extension bundle allows you to add code block language selection to your configuration.

Widget `render` methods now receive the editor instance as second argument.

`codeBlockLanguage` now provides a key binding to select the current block's language.

`Plot.iterate` can now iterate backwards if given a start position above the end position.

## 0.3.1 (2026-07-16)

### Bug fixes

Fix an issue where mouse selection on an uneditable instance would update the state selection but not the DOM selection.

Avoid confusion about selection and deletion ranges when Android voice typing or a sloppy virtual keyboard fires a burst of input events.

### New features

Plots now have a `contentEq` method to compare only their content.

## 0.3.0 (2026-07-14)

### Breaking changes

Checking for plot atomicity should now be done with `state.isAtom`.

### Bug fixes

Fix an issue that broke the heading/paragraph block style key bindings.

No longer crash when an update touches part of an atomic plot.

Fix a bug that could prevent range wrapper decorations from properly redrawing.

Fix an issue that caused widgets at the end of the document to not be updated properly.

Fix a bug that broke updates when both point and range decorations changed.

Fix a crash in vertical cursor motion in an inline document.

Make forward cursor motion at line wrapping points eagerly go to the next line instead of first moving after the line-wrapped space.

Properly disable a lot of commands and menu items when the editor is read-only.

### New features

Change sets now have `extend` and `clip` methods that can be used to grow or shrink their extent.

`Wordgard.transactionListener` provides a way to listen in on transactions synchronously, as they are dispatched.

## 0.2.0 (2026-07-09)

### Breaking changes

Flip the order of the first two arguments to `ChangeSet.transform` so that it aligns with the static `transform` function.

Corrections no longer get access to the editor state.

### New features

`Correction.check` can now be used to directly apply corrections for a given set of changes.

`collab.transformUpdate` can be used for server-side change transformation.

wordgard/collab now includes support for applying corrections to changes it transforms.

## 0.1.2 (2026-07-09)

### Bug fixes

Make it possible to override the vertical sticky position of panels with CSS.

Fix incorrect results returned by `coordsAtPos` on line wrap points in Safari.

Fix issue where cutting could produce a broken document.

Fix `ChangeSet.fromJSON`, which was very broken.

## 0.1.1 (2026-07-05)

### Bug fixes

Clicking the link button when the link dialog is already open will now close it.

Work around d.ts bundler issue that caused the types of some fields in the `Pos` namespace to be incorrect in the output.

Fix a bug that caused the definition of the `link` namespace to be incorrectly tree-shaken.

### New features

Add a `Dialog.close` function for closing a dialog by class.

## 0.1.0 (2026-07-02)

### Breaking changes

First numbered release.

