import { GRID_COLUMNS, GRID_SIZE, gridFootprint, moduleBlocks } from '../core/model.js'
import { cableCurve, padAnchor, stubEnd } from './logic.js'

export const $ = id => document.getElementById(id)
export const label = key => key.replaceAll('_', ' ')
export const pageName = (patch, index) => patch.pages?.[index]?.name || `Page ${index + 1}`
export const moduleName = record => record?.name || record?.type || `Module ${record?.type_id ?? '?'}`
export const knobRaw = (record, block) => record.parameters?.[block.parameterIndex] ?? block.defaultRaw
export const display = value => value === -Infinity ? '−∞' : String(Number(Number(value.toPrecision(6)).toFixed(3)) || 0)
export const moduleColor = (patch, index) => patch.colors?.[index] ?? patch.modules[index].header_color ?? 1

export const colors = [
  ['Blue', '#0000ff'], ['Green', '#00ff00'], ['Red', '#ff0000'], ['Yellow', '#ffff00'],
  ['Aqua', '#00ffff'], ['Magenta', '#ff00ff'], ['White', '#ffffff'], ['Orange', '#ffa500'],
  ['Lima', '#bfff00'], ['Surf', '#3627f6'], ['Sky', '#87ceeb'], ['Purple', '#a020f0'],
  ['Pink', '#ff007f'], ['Peach', '#ffe5b4'], ['Mango', '#ff8243'],
]

// Mix a module colour into the dark pad body; level 0 is unlit and 1 is fully lit.
// Returns the CSS background and a readable ink colour for text on it.
export function padLight(hex, level) {
  const rgb = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16))
  const base = [20, 20, 24]
  const mix = rgb.map((channel, i) => Math.round(base[i] + (channel - base[i]) * level))
  const luminance = (0.2126 * mix[0] + 0.7152 * mix[1] + 0.0722 * mix[2]) / 255
  return { background: `rgb(${mix.join(',')})`, ink: luminance > 0.42 ? '#0a0a0a' : '#ffffff' }
}

export function el(tag, value, className) {
  const node = document.createElement(tag)
  if (value != null) node.textContent = value
  if (className) node.className = className
  return node
}

export function button(value, onClick, className) {
  const node = el('button', value, className)
  node.type = 'button'
  node.onclick = onClick
  return node
}

export function field(name, control) {
  const wrapper = el('label', name, 'field')
  wrapper.append(control)
  return wrapper
}

export function endpoint(patch, [index, key]) {
  const record = patch.modules?.[index]
  const block = record && moduleBlocks(record).find(block => block.index === key || block.name === key)
  const page = record?.page ?? 0
  const name = record ? moduleName(record) : `Module #${index + 1}`
  return {
    page, block, name, record,
    text: `${pageName(patch, page)} / ${name} / ${block ? label(block.name) : `#${key}`}`,
    position: block && gridPosition(patch, record, block),
  }
}

export function cableDb(cable, from, to) {
  if (!cable.strength) return -Infinity
  return from.block?.signal === 'audio_out' && to.block?.signal === 'audio_in'
    ? (cable.strength - 10000) / 100 : 20 * Math.log10(cable.strength / 10000)
}

function gridPosition(patch, record, block) {
  const span = gridFootprint(patch, record)
  return span ? record.position + Math.min(block.slot, span - 1) : null
}

export function pagePads(patch, page) {
  const pads = Array.from({ length: GRID_SIZE }, () => [])
  patch.modules?.forEach((record, index) => {
    if ((record.page ?? 0) !== page) return
    const span = gridFootprint(patch, record)
    if (!span) return
    const blocks = moduleBlocks(record)
    for (let slot = 0; slot < span; slot++) {
      const local = blocks.filter(block => Math.min(block.slot, span - 1) === slot)
      pads[record.position + slot]?.push({ index, record, slot, span, blocks: local })
    }
  })
  return pads
}

export function padFace(cell, interactive = false) {
  const face = el('span', null, 'pad-face')
  if (!cell) return face
  const { record, blocks, slot, span } = cell
  if (slot === 0) {
    const title = el('strong', moduleName(record))
    title.style.setProperty('--title-pads', Math.min(span, GRID_COLUMNS - record.position % GRID_COLUMNS))
    face.append(title)
  }
  face.append(el('span', blocks[0] ? label(blocks[0].name) : 'Unknown', 'block-label'))
  for (const out of [false, true]) {
    const jacks = blocks.filter(block => block.signal.endsWith(out ? '_out' : '_in'))
    if (!jacks.length) continue
    const port = el('span', out ? '◆' : '●', `port ${out ? 'port-out' : 'port-in'}`)
    if (interactive) port.dataset.direction = out ? 'out' : 'in'
    port.title = jacks.map(block => label(block.name)).join(', ')
    port.setAttribute('aria-hidden', 'true')
    face.append(port)
  }
  return face
}

