import { cableIssue, connectionIssues } from './connections.js'
import { encodeBinary, FILE_SIZE } from './encode.js'
import {
  RAW_MAX, defaultParameters, moduleBlocks, moduleWidth, moduleTypes, optionDefinitions,
  optionIndex, parameterBlock, rawFromDisplay, typeId,
} from './modules.js'

export { moduleBlocks, moduleTypes, optionDefinitions, rawFromDisplay } from './modules.js'

export const GRID_COLUMNS = 8
export const GRID_ROWS = 5
export const GRID_SIZE = GRID_COLUMNS * GRID_ROWS
const UINT_MAX = 0xffffffff
const MAX_PAGE_NAMES = Math.floor((FILE_SIZE - 36) / 16)

function integer(value, min, max, label) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new RangeError(`${label} must be an integer between ${min} and ${max}`)
  }
  return value
}

function checkName(name) {
  if (typeof name !== 'string' || name.length > 16 || /[^\x01-\x7f]/.test(name)) {
    throw new RangeError('Name must be at most 16 ASCII bytes without NUL')
  }
  return name
}

function pageCount(patch) {
  return patch.modules.reduce((count, module) => Math.max(count, (module.page ?? 0) + 1),
    patch.pages.length)
}

// Euroburo's fixed hardware controls use addresses beyond the patch grid.
const euroHardwarePositions = [53, 46, 47, 48, 49, 58, 54, 55, 56, 57, 44, 45, 50, 51, 52]

export function fixedHardwarePad(record) {
  const position = euroHardwarePositions[record.type_id - 87]
  return position !== undefined && record.position === position
}

// Binary patches can expose fewer pads than a module's full jack layout.
// The next saved start (or end of the grid) bounds that module's visible span.
export function gridFootprint(patch, record) {
  if (fixedHardwarePad(record)) return 0
  const width = moduleWidth(record)
  if (Number.isInteger(record.editor_grid_span) && record.editor_grid_span > 0)
    return Math.min(width, record.editor_grid_span)
  if (record.version === undefined || !Number.isInteger(record.position) || record.position < 0 || record.position >= GRID_SIZE) return width
  let end = GRID_SIZE
  for (const other of patch.modules ?? []) {
    if ((other.page ?? 0) === (record.page ?? 0) && other.position > record.position)
      end = Math.min(end, other.position)
  }
  return Math.min(width, end - record.position)
}

export function placementIssue(patch, module, index) {
  const width = moduleWidth(module)
  const saved = module.editor_grid_span
  const span = Number.isInteger(saved) && saved > 0 ? Math.min(saved, width) : width
  return checkPlacement(patch, module, span, index)
}

function checkPlacement(patch, module, blocks, index) {
  const { page = 0, position } = module
  if (!Number.isInteger(page) || page < 0 || page > UINT_MAX) return 'invalid-page'
  if (!Number.isInteger(position) || position < 0 || position + blocks > GRID_SIZE) return 'overflow'
  const overlap = patch.modules?.some((other, i) => {
    if (i === index || (other.page ?? 0) !== page) return false
    const span = gridFootprint(patch, other)
    if (!span) return false
    return position < other.position + span && other.position < position + blocks
  })
  return overlap ? 'overlap' : null
}

function requirePlacement(patch, module, index) {
  const issue = placementIssue(patch, module, index)
  if (issue) throw new RangeError(`Invalid placement (${issue}) on page ${module.page ?? 0} at ${module.position}`)
}

function blockAt(patch, [index, key]) {
  const module = patch.modules?.[index]
  return module && moduleBlocks(module).find(block => block.index === key || block.name === key)
}

export function validatePatch(patch) {
  const issues = []
  const add = (severity, code, message, location = {}) => issues.push({ severity, code, message, ...location })
  for (const [index, module] of (patch.modules ?? []).entries()) {
    const blocks = moduleBlocks(module)
    const location = { module: index }
    if (!blocks.length) add('error', 'unknown-module', `Unknown module type ${module.type_id}`, location)
    const span = gridFootprint(patch, module)
    const issue = span && checkPlacement(patch, module, span, index)
    if (issue) add('error', issue, `Module ${index} placement: ${issue}`, location)
  }
  issues.push(...connectionIssues(patch))
  try {
    encodeBinary(patch)
  } catch (error) {
    add('error', 'binary-format', error.message)
  }
  if (patch.opaque_body_hex !== undefined) add('warning', 'opaque-patch', 'Binary body is opaque')
  return issues
}

