import {Node, Mark, ChangeSet, Plot} from "wordgard/doc"
import {Wordgard, Dialog} from "wordgard/editor"
import {GardState, GardSelection} from "wordgard/state"
import {ImageSize, ImageAlt, Image, Figure, CaptionedFigure, Alignment} from "wordgard/types"
import {Command} from "wordgard/command"
import {PhraseSet, imagePhrases} from "wordgard/phrases"
import cr from "crelt"

export const imageUploader = GardState.Facet.define<(file: File, wg: Wordgard, progress: (percent: number) => void) => Promise<string>>()

const imageTypes: Node.Type[] = [Image, Figure, CaptionedFigure]

export function activeImage(sel: GardSelection.Resolved) {
  if (sel.selection instanceof GardSelection.Node && imageTypes.includes(sel.selection.node.type))
    return sel.selection.node.tag
  if (sel.head.parent.start == sel.anchor.parent.start && sel.head.parent.node.type == CaptionedFigure)
    return sel.head.parent.node.tag
  return null
}

const svg = "http://www.w3.org/2000/svg"

function rect(x: number, y: number, w: number, h: number, cls: string) {
  let elt = document.createElementNS(svg, "rect")
  elt.setAttribute("x", String(x)); elt.setAttribute("y", String(y))
  elt.setAttribute("width", String(w)); elt.setAttribute("height", String(h))
  elt.setAttribute("class", cls)
  return elt
}

function imageTypeButtons(state: GardState, active: Node.Tag | null) {
  let hasImg = state.schema.has(Image), hasFig = state.schema.has(Figure), hasCap = state.schema.has(CaptionedFigure)
  let align = (hasFig || hasCap) && state.schema.markAllowed(Alignment, hasFig ? Figure : CaptionedFigure)
  if (!align && !(hasImg && (hasFig || hasCap))) return null
  let buttons: HTMLElement[] = []
  function button(type: "inline" | "start" | "center" | "end", label: PhraseSet.Tag<typeof imagePhrases>, active: boolean | null) {
    let labelText = imagePhrases.get(state, label)
    let icon = document.createElementNS(svg, "svg")
    icon.setAttribute("viewbox", "0 0 24 22")
    icon.setAttribute("width", "24"); icon.setAttribute("height", "22")
    icon.appendChild(rect(1, 1, 22, 3, "wg-img-icon-text"))
    let flip = !state.textLTR
    icon.appendChild(rect(type == "start" ? (flip ? 12 : 2) : type == "end" ? (flip ? 2 : 12) : 7, 6, 10, 10, "wg-img-icon-image"))
    if (type == "inline") {
      icon.appendChild(rect(1, 12, 5, 3, "wg-img-icon-text"))
      icon.appendChild(rect(18, 12, 5, 3, "wg-img-icon-text"))
    }
    icon.appendChild(rect(1, 18, 22, 3, "wg-img-icon-text"))
    return cr("label", {class: "wg-img-radio", title: labelText},
              cr("input", {type: "radio", "aria-label": labelText,
                           name: "type", value: type, checked: active ? "checked" : null}), icon)
  }
  let aligned = !active || active.type == Image ? null : active.mark(Alignment) || "start" as const
  if (hasImg) buttons.push(button("inline", "inline", aligned == null))
  buttons.push(button("start", "figure", aligned == "start"))
  if (align) {
    buttons.push(button("center", "figure_center", aligned == "center"))
    buttons.push(button("end", "figure_end", aligned == "end"))
  }
  if (hasFig && hasCap) {
    let caption = cr(
      "label", " ",
      cr("input", {type: "checkbox", name: "caption",
                   checked: active && active.type == CaptionedFigure ? "checked" : null}),
      " ", imagePhrases.get(state, "captioned"))
    if (hasImg) {
      let imageRadio = buttons[0].querySelector("input") as HTMLInputElement
      for (let b of buttons) b.querySelector("input")!.addEventListener("change", () => {
        caption.style.display = imageRadio.checked ? "none" : ""
      })
      if (!aligned) caption.style.display = "none"
    }
    buttons.push(caption)
  }
  return [cr("span", {class: "wg-label"}, imagePhrases.get(state, "image_style"), ":"), cr("span", buttons)]
}

function startUpload(wg: Wordgard, file: HTMLInputElement, set: (url: string) => void) {
  let imageFile = file.files?.[0], handler = wg.state.facet(imageUploader)[0]
  if (!imageFile || !handler) return
  let promise = handler(imageFile, wg, percent => {
    progress.lastChild!.textContent = Math.round(percent) + "%"
  })
  let progress = cr("span", {class: "wg-img-upload", style: `width: ${file!.offsetWidth}px`},
                    imagePhrases.get(wg.state, "uploading"), " ", cr("span"))
  file.parentNode!.replaceChild(progress, file)
  function reset() {
    if (progress.parentNode) progress.parentNode.replaceChild(file, progress)
  }
  promise.then(url => {
    reset()
    set(url)
  }, err => {
    reset()
    Dialog.show(wg, {label: imagePhrases.get(wg.state, "upload_failed") + ": " + err})
  })
}