function svg(tag, attributes) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag)
  Object.entries(attributes).forEach(([key, value]) => node.setAttribute(key, value))
  return node
}

export function drawCables(patch, page, selected, selectedModule, select, jump) {
  const wires = $('wires')
  const stubs = $('stubs')
  wires.replaceChildren()
  stubs.replaceChildren()
  let visibleCount = 0
  const highlighted = []
  patch.connections?.forEach((cable, index) => {
    const from = endpoint(patch, cable.source)
    const to = endpoint(patch, cable.destination)
    let start = from.page === page && padAnchor(from.position, 'out')
    let end = to.page === page && padAnchor(to.position, 'in')
    if (!start && !end) return
    visibleCount++
    const related = [cable.source[0], cable.destination[0]].includes(selectedModule)
    const offPage = from.page !== to.page
    const remote = start ? to : from
    if (!start || !end) {
      if (offPage) {
        const stub = button(`${start ? '→' : '←'} ${pageName(patch, remote.page)} / ${remote.name}`, () => jump(remote, index))
        stub.title = remote.text
        stub.setAttribute('aria-pressed', selected === index)
        stubs.append(stub)
      }
      if (!start) start = stubEnd(end, 'in', index)
      else end = stubEnd(start, 'out', index)
    }
    const description = `${from.text} → ${to.text}`
    const group = svg('g', {
      class: `wire${offPage ? ' off-page' : ''}${selected === index ? ' selected' : related ? ' related' : ''}`,
      tabindex: 0, role: 'button', 'aria-label': description, 'aria-pressed': selected === index,
    })
    const title = svg('title', {})
    title.textContent = description
    const d = cableCurve(start, end)
    group.append(title, svg('path', { class: 'wire-line', d }), svg('path', { class: 'wire-hit', d }))
    group.addEventListener('click', () => select(index))
    group.addEventListener('keydown', event => {
      if (!['Enter', ' '].includes(event.key)) return
      event.preventDefault()
      select(index)
    })
    if (related || selected === index) highlighted.push(group)
    else wires.append(group)
  })
  wires.append(...highlighted)
  wires.classList.toggle('dense', visibleCount >= 12)
}

export function buildPrint(patch, pageIndices) {
  const sheets = []
  for (const page of pageIndices) {
    const sheet = el('section', null, 'sheet')
    sheet.append(el('h1', `${patch.name || 'Untitled'} · ${pageName(patch, page)}`))
    const grid = el('div', null, 'grid')
    for (const [cell] of pagePads(patch, page)) {
      const pad = el('div', null, cell ? 'pad occupied' : 'pad')
      pad.append(padFace(cell))
      grid.append(pad)
    }
    sheet.append(grid)
    const parameters = el('ul')
    patch.modules?.forEach(record => {
      if ((record.page ?? 0) !== page) return
      const values = moduleBlocks(record).filter(block => block.parameterIndex >= 0).map(block =>
        `${label(block.name)} ${display(block.display(knobRaw(record, block)))} ${block.units}`)
      if (values.length) parameters.append(el('li', `${moduleName(record)} · ${values.join('  ·  ')}`))
    })
    if (parameters.children.length) sheet.append(el('h2', 'Knob values'), parameters)
    const cables = el('ul')
    patch.connections?.forEach(cable => {
      const from = endpoint(patch, cable.source)
      const to = endpoint(patch, cable.destination)
      if (from.page === page || to.page === page) {
        const audio = from.block?.signal === 'audio_out' && to.block?.signal === 'audio_in'
        const strength = audio ? `${display(cableDb(cable, from, to))} dB` : `${display(cable.strength / 100)} %`
        cables.append(el('li', `${from.text} → ${to.text} · ${strength}`))
      }
    })
    if (cables.children.length) sheet.append(el('h2', 'Cables'), cables)
    sheets.push(sheet)
  }
  $('print-sheet').replaceChildren(...sheets)
}