function strengthWord(strength, out, input) {
  let raw = typeof strength === 'number' ? strength : strength.raw
  if (raw === undefined) {
    const db = strength.db
    if (typeof db !== 'number' || Number.isNaN(db)) throw new TypeError('Expected raw or dB strength')
    const audio = out?.signal.startsWith('audio') && input?.signal.startsWith('audio')
    raw = db === -Infinity ? 0 : audio ? Math.max(1, Math.round(10000 + 100 * db))
      : Math.round(10000 * 10 ** (db / 20))
  }
  return integer(raw, 0, UINT_MAX, 'Connection strength')
}

function filterConnections(patch, keep) {
  const indices = new Map()
  const droppedConnections = []
  patch.connections = patch.connections.filter((cable, index) => {
    if (keep(cable, index)) {
      indices.set(index, indices.size)
      return true
    }
    droppedConnections.push({ index, ...cable })
    return false
  })
  const droppedStars = []
  patch.starred = patch.starred.filter(star => {
    if (!Object.hasOwn(star, 'connection')) return true
    if (!indices.has(star.connection)) {
      droppedStars.push(star)
      return false
    }
    star.connection = indices.get(star.connection)
    return true
  })
  return { droppedConnections, droppedStars }
}

function removeModules(patch, removed) {
  const indices = new Map()
  const keptColors = []
  patch.modules = patch.modules.filter((module, index) => {
    if (removed.has(index)) return false
    indices.set(index, indices.size)
    keptColors.push(patch.colors[index])
    return true
  })
  if (patch.colors.length) patch.colors = keptColors
  const report = filterConnections(patch, cable =>
    !removed.has(cable.source[0]) && !removed.has(cable.destination[0]))
  for (const cable of patch.connections) {
    for (const endpoint of [cable.source, cable.destination]) endpoint[0] = indices.get(endpoint[0]) ?? endpoint[0]
  }
  patch.starred = patch.starred.filter(star => {
    if (!Object.hasOwn(star, 'module')) return true
    if (removed.has(star.module)) {
      report.droppedStars.push(star)
      return false
    }
    star.module = indices.get(star.module) ?? star.module
    return true
  })
  return report
}

function moduleAt(patch, index) {
  integer(index, 0, (patch.modules?.length ?? 0) - 1, 'Module index')
  return patch.modules[index]
}

function setRaw(record, block, raw) {
  const parameters = record.parameters ??= []
  const defaults = defaultParameters(record)
  while (parameters.length <= block.parameterIndex) parameters.push(defaults[parameters.length])
  parameters[block.parameterIndex] = raw
}

export class PatchModel {
  #patch
  #past = []
  #future = []