function buildImageDialog(wg: Wordgard, close: () => void) {
  let {state} = wg, {sel} = state
  let active = activeImage(sel)
  let size = !wg.state.schema.has(ImageSize) ? null :
    [cr("label", {for: "wg-img-size"}, imagePhrases.get(state, "width"), ":"),
     cr("input", {type: "number", id: "wg-img-size", name: "size", value: active && active.mark(ImageSize) || "",
                  placeholder: imagePhrases.get(state, "auto")})]
  let src = cr("input", {type: "text", id: "wg-img-src", name: "src", required: "required",
                         value: active ? active.param : "", placeholder: "https://..."})
  let file: HTMLInputElement | null = null
  if (wg.state.facet(imageUploader).length) {
    file = cr("input", {type: "file", id: "wg-img-file", name: "file", "aria-label": imagePhrases.get(state, "upload_image"),
                        onchange: (e: Event) => startUpload(wg, e.target as HTMLInputElement, url => src.value = url)})
  }

  return cr(
    "form", {class: "wg-img-form", onkeydown},
    cr("h3", {class: "wg-dialog-title"}, imagePhrases.get(state, active ? "update_image" : "insert_image")),
    cr("label", {for: "wg-img-src"}, imagePhrases.get(state, "image_source"), ":"),
    cr("span", {class: "wg-img-src-line"}, src, file),
    cr("label", {for: "wg-img-alt"}, imagePhrases.get(state, "alt_text"), ":"),
    cr("input", {type: "text", id: "wg-img-alt", name: "alt",
                 value: active && active.mark(ImageAlt) || "",
                 placeholder: imagePhrases.get(state, "describe_image")}),
    imageTypeButtons(state, active),
    size,
    cr("div", {class: "wg-img-buttons"},
       cr("button", {type: "submit", class: "wg-dialog-button"}, imagePhrases.get(state, active ? "update" : "insert")), " ",
       cr("button", {type: "button", class: "wg-dialog-button", onclick: close}, imagePhrases.get(state, "cancel"))))
}

function finishInsertImage(wg: Wordgard, form: HTMLFormElement | null) {
  if (!form) return
  let {state} = wg, {sel} = state

  let data = new FormData(form)
  let src = data.get("src") as string
  if (!src) return
  let type = (data.get("type") as string | null) ?? (state.schema.has(Image) ? "inline" : "start")
  let cap = !!data.get("caption") || !state.schema.has(Figure)
  let marks: Mark.Set = []
  if (type == "center" || type == "end") marks = Alignment.of(type).addToSet(marks)
  if (data.get("alt")) marks = ImageAlt.of(data.get("alt") as string).addToSet(marks)
  if (data.get("size")) marks = ImageSize.of(Number(data.get("size") as string)).addToSet(marks)
  let tag = type == "inline" ? Image.of(src, marks) : cap ? CaptionedFigure.of(src, marks) : Figure.of(src, marks)

  let change: ChangeSet.Spec
  if (sel.from.parent.node.type == CaptionedFigure && sel.to.parent.start == sel.from.parent.start) {
    let from = sel.from.parent.before
    // Replacing a captioned figure
    if (tag instanceof Plot.Tag)
      change = {from, to: from + 1, insert: [tag]}
    else
      change = {from, to: sel.from.parent.after, insert: [tag], fit: true}
  } else {
    change = {from: sel.from.pos, to: sel.to.pos, insert: [tag instanceof Plot.Tag ? tag.create() : tag], fit: true}
  }

  let changes = ChangeSet.create(state.doc, change), pos = changes.findInserted(t => t == tag) ?? change.from
  wg.dispatch({
    changes: change,
    userEvent: "insert.image",
    selection: tag instanceof Plot.Tag ? {anchor: pos + 1} : GardSelection.node(pos, tag)
  })
}

export const insertImage: Command = wg => {
  let open = Dialog.get(wg, insertImage)
  if (open) {
    open.close()
  } else {
    Dialog.show(wg, {
      key: insertImage,
      content: buildImageDialog,
      closedBy: tr => !!tr.selection,
      focus: "input[name=src]",
      class: "wg-img-dialog",
      tooltip: {pos: wg.state.selection.from},
      positioningHint: true
    }).result.then(form => finishInsertImage(wg, form))
  }
  return true
}

export const imageDialogTheme = Wordgard.styles({
  ".wg-img-dialog": {
    
  },
  ".wg-img-form": {
    display: "grid",
    gap: "8px",
    alignItems: "center",
    gridTemplateColumns: "max-content auto",
    "& label, & .wg-label": {
      textAlign: "end"
    }
  },
  ".wg-img-form .wg-dialog-title": {
    gridColumn: "span 2",
    margin: "0"
  },
  ".wg-img-buttons": {
    gridColumn: "2"
  },
  ".wg-img-src-line": {
    display: "flex",
    gap: "7px",
    "& [type=text]": {
      flex: "1"
    }
  },
  ".wg-img-radio": {
    display: "inline-block",
    verticalAlign: "middle",
    "& input[type=radio]": {
      opacity: "0",
      position: "absolute",
      pointerEvents: "none"
    },
    "& svg": {
      marginRight: "6px",
      width: "24px",
      "& .wg-img-icon-text": {fill: "#bbb"},
      "& .wg-img-icon-image": {fill: "#888"},
    },
    "& input:checked + svg .wg-img-icon-image": {
      fill: "var(--wg-highlight-color)"
    },
    "& input:focus + svg": {
      borderRadius: "2px",
      outline: "2px solid var(--wg-highlight-color)",
    },
  },
  ".wg-img-upload": {
    boxSizing: "border-box",
    padding: "4px",
    fontSize: "80%"
  }
})
