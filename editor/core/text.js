// ZOIA patch text v1. Quoted strings and inline maps use JSON syntax.
import { moduleBlocks, moduleTypes, optionDefinitions, optionIndex, rawFromDisplay } from './modules.js'

const HEADER = 'ZOIA 1'
const json = JSON.stringify
const quote = /"(?:[^"\\]|\\.)*"/.source
const endpoint = /([A-Za-z_][A-Za-z_0-9]*|@\d+)\.([A-Za-z_][A-Za-z_0-9]*|#\d+)/.source
const cablePattern = new RegExp(`^  cable ${endpoint} -> ${endpoint} = (\\d+)$`)
const knobPattern = /^    knob ([A-Za-z_][A-Za-z_0-9]*|#\d+) = (.+)$/
const modulePattern = new RegExp('^  module ([A-Za-z_][A-Za-z_0-9]*) (\\d+)(?: ' + '(' + quote + '))?$')

function aliasFor(module, used) {
  const base = (module.name || module.type || 'module').replace(/\W/g, '_').replace(/^(?=\d)/, '_')
  let alias = base
  for (let suffix = 2; used.has(alias); suffix++) alias = `${base}_${suffix}`
  used.add(alias)
  return alias
}

function readableOptions(typeId, bytes = []) {
  const definitions = moduleTypes.some(type => type.id === typeId) ? optionDefinitions(typeId) : []
  const values = {}
  const roundTrip = Array(8).fill(0)
  for (const option of definitions) {
    const index = bytes[option.index]
    if (option.values[index] !== undefined) {
      values[option.name] = option.values[index]
      roundTrip[option.index] = index
    }
  }
  return json(bytes) === json(roundTrip) ? values : bytes
}

function parseOptions(record, values) {
  if (Array.isArray(values)) return values
  const definitions = optionDefinitions(record.type_id)
  const bytes = Array(8).fill(0)
  for (const [name, value] of Object.entries(values)) {
    const option = definitions.find(option => option.name === name)
    if (!option) throw new Error(`Unknown option: ${name}`)
    bytes[option.index] = optionIndex(option, value)
  }
  return bytes
}

export function patchToYaml(patch) {
  const { name, pages = [], modules = [], connections = [], ...opaque } = patch
  const lines = [HEADER]
  if (name !== undefined) lines.push(`  name ${json(name)}`)
  const pageExtras = []
  for (const [index, { name = '', ...extra }] of pages.entries()) {
    lines.push(`  page ${json(name)}`)
    if (Object.keys(extra).length) pageExtras.push([index, extra])
  }
  const used = new Set()
  const aliases = modules.map(module => aliasFor(module, used))
  const layouts = modules.map(module => moduleBlocks(module, { musical: false }))
  const moduleExtras = []
  for (const [index, module] of modules.entries()) {
    const { type_id, type, name = '', page = 0, position, options, parameters = [], ...extra } = module
    const title = type ?? moduleTypes.find(entry => entry.id === type_id)?.name
    lines.push(`  module ${aliases[index]} ${type_id}${title ? ' ' + json(title) : ''}`,
      `    name ${json(name)}`, `    at ${page} ${position}`,
      `    options ${json(readableOptions(type_id, options))}`)
    for (const [slot, raw] of parameters.entries()) {
      const block = layouts[index].find(block => block.parameterIndex === slot)
      if (block && raw >= 0 && raw <= 65535) {
        const value = block.display(raw)
        const display = `${value} ${block.units}`
        const rendered = rawFromDisplay(block, value) === raw ? display : `raw ${raw} # ${display}`
        lines.push(`    knob ${block.name} = ${rendered}`)
      } else lines.push(`    knob #${slot} = raw ${raw}`)
    }
    if (Object.keys(extra).length) moduleExtras.push([index, extra])
  }
  const formatEndpoint = ([module, index]) => {
    const name = layouts[module]?.find(block => block.index === index)?.name
    return `${aliases[module] ?? '@' + module}.${name ?? '#' + index}`
  }
  for (const cable of connections) {
    lines.push(`  cable ${formatEndpoint(cable.source)} -> ${formatEndpoint(cable.destination)} = ${cable.strength}`)
  }
  if (pageExtras.length) opaque.pageExtras = pageExtras
  if (moduleExtras.length) opaque.moduleExtras = moduleExtras
  if (Object.keys(opaque).length) lines.push(`  opaque ${json(opaque)}`)
  return lines.join('\n') + '\n'
}

function parseKnobs(module, entries) {
  const blocks = moduleBlocks(module, { musical: false })
  for (const [key, expression] of entries) {
    const block = key.startsWith('#') ? undefined : blocks.find(block => block.name === key && block.parameterIndex >= 0)
    const slot = key.startsWith('#') ? Number(key.slice(1)) : block?.parameterIndex
    if (!Number.isSafeInteger(slot) || slot >= 8192) throw new Error(`Unknown knob: ${key}`)
    const raw = /^raw (\d+)(?: # .*)?$/.exec(expression)
    let value
    if (raw) value = Number(raw[1])
    else {
      const separator = expression.indexOf(' ')
      if (!block || separator < 1 || expression.slice(separator + 1) !== block.units) {
        throw new Error(`Expected ${block?.units ?? 'raw'} for ${key}`)
      }
      value = rawFromDisplay(block, Number(expression.slice(0, separator)))
    }
    while (module.parameters.length <= slot) {
      module.parameters.push(blocks.find(block => block.parameterIndex === module.parameters.length)?.defaultRaw ?? 0)
    }
    module.parameters[slot] = value
  }
}

export function yamlToPatch(source) {
  const [header, ...lines] = source.trimEnd().split(/\r?\n/)
  if (header !== HEADER) throw new Error(`Expected ${HEADER} header`)
  const patch = { modules: [], pages: [], connections: [] }
  const aliases = new Map()
  const knobs = []
  const cables = []
  let module
  let opaque = {}
  for (const [index, line] of lines.entries()) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue
    const declaration = modulePattern.exec(line)
    const cable = cablePattern.exec(line)
    const knob = knobPattern.exec(line)
    const at = /^    at (\d+) (\d+)$/.exec(line)
    if (declaration) {
      const [, alias, type, title] = declaration
      if (aliases.has(alias)) throw new Error(`Duplicate module alias: ${alias}`)
      aliases.set(alias, patch.modules.length)
      const type_id = Number(type)
      module = { type_id, options: [], parameters: [] }
      if (title) module.type = JSON.parse(title)
      patch.modules.push(module)
      knobs.push([])
    } else if (cable) {
      cables.push(cable.slice(1))
      module = undefined
    } else if (module && knob) knobs.at(-1).push(knob.slice(1))
    else if (module && at) [module.page, module.position] = at.slice(1).map(Number)
    else if (module && line.startsWith('    options ')) module.options = parseOptions(module, JSON.parse(line.slice(12)))
    else if (module && line.startsWith('    name ')) module.name = JSON.parse(line.slice(9))
    else if (line.startsWith('  name ')) patch.name = JSON.parse(line.slice(7))
    else if (line.startsWith('  page ')) patch.pages.push({ name: JSON.parse(line.slice(7)) })
    else if (line.startsWith('  opaque ')) opaque = JSON.parse(line.slice(9))
    else throw new SyntaxError(`Invalid patch text on line ${index + 2}: ${line}`)
  }
  const { pageExtras = [], moduleExtras = [], ...patchExtras } = opaque
  Object.assign(patch, patchExtras)
  for (const [index, extra] of pageExtras) Object.assign(patch.pages[index], extra)
  for (const [index, module] of patch.modules.entries()) {
    const extra = moduleExtras.find(([i]) => i === index)?.[1]
    Object.assign(module, extra)
    parseKnobs(module, knobs[index])
    if (module.position === undefined) throw new SyntaxError(`Missing placement for module ${index}`)
  }

  const layouts = patch.modules.map(module => moduleBlocks(module))
  const readEndpoint = (alias, key) => {
    const module = alias.startsWith('@') ? Number(alias.slice(1)) : aliases.get(alias)
    const index = key.startsWith('#') ? Number(key.slice(1)) : layouts[module]?.find(block => block.name === key)?.index
    if (module === undefined || index === undefined) throw new Error(`Unknown cable endpoint: ${alias}.${key}`)
    return [module, index]
  }
  for (const [from, output, to, input, strength] of cables) {
    patch.connections.push({
      source: readEndpoint(from, output), destination: readEndpoint(to, input), strength: Number(strength),
    })
  }
  return patch
}