  constructor(patch) {
    this.#patch = structuredClone(patch)
    for (const module of this.#patch.modules ?? []) {
      const span = gridFootprint(this.#patch, module)
      if (span > 0 && span < moduleWidth(module)) module.editor_grid_span = span
    }
  }

  get patch() { return structuredClone(this.#patch) }
  toJSON() { return this.patch }
  get canUndo() { return this.#past.length > 0 }
  get canRedo() { return this.#future.length > 0 }
  get pageCount() { return pageCount({ modules: [], pages: [], ...this.#patch }) }
  validate() { return validatePatch(this.#patch) }

  #edit(edit) {
    if (this.#patch.opaque_body_hex !== undefined || this.#patch.decode_error) {
      throw new Error('Opaque patch bodies cannot be edited')
    }
    const next = structuredClone(this.#patch)
    delete next.empty
    next.modules ??= []
    next.connections ??= []
    next.pages ??= []
    next.starred ??= []
    next.colors ??= next.modules.map(module => module.header_color ?? 1)
    const result = edit(next)
    if (JSON.stringify(next) !== JSON.stringify(this.#patch)) {
      this.#past.push(this.#patch)
      this.#patch = next
      this.#future.length = 0
    }
    return structuredClone(result)
  }

  undo() {
    if (!this.canUndo) return false
    this.#future.push(this.#patch)
    this.#patch = this.#past.pop()
    return true
  }

  redo() {
    if (!this.canRedo) return false
    this.#past.push(this.#patch)
    this.#patch = this.#future.pop()
    return true
  }

  blocks(module, options) { return moduleBlocks(moduleAt(this.#patch, module), options) }

  addModule(type, { page = 0, position, options = {}, name, color = 1 } = {}) {
    const id = typeId(type)
    return this.#edit(patch => {
      integer(page, 0, Math.max(0, pageCount(patch) - 1), 'Page index')
      integer(color, 1, 15, 'Color')
      const definitions = optionDefinitions(id)
      const bytes = Array(8).fill(0)
      if (Array.isArray(options)) {
        if (options.length > bytes.length) throw new RangeError('Expected up to eight option bytes')
        options.forEach((value, index) => { bytes[index] = integer(value, 0, 255, 'Option byte') })
      } else {
        for (const [key, value] of Object.entries(options)) {
          const option = definitions.find(option => option.name === key)
          if (!option) throw new RangeError(`Unknown option: ${key}`)
          bytes[option.index] = optionIndex(option, value)
        }
      }
      const typeName = moduleTypes.find(entry => entry.id === id).name
      const module = {
        type_id: id, type: typeName, page, position, options: bytes,
        name: checkName(name ?? typeName.slice(0, 16)), header_color: color > 7 ? 1 : color,
      }
      module.parameters = defaultParameters(module)
      requirePlacement(patch, module)
      const extended = patch.colors.length || !patch.modules.length
      if (!extended && color > 7) throw new RangeError('This patch has only legacy colors (1–7)')
      if (extended) patch.colors.push(color)
      patch.modules.push(module)
      return patch.modules.length - 1
    })
  }

  renamePatch(name) {
    this.#edit(patch => { patch.name = checkName(name) })
  }

  renameModule(index, name) {
    this.#edit(patch => { moduleAt(patch, index).name = checkName(name) })
  }

  setModuleColor(index, color) {
    this.#edit(patch => {
      const module = moduleAt(patch, index)
      integer(color, 1, patch.colors.length ? 15 : 7, 'Color')
      if (patch.colors.length) patch.colors[index] = color
      else module.header_color = color
    })
  }

  moveModule(index, { page, position }) {
    this.#edit(patch => {
      const module = moduleAt(patch, index)
      if (page !== undefined) module.page = integer(page, 0, pageCount(patch) - 1, 'Page index')
      if (position !== undefined) module.position = position
      requirePlacement(patch, module, index)
    })
  }

  deleteModule(index) {
    return this.#edit(patch => {
      moduleAt(patch, index)
      return removeModules(patch, new Set([index]))
    })
  }

  setOption(index, name, value) {
    return this.#edit(patch => {
      const module = moduleAt(patch, index)
      const option = optionDefinitions(module.type_id).find(option => option.name === name)
      if (!option) throw new RangeError(`Unknown option: ${name}`)
      const byte = optionIndex(option, value)
      const oldBlocks = moduleBlocks(module)
      const oldWidth = moduleWidth(module)
      if ((module.options?.[option.index] ?? 0) === byte) return { droppedConnections: [], droppedStars: [] }
      const options = module.options ??= []
      while (options.length <= option.index) options.push(0)
      options[option.index] = byte
      const newBlocks = moduleBlocks(module)
      const newWidth = moduleWidth(module)
      if (newWidth > oldWidth && !fixedHardwarePad(module)) {
        delete module.editor_grid_span
        requirePlacement(patch, module, index)
      } else if (module.editor_grid_span !== undefined) {
        module.editor_grid_span = Math.min(newWidth, module.editor_grid_span)
      }

      const oldKnobs = oldBlocks.filter(block => block.parameterIndex >= 0)
      const oldValues = module.parameters ?? []
      const values = new Map(oldKnobs.map(block => [block.name, oldValues[block.parameterIndex]]))
      module.parameters = newBlocks.filter(block => block.parameterIndex >= 0)
        .sort((a, b) => a.parameterIndex - b.parameterIndex)
        .map(block => values.get(block.name) ?? block.defaultRaw)
        .concat(oldValues.slice(oldKnobs.length))

      const remap = new Map(oldBlocks.flatMap(old => {
        const replacement = newBlocks.find(block => block.name === old.name)
        return replacement ? [[old.index, replacement.index]] : []
      }))
      const report = filterConnections(patch, cable => [cable.source, cable.destination].every(
        ([module, block]) => module !== index || remap.has(block)))
      for (const cable of patch.connections) {
        for (const endpoint of [cable.source, cable.destination]) {
          if (endpoint[0] === index) endpoint[1] = remap.get(endpoint[1])
        }
      }
      patch.starred = patch.starred.filter(star => {
        if (star.module !== index) return true
        if (remap.has(star.block)) {
          star.block = remap.get(star.block)
          return true
        }
        report.droppedStars.push(star)
        return false
      })
      return report
    })
  }

  setParam(index, key, raw) {
    integer(raw, 0, RAW_MAX, 'Raw parameter')
    this.#edit(patch => {
      const module = moduleAt(patch, index)
      setRaw(module, parameterBlock(module, key), raw)
    })
    return raw
  }

  setParamDisplay(index, key, value) {
    return this.setParam(index, key, rawFromDisplay(parameterBlock(moduleAt(this.#patch, index), key), value))
  }

  connect(source, destination, strength = { raw: 10000 }) {
    return this.#edit(patch => {
      const out = blockAt(patch, source)
      const input = blockAt(patch, destination)
      const issue = cableIssue(out?.signal, input?.signal)
      if (issue) throw new RangeError(issue[1])
      const cable = {
        source: [source[0], out.index], destination: [destination[0], input.index],
        strength: strengthWord(strength, out, input),
      }
      patch.connections.push(cable)
      return patch.connections.length - 1
    })
  }

  setConnectionStrength(index, strength) {
    return this.#edit(patch => {
      integer(index, 0, patch.connections.length - 1, 'Connection index')
      const cable = patch.connections[index]
      cable.strength = strengthWord(strength, blockAt(patch, cable.source), blockAt(patch, cable.destination))
      return cable.strength
    })
  }

  disconnect(index) {
    return this.#edit(patch => {
      integer(index, 0, patch.connections.length - 1, 'Connection index')
      return filterConnections(patch, (cable, i) => i !== index)
    })
  }

