import { moduleBlocks, optionDefinitions } from '../core/model.js'
import {
  $, button, cableDb, colors, display, el, endpoint, field, knobRaw, label, moduleColor, moduleName,
} from './view.js'

function input(type, value) {
  const node = el('input')
  node.type = type
  node.value = value
  return node
}

function textNumber(name, value, update) {
  const node = input('text', display(value))
  node.setAttribute('aria-label', name)
  let current = value
  node.onchange = () => {
    const text = node.value.trim().replace(/\s*(?:%|dB)$/i, '')
    const number = /^(?:-inf(?:inity)?|[−-]∞)$/i.test(text) ? -Infinity : text ? Number(text) : NaN
    if (Number.isFinite(number) || number === -Infinity) update(number)
    else node.value = display(current)
  }
  node.setReadout = number => {
    current = number
    node.value = display(number)
  }
  return node
}

function details(content) {
  const node = el('details', null, 'value-details')
  node.append(el('summary', 'Details'), content)
  return node
}

function limit(value, min, max, units) {
  const result = Math.min(max, Math.max(min, value))
  return [result, result === value ? '' : `Adjusted to ${display(result)}${units === '%' ? '%' : units === 'normalized' ? '' : ` ${units}`}.`]
}

function knob(record, block, starred, handlers) {
  const name = label(block.name)
  let raw = knobRaw(record, block)
  const wrapper = el('div', null, 'param')
  const head = el('div', null, 'param-head')
  const star = button(starred ? '★' : '☆', () => handlers.star(block.name, starred))
  star.setAttribute('aria-label', `Star ${name}`)
  star.setAttribute('aria-pressed', starred)
  head.append(el('strong', name), star)
  const slider = input('range', raw)
  slider.min = 0
  slider.max = 65535
  slider.setAttribute('aria-label', name)
  const value = textNumber(`${name} (${block.units})`, block.display(raw), number => {
    const [bounded, notice] = limit(number, ...block.range, block.units)
    const update = handlers.param(block.name, bounded, true)
    if (update !== undefined) raw = update
    show(raw)
    if (update !== undefined && notice) handlers.notice(notice)
  })
  const readout = el('small')
  const show = sample => {
    slider.value = sample
    value.setReadout(block.display(sample))
    readout.textContent = `raw ${sample}`
    slider.setAttribute('aria-valuetext', `${value.value} ${block.units}`)
  }
  show(raw)
  slider.oninput = () => {
    const sample = Number(slider.value)
    show(sample)
    handlers.preview(block.name, sample)
  }
  function commit() {
    const sample = Number(slider.value)
    if (sample === raw) return
    const update = handlers.param(block.name, sample, false)
    if (update !== undefined) raw = update
    else handlers.preview(block.name, raw)
    show(raw)
  }
  let pointer = null
  slider.onpointerdown = event => {
    if (event.button !== 0) return
    pointer?.abort()
    pointer = new AbortController()
    const finish = end => {
      if (end.pointerId !== event.pointerId) return
      pointer.abort()
      pointer = null
      if (end.type === 'pointercancel') {
        show(raw)
        handlers.preview(block.name, raw)
      } else commit()
    }
    for (const type of ['pointerup', 'pointercancel'])
      window.addEventListener(type, finish, { signal: pointer.signal })
  }
  slider.onchange = () => { if (!pointer) commit() }
  const units = el('span', block.units === 'normalized' ? '' : block.units, 'meta')
  if (block.guessed) units.title = 'Approximate display taper'
  const fields = el('div', null, 'param-value')
  fields.append(value, units)
  wrapper.append(head, slider, fields, details(readout))
  return wrapper
}

