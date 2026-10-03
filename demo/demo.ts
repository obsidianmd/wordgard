import { Plot } from "wordgard/doc"
import { Wordgard, menuBar } from "wordgard/editor"
import { fullSchema } from "wordgard/schema"
import { history } from "wordgard/history"
import { tables } from "wordgard/table"

const qMouseSelection = Wordgard.mouseSelectionStyle.of(
  (wg, event) => {
    const qDom = (event.target as any)?.closest('p');
    if (!qDom) return null
    let nodeobj = wg.nodeFromDOM(qDom)!;
    console.log('nodeFromDOM:', (nodeobj.node.toJSON() as any).content?.[0]?.param)

    const nodeAtOut = wg.state.doc.nodeAt(nodeobj.pos)! as Plot
    console.log('nodeAt:', (nodeAtOut.content[0] as any)?.param)
    return null
  })

;(window as any). wg = Wordgard.create({
  parent: document.body,
  doc: `
  <p>123</p>
  <p>123</p>
`,
  config: [
    fullSchema(),
    history(),
    menuBar(),
    tables({
      cellContent: 'block'
    }),
    qMouseSelection,
  ]
})