  addPage(name = '') {
    return this.#edit(patch => {
      const index = pageCount(patch)
      if (index >= MAX_PAGE_NAMES) throw new RangeError('Page names exceed the binary size limit')
      while (patch.pages.length < index) patch.pages.push({ name: '' })
      patch.pages.push({ name: checkName(name) })
      return index
    })
  }

  renamePage(index, name) {
    this.#edit(patch => {
      integer(index, 0, Math.min(pageCount(patch) - 1, MAX_PAGE_NAMES - 1), 'Page index')
      while (patch.pages.length <= index) patch.pages.push({ name: '' })
      patch.pages[index] = { ...patch.pages[index], name: checkName(name) }
    })
  }

  deletePage(index) {
    return this.#edit(patch => {
      integer(index, 0, pageCount(patch) - 1, 'Page index')
      const removed = new Set(patch.modules.flatMap((module, i) => (module.page ?? 0) === index ? [i] : []))
      const report = removeModules(patch, removed)
      patch.pages.splice(index, 1)
      for (const module of patch.modules) if ((module.page ?? 0) > index) module.page--
      return report
    })
  }

  starParam(index, key, midi_cc = null) {
    if (midi_cc !== null) integer(midi_cc, 0, 127, 'MIDI CC')
    return this.#edit(patch => {
      const { index: block } = parameterBlock(moduleAt(patch, index), key)
      const star = patch.starred.find(star => star.module === index && star.block === block)
      if (star) star.midi_cc = midi_cc
      else patch.starred.push({ module: index, block, midi_cc })
    })
  }

  unstarParam(index, key) {
    this.#edit(patch => {
      const { index: block } = parameterBlock(moduleAt(patch, index), key)
      patch.starred = patch.starred.filter(star => star.module !== index || star.block !== block)
    })
  }
}

export function newPatch(name = '') {
  return new PatchModel({ name: checkName(name), modules: [], connections: [], pages: [{ name: '' }], starred: [], colors: [] })
}
