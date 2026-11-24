import { GRID_COLUMNS, GRID_ROWS, GRID_SIZE } from '../core/model.js'

export const PAD_SIZE = 100

export function firstOccupiedPage(patch) {
  if (!patch.modules?.length) return 0
  return patch.modules.reduce((first, record) => Math.min(first, record.page ?? 0), Infinity)
}

export function gridHit(rect, x, y) {
  const column = Math.floor((x - rect.left) / rect.width * GRID_COLUMNS)
  const row = Math.floor((y - rect.top) / rect.height * GRID_ROWS)
  if (column >= 0 && column < GRID_COLUMNS && row >= 0 && row < GRID_ROWS) {
    return row * GRID_COLUMNS + column
  }
  return null
}

export function padAnchor(position, direction) {
  if (!Number.isInteger(position) || position < 0 || position >= GRID_SIZE) return null
  return {
    x: (position % GRID_COLUMNS) * PAD_SIZE + (direction === 'out' ? 70 : 30),
    y: Math.floor(position / GRID_COLUMNS) * PAD_SIZE + 78,
  }
}

export function cableCurve(source, destination) {
  const gap = y => Math.min(GRID_ROWS * PAD_SIZE - 3, Math.ceil(y / PAD_SIZE) * PAD_SIZE)
  const fromY = gap(source.y)
  const toY = gap(destination.y)
  if (fromY === toY) {
    const bend = Math.sign(destination.x - source.x) * Math.min(6, Math.abs(destination.x - source.x) / 2)
    return `M ${source.x} ${source.y} Q ${source.x} ${fromY} ${source.x + bend} ${fromY} H ${destination.x - bend} Q ${destination.x} ${fromY} ${destination.x} ${destination.y}`
  }
  const column = Math.round((source.x + destination.x) / (2 * PAD_SIZE))
  const x = Math.max(3, Math.min(GRID_COLUMNS * PAD_SIZE - 3, column * PAD_SIZE))
  const turn = Math.sign(toY - fromY) * 6
  return `M ${source.x} ${source.y} Q ${source.x} ${fromY} ${source.x + Math.sign(x - source.x) * 6} ${fromY} H ${x - Math.sign(x - source.x) * 6} Q ${x} ${fromY} ${x} ${fromY + turn} V ${toY - turn} Q ${x} ${toY} ${x + Math.sign(destination.x - x) * 6} ${toY} H ${destination.x - Math.sign(destination.x - x) * 6} Q ${destination.x} ${toY} ${destination.x} ${destination.y}`
}

export function stubEnd(point, direction, order) {
  return {
    x: Math.min(791, Math.max(9, point.x + (direction === 'out' ? 21 : -21))),
    y: point.y + 8 + order % 4 * 3,
  }
}

const paletteGroups = [
  ['Audio I/O', [1, 2, 7, 8, 14, 33, 34, 38, 53, 57, 64, 65, 76]],
  ['Effects · Delay', [13, 26, 30, 43, 75, 83, 102, 106]],
  ['Effects · Reverb', [25, 67, 74, 78, 79, 80]],
  ['Effects · Modulation', [29, 41, 59, 69, 70, 71, 73, 107]],
  ['Effects · Drive', [3, 9, 11, 23, 40, 63, 66]],
  ['Effects · Filter', [0, 24, 27, 42, 68, 72]],
  ['Interface', [15, 16, 44, 54, 55, 56, 81, 103]],
]

export const DEFAULT_COLORS = [1, 8, 12, 5, 3, 4, 2, 13, 6, 7]

export function groupModules(types, query = '') {
  const search = query.trim().toLowerCase()
  const labels = [...paletteGroups.map(([label]) => label), 'CV / Control', 'MIDI', 'Euro']
  const groups = new Map(labels.map((label, index) => [label, { label, index, types: [] }]))
  for (const type of types) {
    const group = paletteGroups.find(([, ids]) => ids.includes(type.id))?.[0]
      ?? (/^midi\b/i.test(type.name) ? 'MIDI' : /^euro\b/i.test(type.name) ? 'Euro' : 'CV / Control')
    if (`${type.name} ${group}`.toLowerCase().includes(search)) groups.get(group).types.push(type)
  }
  return [...groups.values()].filter(group => group.types.length).map(group => ({
    ...group, types: group.types.sort((a, b) => a.name.localeCompare(b.name)),
  }))
}

export function parseCorpus(csv) {
  const rows = []
  let row = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < csv.length; i++) {
    const char = csv[i]
    if (char === '"' && quoted && csv[i + 1] === '"') { cell += '"'; i++ }
    else if (char === '"') quoted = !quoted
    else if (!quoted && (char === ',' || char === '\n')) {
      row.push(cell.replace(/\r$/, ''))
      cell = ''
      if (char === '\n') { rows.push(row); row = [] }
    } else cell += char
  }
  if (cell || row.length) rows.push([...row, cell.replace(/\r$/, '')])
  const keys = rows.shift()?.map(key => key.replace(/^\uFEFF/, '')) ?? []
  return rows.filter(values => values[0]).map(values =>
    Object.fromEntries(keys.map((key, index) => [key, values[index] ?? ''])))
}

export function pcmWav(channels, sampleRate) {
  const frames = channels[0]?.length
  if (!frames || channels.length > 2 || channels.some(channel => channel.length !== frames)) {
    throw new RangeError('Expected equally sized mono or stereo PCM channels')
  }
  if (!Number.isInteger(sampleRate) || sampleRate <= 0) throw new RangeError('Invalid sample rate')
  const frameBytes = channels.length * 2
  const dataBytes = frames * frameBytes
  const wav = new ArrayBuffer(44 + dataBytes)
  const view = new DataView(wav)
  const ascii = (offset, string) => [...string].forEach((char, i) => view.setUint8(offset + i, char.charCodeAt(0)))
  ascii(0, 'RIFF')
  view.setUint32(4, 36 + dataBytes, true)
  ascii(8, 'WAVEfmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, channels.length, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * frameBytes, true)
  view.setUint16(32, frameBytes, true)
  view.setUint16(34, 16, true)
  ascii(36, 'data')
  view.setUint32(40, dataBytes, true)
  let cursor = 44
  for (let frame = 0; frame < frames; frame++) {
    for (const samples of channels) {
      const x = Math.max(-1, Math.min(1, samples[frame]))
      view.setInt16(cursor, Math.round(x * (x < 0 ? 32768 : 32767)), true)
      cursor += 2
    }
  }
  return wav
}
