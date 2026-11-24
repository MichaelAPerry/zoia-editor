import { audio } from './audio.mjs'
import { controls } from './control.mjs'
import { extendedAudio } from './extended-audio.mjs'
import { extendedControls } from './extended-control.mjs'
import { interfaces } from './interfaces.mjs'
import { clean, dcBlock, randomSource, sampleRate } from './dsp.mjs'
import { clamp, dbGain, layout, scaled } from './layout.mjs'
import { moduleIndex } from './module-index.mjs'

export { sampleRate }
export const defaultBlockSize = 64

const factories = { ...audio, ...controls, ...interfaces, ...extendedAudio, ...extendedControls }

export function unsupportedModules(patch) {
  if (patch.empty) return []
  if (patch.decode_error) return [`Undecodable patch (${patch.decode_error})`]
  return [...new Set(patch.modules.filter(module => !Object.hasOwn(factories, module.type_id))
    .map(module => moduleIndex[module.type_id]?.[0] ?? module.type ?? `Type ${module.type_id}`))].sort()
}

export function connectionGain(raw, audioConnection) {
  if (raw === 0) return 0
  return audioConnection ? dbGain((raw - 10000) / 100) : raw / 10000
}

function createModule(record, index, blockSize, seed, bpm) {
  const id = record.type_id
  const { name, options, active, parameters, knobNames } = layout(record)
  const ports = Object.fromEntries(active.map(([key, position, type, isKnob]) => [key, {
    key, position, type, isKnob, value: 0, lastUnitInput: undefined, unitValue: 0, base: isKnob ? parameters[key]?.[0] ?? 0 : 0,
    sources: [], history: null,
  }]))
  const byIndex = new Map(Object.values(ports).map(port => [port.position, port]))
  const overrides = new Map()
  const externalCV = id === 54 ? 'cv_output' : id >= 88 && id <= 91 ? 'cv_out' : undefined
  const bytes = Uint8Array.from(record.saved_data_hex?.match(/../g) ?? [], pair => parseInt(pair, 16))
  const data = new DataView(bytes.buffer)
  for (const [i, key] of knobNames.entries()) {
    if (Number.isFinite(record.parameters?.[i])) ports[key].base = record.parameters[i] / 65535
  }
  const knob = (key, fallback) => overrides.get(key) ?? ports[key]?.base ?? fallback
  const p = (key, fallback = 0) => ports[key]?.value ?? fallback
  const unit = key => {
    const port = ports[key]
    const definition = parameters[key]
    if (!port) return scaled(definition?.[0] ?? 0, definition)
    if (port.lastUnitInput !== port.value) {
      port.lastUnitInput = port.value
      port.unitValue = scaled(port.value, definition)
    }
    return port.unitValue
  }
  const put = (key, value) => {
    const port = ports[key]
    if (port) port.value = clean(value)
  }
  const context = {
    id, options, p, put, unit, knob, bpm,
    has: key => Object.hasOwn(ports, key),
    connected: key => Boolean(ports[key]?.sources.length),
    hasSaved: bytes.length > 0,
    u8: offset => bytes[offset] ?? 0,
    u16: offset => offset + 2 <= bytes.length ? data.getUint16(offset, true) : 0,
    u32: (offset, fallback = 0) => {
      if (offset + 4 > bytes.length) return fallback
      const value = data.getUint32(offset, true)
      return value > 0 && value <= 60 * sampleRate ? value : fallback
    },
    savedLength: bytes.length,
    f32: (offset, fallback) => {
      if (offset + 4 > bytes.length) return fallback
      const value = data.getFloat32(offset, true)
      return value >= 0.025 && value <= 30 ? value : fallback
    },
    random: randomSource(seed ^ Math.imul(index + 1, 0x9e3779b1)),
  }
  const input = Object.values(ports).filter(port => port.type.endsWith('_in') || port.isKnob)
  const process = factories[id]?.(context) ?? (() => {})
  return {
    record, byIndex, ports, aliases: [record.name, name], dependencies: [],
    set(key, value) {
      if (key === 'state' && [15, 44, 56, 97, 98].includes(id)) overrides.set(key, value)
      else if (externalCV && (key === 'value' || key === externalCV)) overrides.set('value', value)
      else if (ports[key]?.isKnob) ports[key].base = value
      else throw Error(`Module ${index} has no adjustable parameter "${key}"`)
    },
    process(io, slot) {
      for (const port of input) {
        let value = port.base
        for (const edge of port.sources) value += edge.gain * (edge.delayed ? edge.source.history[slot] : edge.source.value)
        port.value = port.type === 'audio_in' ? clean(value) : clamp(value, -1, 1)
      }
      process(io)
    },
    allocateHistory(port) {
      port.history ??= new Float64Array(blockSize)
    },
  }
}

