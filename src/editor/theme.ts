import {GardState} from "wordgard/state"
import {StyleModule, StyleSpec} from "style-mod"

export const theme = GardState.Facet.define<string, string>({combine: strs => strs.join(" ")})

export const colorScheme = GardState.Facet.define<"dark" | "light" | "auto", "dark" | "light" | "auto">({
  combine: values => values.length ? values[0] : "light"
})

export const styleID = StyleModule.newName(), baseLightID = StyleModule.newName(), baseDarkID = StyleModule.newName()

export const lightDarkIDs = {"&light": "." + baseLightID, "&dark": "." + baseDarkID}

export function buildTheme(main: string, spec: {[name: string]: StyleSpec}, scopes?: {[name: string]: string}) {
  return new StyleModule(spec, {
    finish(sel) {
      return /&/.test(sel) ? sel.replace(/&\w*/, m => {
        if (m == "&") return main
        if (!scopes || !scopes[m]) throw new RangeError(`Unsupported selector: ${m}`)
        return scopes[m]
      }) : main + " " + sel
    }
  })
}

export const baseStyles = buildTheme("." + styleID, {
  "&": {
    "--wg-highlight-color": "#6af",
    "--wg-dialog-font": "90% sans-serif",
    position: "relative",
    boxSizing: "border-box",
    display: "flex",
    flexDirection: "column",
    border: "1px solid var(--wg-border-color)"
  },

  "&:has(> wg-scroller > wg-content:focus)": {
    outline: "1px solid var(--wg-highlight-color)",

    "& > wg-scroller > wg-cursor-layer": {
      animation: "steps(1) wg-blink 1.2s infinite"
    },

    "& > wg-scroller > wg-cursor-layer wg-cursor": {
      display: "block"
    }
  },

  "&light": {
    "--wg-panel-color": "white",
    "--wg-border-color": "#cacacb"
  },
  "&dark": {
    "--wg-panel-color": "#030303",
    "--wg-border-color": "#444"
  },

  "wg-scroller": {
    display: "block",
    height: "100%",
    overflowX: "auto",
    position: "relative",
    zIndex: 0,
  },

  "wg-content": {
    display: "block",
    margin: 0,
    whiteSpace: "pre-wrap",
    overflowWrap: "anywhere",
    wordBreak: "break-word", // For Safari, which doesn't support overflow-wrap: anywhere
    boxSizing: "border-box",
    padding: "4px 12px",
    outline: "none",
    caretColor: "transparent",
  },

  "wg-cursor-layer": {
    display: "block",
    position: "absolute",
    left: 0,
    top: 0,
    contain: "size style",
    "& > *": {
      position: "absolute"
    },
    pointerEvents: "none",
    zIndex: 150,
  },

  // Two animations defined so that we can switch between them to
  // restart the animation without forcing another style
  // recomputation.
  "@keyframes wg-blink": {"0%": {}, "50%": {opacity: 0}, "100%": {}},
  "@keyframes wg-blink2": {"0%": {}, "50%": {opacity: 0}, "100%": {}},

  "wg-cursor": {
    pointerEvents: "none",
    display: "none",
  },
  ".wg-cursor-v": {
    borderLeft: "1.8px solid currentColor",
    marginLeft: "-0.9px",
  },
  ".wg-cursor-v.wg-cursor-bold": {
    borderLeft: "2.4px solid currentColor",
    marginLeft: "-1.2px",
  },
  ".wg-cursor-v.wg-cursor-italic": {
    transform: "rotate(10deg)"
  },
  ".wg-cursor-h": {
    borderTop: "1.8px solid currentColor",
    marginTop: "-0.9px",
  },
  ".wg-selected-node": {
    outline: "2px solid #68f",
    "&::selection, & *::selection": {
      backgroundColor: "transparent"
    }
  },

  ".wg-buffer": {
    verticalAlign: "bottom",
    height: "1em",
  },

  "wg-placeholder": {
    opacity: "0.6",
    display: "inline-block",
    verticalAlign: "top",
    userSelect: "none"
  },

  "wg-dropcursor": {
    pointerEvents: "none",
    position: "absolute",
    "&.wg-vertical": {
      borderLeft: "1.2px solid black",
      marginLeft: "-0.6px",
    },
    "&.wg-horizontal": {
      borderTop: "1.2px solid black",
      marginTop: "-0.6px",
    },
  },

  "wg-announced": {
    position: "fixed",
    top: "-10000px"
  },
  "@media print": {
    "wg-announced": { display: "none" }
  },

  "wg-panels": {
    display: "block",
    boxSizing: "border-box",
    position: "sticky",
    left: 0,
    right: 0,
    zIndex: 300,
    backgroundColor: "var(--wg-panel-color)",
    font: "var(--wg-dialog-font)",
  },
  ".wg-panels-top": { top: "0" },
  ".wg-panels-bottom": { bottom: "0" },

  dialog: {
    font: "var(--wg-dialog-font)",
    padding: "7px 22px 7px 8px",
    minWidth: "120px",
    border: "1px solid var(--wg-border-color)",
    borderRadius: "5px",
    boxShadow: "0 0 8px 0 rgba(128, 128, 128, 0.2)",
    inset: "unset",
    "&.wg-free-dialog": {
      position: "fixed"
    }
  },
  "h3.wg-dialog-title": {
    fontSize: "90%",
    fontWeight: "bold",
    textAlign: "center",
    margin: "0 0 0.8em"
  },

  "dialog label, dialog .wg-label": {
    fontSize: "90%"
  },
  ".wg-dialog-close": {
    position: "absolute",
    top: "3px",
    right: "4px",
    backgroundColor: "inherit",
    border: "none",
    font: "inherit",
    fontSize: "14px",
    padding: "0"
  },
  ".wg-dialog-button": {
    color: "inherit",
    padding: "3px 9px",
    border: "none",
    borderRadius: "3px",
  },
  "&light .wg-dialog-button": {
    backgroundColor: "#eaeaea",
    "&:active": {
      backgroundColor: "#ddd"
    }
  },
  "&dark .wg-dialog-button": {
    backgroundColor: "#333",
    "&:active": {
      backgroundColor: "#222"
    }
  },

  ".wg-key-help": {
    padding: "15px",
    maxWidth: "350px"
  },
  ".wg-key-list": {
    outline: "none",
    maxHeight: "calc(min(70vh, 300px))",
    overflowY: "auto",
    display: "grid",
    gridTemplateColumns: "max-content auto",
    gap: "8px 15px",
    margin: "0 0 0.5em",
    "& h4": {
      gridColumn: "span 2",
      margin: "0.5em 0",
      fontSize: "110%"
    }
  }
}, lightDarkIDs)
