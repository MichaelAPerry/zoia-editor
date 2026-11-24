// Audition fields from zoiacodec. The Python codec retains the full editing data.
import { moduleIndex } from './engine/module-index.mjs'

function readName(raw) {
  const nul = raw.indexOf(0)
  return Array.from(nul < 0 ? raw : raw.subarray(0, nul), b =>
    b < 128 ? String.fromCharCode(b) : '\ufffd').join('')
}

export function decodePatch(bytes) {
  if (bytes.length !== 32768) throw Error('ZOIA patch must be exactly 32768 bytes')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const size = view.getUint32(0, true)
  if (size === 0 && !bytes.some(Boolean)) return { empty: true }
  const end = size * 4
  if (end < 24 || end > bytes.length) throw Error(`Invalid patch size ${size} words`)
  const name = readName(bytes.subarray(4, 20))
  const count = view.getUint32(20, true)
  let offset = 24
  const take = length => {
    const start = offset
    offset += length
    if (offset > end) throw Error(`Section overruns payload at byte ${start}`)
    return start
  }
  const words = count => {
    const start = take(count * 4)
    return Array.from({ length: count }, (_, i) => view.getUint32(start + 4 * i, true))
  }
  const word = () => view.getUint32(take(4), true)
  try {
    const records = []
    for (let i = 0; i < count; i++) {
      const [size, type_id, version, page, header_color, position, paramCount, save_word] = words(8)
      const optionStart = take(8)
      if (size < 10) throw Error(`Module ${i} has invalid size ${size} words`)
      const start = take(size * 4 - 40)
      records.push([{ type_id, type: moduleIndex[type_id]?.[0] ?? `Unknown module ${type_id}`,
        version, page, header_color, position, save_word, options: Array.from(bytes.subarray(optionStart, optionStart + 8)) },
      paramCount, start, offset])
    }
    const length = word()
    const rawConnections = words(5 * length)
    const connections = Array.from({ length }, (_, i) => {
      const j = i * 5
      return { source: rawConnections.slice(j, j + 2), destination: rawConnections.slice(j + 2, j + 4),
        strength: rawConnections[j + 4] }
    })
    for (let pages = word(); pages > 0; pages--) take(16)
    const stars = word()
    take(4 * stars)
    const hasColors = count > 0 && end - offset >= 4 * count
    const modules = records.map(([module, paramCount, start, stop]) => {
      const extra = start + paramCount * 4
      if (extra > stop - (hasColors ? 16 : 0)) throw Error('Module parameter count exceeds record length')
      module.parameters = Array.from({ length: paramCount }, (_, i) => view.getUint32(start + 4 * i, true))
      const raw = bytes.subarray(Math.max(extra, stop - 16), stop)
      const trimmed = raw.findLastIndex(b => b !== 0)
      const legacyName = raw.length === 16 && raw.subarray(0, trimmed + 1).every(b => b >= 32 && b < 127)
      module.name = hasColors || legacyName ? readName(raw) : null
      if (hasColors || legacyName) stop -= 16
      if (extra < stop) module.saved_data_hex = Array.from(bytes.subarray(extra, stop), b => b.toString(16).padStart(2, '0')).join('')
      return module
    })
    return { name, modules, connections }
  } catch (error) {
    return { name, decode_error: error.message }
  }
}