export function createEngine(patch, { blockSize = defaultBlockSize, seed = 1, bpm = 0, acCoupledOutput = false } = {}) {
  if (patch.decode_error) throw Error(`Patch could not be decoded: ${patch.decode_error}`)
  if (patch.empty) patch = { ...patch, modules: [], connections: [] }
  if (!Array.isArray(patch.modules) || !Array.isArray(patch.connections)) throw Error('Expected decoded patch JSON')
  if (!Number.isInteger(blockSize) || blockSize < 1 || blockSize > 4096) throw Error('Invalid block size')
  if (!Number.isFinite(bpm) || bpm < 0 || bpm > 2400) throw Error('BPM must be between 0 and 2400')
  const modules = patch.modules.map((record, i) => createModule(record, i, blockSize, seed, bpm))
  const unsupported = unsupportedModules(patch)
  const issues = []
  for (const connection of patch.connections) {
    const [from, fromBlock] = connection.source, [to, toBlock] = connection.destination
    const sourceModule = modules[from], destinationModule = modules[to]
    if (!sourceModule || !destinationModule || !Object.hasOwn(factories, sourceModule.record.type_id)
      || !Object.hasOwn(factories, destinationModule.record.type_id)) continue
    const source = sourceModule.byIndex.get(fromBlock), dest = destinationModule.byIndex.get(toBlock)
    if (!source || !dest || !dest.type.endsWith('_in')) {
      issues.push(`Inactive or unmapped connection ${from}.${fromBlock} → ${to}.${toBlock}`)
      continue
    }
    const edge = { source, gain: connectionGain(connection.strength, source.type === 'audio_out' && dest.type === 'audio_in'),
      delayed: false, from }
    if (!edge.gain) continue
    dest.sources.push(edge)
    destinationModule.dependencies.push(edge)
  }

  const order = [], history = []
  const state = new Uint8Array(modules.length)
  function visit(index) {
    state[index] = 1
    const module = modules[index]
    for (const edge of module.dependencies) {
      if (!state[edge.from]) visit(edge.from)
      else if (state[edge.from] === 1) {
        edge.delayed = true
        if (!edge.source.history) {
          modules[edge.from].allocateHistory(edge.source)
          history.push(edge.source)
        }
      }
    }
    state[index] = 2
    order.push(module)
  }
  for (let i = 0; i < modules.length; i++) if (!state[i]) visit(i)

  const io = { left: 0, right: 0, outL: 0, outR: 0, headphoneGain: 1 }
  const coupleLeft = acCoupledOutput ? dcBlock(15) : null
  const coupleRight = acCoupledOutput ? dcBlock(15) : null
  let slot = 0
  return {
    unsupported, issues, blockSize,
    set(module, key, value) {
      if (!Number.isFinite(value) || value < -1 || value > 1) throw Error('Control value must be between -1 and 1')
      const matches = /^\d+$/.test(String(module)) ? [modules[Number(module)]].filter(Boolean)
        : modules.filter(item => item.aliases.includes(module))
      if (matches.length !== 1) throw Error(`Expected one module matching "${module}", found ${matches.length}`)
      matches[0].set(key, value)
    },
    processBlock(left, right, outL, outR) {
      const size = outL.length
      if (size > blockSize || outR.length !== size) throw Error('Invalid output block length')
      for (let i = 0; i < size; i++) {
        io.left = clean(left?.[i] ?? 0)
        io.right = clean(right?.[i] ?? io.left)
        io.outL = io.outR = 0
        io.headphoneGain = 1
        for (const module of order) module.process(io, slot)
        for (const port of history) port.history[slot] = clamp(port.value, -1, 1)
        slot = (slot + 1) % blockSize
        const l = io.outL * io.headphoneGain, r = io.outR * io.headphoneGain
        outL[i] = coupleLeft ? coupleLeft(l) : l
        outR[i] = coupleRight ? coupleRight(r) : r
      }
    },
  }
}