export function renderInspector(patch, selection, handlers) {
  const panel = $('inspector')
  panel.replaceChildren()
  if (selection?.kind === 'cable') {
    const cable = patch.connections?.[selection.index]
    if (!cable) return
    const from = endpoint(patch, cable.source)
    const to = endpoint(patch, cable.destination)
    const audio = from.block?.signal === 'audio_out' && to.block?.signal === 'audio_in'
    const units = audio ? 'dB' : '%'
    const strength = audio ? cableDb(cable, from, to) : cable.strength / 100
    const control = textNumber(`Cable strength in ${units}`, strength, number => {
      const [bounded, notice] = audio && number === -Infinity ? [number, '']
        : limit(number, audio ? -99.99 : 0, (0xffffffff - (audio ? 10000 : 0)) / 100, units)
      const result = handlers.strength(audio ? { db: bounded } : { raw: Math.round(bounded * 100) })
      if (result !== undefined && notice) handlers.notice(notice)
    })
    if (audio) control.title = 'Enter -inf to mute the cable.'
    panel.append(
      el('h3', 'Cable'),
      el('p', `From ${from.text}`),
      el('p', `To ${to.text}`),
      field(`Cable strength (${units})`, control),
      details(el('small', `Raw ${cable.strength}`)),
      field('', button('Delete cable', handlers.remove)),
    )
    return
  }
  const record = patch.modules?.[selection?.index]
  if (!record) {
    panel.append(el('p', 'Select a module or cable to edit its settings.', 'meta'))
    return
  }
  panel.append(el('h3', moduleName(record)), el('p', record.type ?? `Type ${record.type_id}`, 'meta'))
  const name = input('text', record.name ?? '')
  name.maxLength = 16
  name.onchange = () => handlers.name(name.value)
  const palette = el('select')
  const color = moduleColor(patch, selection.index)
  const available = colors.slice(0, patch.colors?.length ? 15 : 7)
  if (!available[color - 1]) palette.add(new Option(`Imported colour ${color}`, color))
  available.forEach(([name], index) => palette.add(new Option(name, index + 1)))
  palette.value = color
  palette.onchange = () => handlers.color(Number(palette.value))
  const colorField = field('Colour ', palette)
  const swatch = el('span', null, 'swatch')
  swatch.style.backgroundColor = colors[color - 1]?.[1] ?? 'transparent'
  colorField.insertBefore(swatch, palette)
  panel.append(field('Name', name), colorField)
  const blocks = moduleBlocks(record)
  if (blocks.filter(block => block.signal === 'audio_out').length === 1) {
    panel.append(el('p', 'This module has a mono output. To hear it on both sides, cable it to both the left and right Audio Output inputs.', 'hint'))
  }
  if (blocks.length > handlers.span) {
    const jacks = el('div', null, 'jack-list')
    for (const block of blocks) {
      if (handlers.span > 0 && blocks.filter(other =>
        Math.min(other.slot, handlers.span - 1) === Math.min(block.slot, handlers.span - 1)).length === 1) continue
      const out = block.signal.endsWith('_out')
      const jack = button(`${out ? '◆' : '●'} ${label(block.name)}`, () => handlers.jack(block),
        out ? 'port-out' : 'port-in')
      jack.setAttribute('aria-label', `${label(block.name)} ${out ? 'output' : 'input'}`)
      jacks.append(jack)
    }
    panel.append(jacks)
  }
  if (blocks.length) {
    for (const option of optionDefinitions(record.type_id)) {
      const select = el('select')
      const byte = record.options?.[option.index] ?? 0
      const names = { '1in->1out': 'Mono', '1in->2out': 'Mono in, stereo out', '2in->2out': 'Stereo',
        cv_direct: 'Direct CV', cv_control: 'CV control', linear_cv: 'Linear CV', tap_tempo: 'Tap tempo' }
      option.values.forEach((value, index) => select.add(new Option(names[value] ?? label(String(value)), index)))
      if (byte >= option.values.length) select.add(new Option(`Imported option ${byte}`, byte))
      select.value = byte
      select.onchange = () => handlers.option(option.name, option.values[Number(select.value)])
      panel.append(field(label(option.name), select))
    }
    for (const block of blocks.filter(block => block.parameterIndex >= 0)) {
      const starred = patch.starred?.some(star => star.module === selection.index && star.block === block.index)
      panel.append(knob(record, block, Boolean(starred), handlers))
    }
  }
  panel.append(button('Delete module', handlers.remove))
}
