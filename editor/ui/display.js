import { el } from './view.js'

const clip = (text, length) => {
  const value = String(text ?? '')
  return value.length > length ? `${value.slice(0, length - 1)}…` : value
}
const pad3 = number => String(Math.max(0, Math.trunc(Number(number) || 0))).padStart(3, '0')

// Describe what the OLED shows. Mirrors the manual's two common screens: the patch
// screen (nothing selected) and the parameter adjust screen, plus a connection screen.
export function oledModel({ patch, slot, page, pageCount, pageLabel, selected, cable, armed, cpu }) {
  const where = `PG ${page + 1}/${pageCount}`
  if (cable) return { kind: 'cable', where, title: 'CONNECTION', lines: [cable.from, cable.to], value: cable.strength, cpu }
  if (selected) {
    return {
      kind: 'param', where, title: selected.module, label: selected.label,
      value: selected.value, units: selected.units, position: selected.position, armed, cpu,
    }
  }
  return {
    kind: 'patch', where, title: patch?.name || 'UNTITLED', label: `P${pad3(slot)}`,
    lines: [pageLabel], armed, cpu,
  }
}

export function paintOled(node, model) {
  const row = (className, ...cells) => {
    const line = el('div', null, `oled-row ${className}`)
    for (const cell of cells) line.append(cell instanceof Node ? cell : el('span', cell))
    return line
  }
  const cpu = el('span', model.cpu ?? 'CPU —')
  cpu.id = 'oled-cpu'
  const rows = []
  if (model.kind === 'patch') {
    rows.push(row('small', model.label, model.where, cpu))
    rows.push(row('big', clip(model.title, 16)))
    rows.push(row('small', clip(model.lines[0], 18)))
    rows.push(row('small dim', model.armed ? clip(`CABLE FROM ${model.armed}`, 22) : 'PRESS A BUTTON'))
  } else if (model.kind === 'cable') {
    rows.push(row('small', model.title, model.where, cpu))
    rows.push(row('small', clip(model.lines[0], 24)))
    rows.push(row('small', clip(model.lines[1], 24)))
    rows.push(row('big', model.value))
  } else {
    rows.push(row('small', clip(model.title, 14), model.where, cpu))
    rows.push(row('small', clip(model.label, 24)))
    rows.push(row('big', model.value))
    const bar = el('div', null, 'oled-bar')
    if (model.position !== null && model.position !== undefined) {
      const at = Math.min(1, Math.max(0, model.position)) * 100
      const bias = el('i', null, 'bias')
      bias.style.left = `${at}%`
      const mark = el('i', null, 'mark')
      mark.style.left = `${at}%`
      bar.append(bias, mark)
    }
    rows.push(bar)
    if (model.armed) rows.push(row('small dim', clip(`CABLE FROM ${model.armed}`, 22)))
  }
  node.replaceChildren(...rows)
}
