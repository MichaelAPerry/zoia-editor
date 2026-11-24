// Mirrors zoiacodec's little-endian patch writer.
import { assertConnections } from './connections.js'
export { decodePatch } from './decode.js'

export const FILE_SIZE = 32768

function fromHex(value = '') {
  // Python's bytes.fromhex accepts ASCII whitespace between byte pairs.
  if (!/^[\t\n\v\f\r ]*(?:[\da-f]{2}[\t\n\v\f\r ]*)*$/i.test(value)) {
    throw new Error('Invalid hexadecimal bytes')
  }
  return Uint8Array.from(value.match(/[\da-f]{2}/gi) ?? [], pair => parseInt(pair, 16))
}

function nameBytes({ name = '', name_hex }) {
  if (name_hex !== undefined) {
    const raw = fromHex(name_hex)
    if (raw.length !== 16) throw new Error('name_hex must contain 16 bytes')
    const nul = raw.indexOf(0)
    const decoded = Array.from(nul === -1 ? raw : raw.subarray(0, nul),
      byte => byte < 128 ? String.fromCharCode(byte) : '\ufffd').join('')
    if (name === decoded) return raw
  }
  if (typeof name !== 'string' || name.length > 16 || /[^\x01-\x7f]/.test(name)) {
    throw new Error('name must be at most 16 ASCII bytes without NUL')
  }
  const raw = new Uint8Array(16)
  raw.set(Array.from(name, char => char.charCodeAt(0)))
  return raw
}

function unsigned(value, max = 0xffffffff) {
  if (!Number.isInteger(value) || value < 0 || value > max) {
    throw new RangeError(`Invalid unsigned binary field: ${value}`)
  }
  return value
}

function starWord(star) {
  const connection = Object.hasOwn(star, 'connection')
  const index = unsigned(connection ? star.connection : star.module, 65535)
  const block = unsigned(connection ? star.reserved ?? 0 : star.block, 127)
  const cc = unsigned(star.midi_cc == null ? 0 : star.midi_cc + 1, 255)
  const value = index | (block << 16) | (cc << 23)
  return (connection ? ~value : value) >>> 0
}

export function encodePatch(patch) {
  assertConnections(patch)
  return encodeBinary(patch)
}

export function encodeBinary(patch) {
  const bytes = new Uint8Array(FILE_SIZE)
  if (patch.empty) return bytes
  const view = new DataView(bytes.buffer)
  let offset = 4
  const reserve = size => {
    if (offset + size > FILE_SIZE) throw new RangeError('Patch exceeds 32768 bytes')
    const start = offset
    offset += size
    return start
  }
  const write = data => bytes.set(data, reserve(data.length))
  const word = value => view.setUint32(reserve(4), unsigned(value), true)

  write(nameBytes(patch))
  if (Object.hasOwn(patch, 'opaque_body_hex')) {
    word(patch.module_count)
    write(fromHex(patch.opaque_body_hex))
  } else {
    const { modules = [], connections = [], pages = [], starred = [],
      colors = modules.map(module => module.header_color ?? 1) } = patch
    if (colors.length && colors.length !== modules.length) {
      throw new Error('Color table must contain one word per module')
    }
    word(modules.length)
    for (const module of modules) {
      const { options = [], parameters = [], version = 0, page = 0, header_color = 1, save_word = 0 } = module
      if (options.length > 8) throw new Error('A module can have at most eight option bytes')
      const saved = fromHex(module.saved_data_hex)
      if (saved.length % 4) throw new Error('Module saved data must be word-aligned')
      if (colors.length && module.name === null) throw new Error('The color table requires a name field in each module')
      const name = module.name === null ? new Uint8Array(0) : nameBytes(module)
      word(10 + parameters.length + (saved.length + name.length) / 4)
      for (const value of [module.type_id, version, page, header_color, module.position, parameters.length, save_word]) {
        word(value)
      }
      const start = reserve(8)
      bytes.set(Uint8Array.from(options, value => unsigned(value, 255)), start)
      for (const parameter of parameters) word(parameter)
      write(saved)
      write(name)
    }
    word(connections.length)
    for (const { source, destination, strength } of connections) {
      if (source.length !== 2 || destination.length !== 2) throw new Error('Expected two fields per cable endpoint')
      for (const value of [...source, ...destination, strength]) word(value)
    }
    word(pages.length)
    for (const page of pages) write(nameBytes(page))
    word(starred.length)
    for (const star of starred) word(starWord(star))
    for (const color of colors) word(color)
    write(fromHex(patch.payload_tail_hex))
  }
  if (offset % 4) throw new Error('Patch payload must be word-aligned')
  view.setUint32(0, offset / 4, true)
  write(fromHex(patch.padding_hex))
  return bytes
}
