import { moduleIndex } from '../../sim/engine/module-index.mjs'
import { layout, scaled } from '../../sim/engine/layout.mjs'
import { delayMaximum } from '../../sim/engine/control.mjs'

export const RAW_MAX = 65535
export const moduleTypes = Object.freeze(Object.entries(moduleIndex).map(([id, [name]]) =>
  Object.freeze({ id: Number(id), name })))

export function typeId(type) {
  if (Number.isInteger(type) && Object.hasOwn(moduleIndex, type)) return type
  const match = moduleTypes.find(entry => entry.name.toLowerCase() === String(type).toLowerCase())
  if (!match) throw new RangeError(`Unknown module type: ${type}`)
  return match.id
}

export function optionDefinitions(type) {
  return Object.entries(moduleIndex[typeId(type)][1]).map(([name, values], index) =>
    ({ name, index, values: [...values] }))
}

export function optionIndex(option, value) {
  const index = option.values.indexOf(value)
  if (index < 0) throw new RangeError(`Invalid ${option.name} option: ${value}`)
  return index
}

function taper(record, name, definition, options, musical) {
  const [defaultValue = 0, unit, anchors = [0, 1]] = definition ?? []
  let units = unit ?? 'normalized'
  let guessed = true
  let forward = x => scaled(x, definition)
  if (anchors.some(value => typeof value === 'string')) {
    units = 'normalized'
    forward = x => x
  } else if (units === 's') {
    units = 'ms'
    forward = x => 1000 * scaled(x, definition)
  } else if (units === '%' && anchors.length === 2) {
    guessed = false
  }
  const ratio = ['mix', 'depth', 'mod_depth', 'sustain', 'width', 'density', 'texture'].includes(name)
  const feedback = ['feedback', 'decay_feedback', 'regen'].includes(name)
  if (musical && (feedback || (ratio && units === 'normalized' && anchors[0] === 0 && anchors[1] === 1))) {
    units = '%'
    forward = x => 100 * x
    guessed = false
  }
  if (record.type_id === 7 && name === 'level_control') {
    forward = x => 20 * Math.log10(x)
    guessed = false
  }
  if (record.type_id === 13 && (name === 'delay_time' || name === 'modulation_in')) {
    const capacity = 48000 * delayMaximum(options.max_time)
    const linear = options['CV Input'] === 'linear'
    forward = x => {
      const samples = linear ? capacity * x : capacity ** (x * RAW_MAX / 65536)
      return Math.min(capacity - 65, Math.max(1, Math.trunc(samples))) / 48
    }
  }
  if (record.type_id === 6 && units === 'ms' && options.time_scale === 'linear') {
    forward = x => 60000 * x
  }
  if (record.type_id === 30 && ['start_position', 'loop_length'].includes(name) && unit === 's') {
    const factor = delayMaximum(options.max_rec_time) / 32
    forward = x => 1000 * factor * scaled(x, definition)
  }
  if (record.type_id === 83 && ['grain_size', 'grain_position'].includes(name)) {
    const factor = delayMaximum(options.max_grain_size) / 16
    forward = x => factor * scaled(x, definition)
  }
  if (record.type_id === 45 && name === 'value' && options.output === '-1 to 1') {
    forward = x => 2 * x - 1
    guessed = false
  }
  return {
    units, guessed, defaultRaw: Math.round(defaultValue * RAW_MAX),
    range: [forward(0), forward(1)], display: raw => forward(raw / RAW_MAX),
    labels: anchors.some(value => typeof value === 'string') ? [...anchors] : undefined,
  }
}

export function moduleBlocks(record, { includeHidden = false, musical = true } = {}) {
  const { active, catalog, parameters, options, knobNames } = layout(record)
  const blocks = includeHidden ? [...active, ...catalog.filter(([key]) => !active.some(([name]) => name === key))]
    : active
  // These endpoints live on the same physical pad. Their hardware IDs
  // remain distinct for cables, stars and the simulator.
  const shared = [17, 45, 56].includes(record.type_id)
  const keyboardNotes = record.type_id === 16 ? active.filter(([key]) => key.startsWith('note_') && key !== 'note_out').length : 0
  return blocks.map(([name, index, signal, isKnob], slot) => {
    const display = isKnob ? taper(record, name, parameters[name], options, musical) : null
    return {
      name, index, slot: slot >= active.length ? null : shared ? 0 : keyboardNotes ? Math.min(slot, keyboardNotes - 1) : slot, signal,
      kind: isKnob ? 'param' : signal, parameterIndex: knobNames.indexOf(name),
      units: display?.units ?? (signal.startsWith('audio') ? 'FS' : 'normalized'),
      range: display?.range ?? [-1, 1],
      ...(display ?? {}),
    }
  })
}

export function moduleWidth(record) {
  return Math.max(1, ...moduleBlocks(record).map(block => block.slot + 1))
}

export function parameterBlock(record, key) {
  const block = moduleBlocks(record).find(block => block.name === key || block.index === key)
  if (!block || block.parameterIndex < 0) throw new RangeError(`No adjustable block: ${key}`)
  return block
}

export function rawFromDisplay(block, value) {
  if (typeof value !== 'number' || Number.isNaN(value)) throw new TypeError('Expected numeric display value')
  const [min, max] = block.range
  if (value <= min) return 0
  if (value >= max) return RAW_MAX
  let low = 0
  let high = RAW_MAX
  while (high - low > 1) {
    const mid = (low + high) >>> 1
    if (block.display(mid) < value) low = mid
    else high = mid
  }
  return Math.abs(block.display(low) - value) < Math.abs(block.display(high) - value) ? low : high
}

export function defaultParameters(record) {
  return moduleBlocks(record).filter(block => block.parameterIndex >= 0)
    .sort((a, b) => a.parameterIndex - b.parameterIndex).map(block => block.defaultRaw)
}
