import { decodePatch, encodePatch } from '../core/encode.js'
import { GRID_COLUMNS, fixedHardwarePad, gridFootprint, moduleBlocks, newPatch, PatchModel, moduleTypes, placementIssue } from '../core/model.js'
import { moduleWidth } from '../core/modules.js'
import { patchToYaml, yamlToPatch } from '../core/text.js'
import { Simulator } from './audio.js'
import { initCorpus } from './corpus.js'
import { oledModel, paintOled } from './display.js'
import { renderInspector } from './inspector.js'
import { DEFAULT_COLORS, firstOccupiedPage, gridHit, groupModules } from './logic.js'
import { $, buildPrint, button, cableDb, colors, display, drawCables, el, endpoint, knobRaw, label, moduleColor,
  moduleName, padFace, padLight, pageName, pagePads } from './view.js'

const storageKey = 'zoia-editor.patch.v1'
const readStorage = key => { try { return localStorage.getItem(key) } catch { return null } }
const writeStorage = (key, value) => { try { localStorage.setItem(key, value) } catch { /* Optional persistence. */ } }

function starter() {
  const model = newPatch('Test Thru')
  model.renamePage(0, 'Main')
  const input = model.addModule('Audio Input', { position: 8, name: 'Audio In', color: 5 })
  const output = model.addModule('Audio Output', { position: 14, name: 'Audio Out', color: 8 })
  model.connect([input, 'output_L'], [output, 'input_L'])
  model.connect([input, 'output_R'], [output, 'input_R'])
  return model.patch
}

function restore() {
  try {
    const saved = readStorage(storageKey)
    if (saved) {
      const patch = JSON.parse(saved)
      if (patch && typeof patch === 'object' && !Array.isArray(patch)) {
        encodePatch(patch)
        return patch
      }
    }
  } catch { /* Fall back to the starter patch. */ }
  return starter()
}

let model = new PatchModel(restore())
let patch = model.patch
let page = firstOccupiedPage(patch)
let selection = null
let armed = null
let placement = null
let drag = null
let audioFile = null
let playing = false
let transport = 0
let patchLoad = 0
let audioFileLoad = 0
const buttonStates = new Map()
let engineIssues = []
let activeBlock = null
let knobPending = null
let knobTimer = 0
let cpuText = 'CPU —'

function status(message = '', kind = '') {
  $('status').textContent = message
  $('status').className = kind
}

function download(data, name, type) {
  const url = URL.createObjectURL(new Blob([data], { type }))
  const link = el('a')
  link.href = url
  link.download = name
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

const filename = () => (patch.name || 'Untitled').trim().replace(/[^a-z0-9_-]+/gi, '_') || 'Untitled'
function pageIndices() {
  const count = Math.max(1, model.pageCount)
  if (count <= 2046) return Array.from({ length: count }, (_, index) => index)
  // A damaged or unusual import can encode a sparse 32-bit page index.
  const defined = (patch.pages ?? []).map((_, index) => index)
  const occupied = (patch.modules ?? []).map(record => record.page ?? 0)
  return [...new Set([0, ...defined, ...occupied])].sort((a, b) => a - b)
}

const simulator = new Simulator({
  meters({ peak, dspLoad = null }) {
    for (const [i, side] of ['left', 'right'].entries()) {
      $(side).value = Math.min(1, peak[i])
      $(`${side}-db`).textContent = `${peak[i] > 0 ? (20 * Math.log10(peak[i])).toFixed(1) : '−∞'} dB`
    }
    $('cpu').textContent = dspLoad === null ? 'DSP load —' : `DSP load ${Math.round(dspLoad)}%`
    cpuText = dspLoad === null ? 'CPU —' : `CPU ${Math.round(dspLoad)}%`
    if ($('oled-cpu')) $('oled-cpu').textContent = cpuText
  },
  report(data) {
    if (data.type === 'error') status(data.message, 'error')
    else {
      engineIssues = [
        ...(data.unsupported ?? []).map(type => ({ severity: 'warning', message: `Simulator module unsupported: ${type}` })),
        ...(data.issues ?? []).map(issue => ({ severity: 'warning', message: String(issue) })),
      ]
      renderValidation()
    }
  },
  recording(wav) {
    download(wav, `${filename()}.wav`, 'audio/wav')
    $('record').disabled = false
    $('record').textContent = 'Record 10 s to WAV'
    status('WAV recording saved.')
  },
})

function sync({ regraph = false, full = true } = {}) {
  patch = model.patch
  const pages = pageIndices()
  if (!pages.includes(page)) page = pages.findLast(index => index < page) ?? pages[0]
  writeStorage(storageKey, JSON.stringify(patch))
  $('undo').disabled = !model.canUndo
  $('redo').disabled = !model.canRedo
  if (regraph) {
    buttonStates.clear()
    engineIssues = []
    simulator.send('loadPatch', { patch })
  }
  if (full) render()
}

function edit(action, { regraph = true, full = true } = {}) {
  const previous = patch
  try {
    const result = action()
    sync({ regraph, full })
    const dropped = result?.droppedConnections ?? []
    const names = dropped.map(cable =>
      `${endpoint(previous, cable.source).text} → ${endpoint(previous, cable.destination).text}`)
    const summary = [
      dropped.length ? `Dropped ${dropped.length} cable(s) · ${names.join(' · ')}` : '',
      result?.droppedStars?.length ? `Removed ${result.droppedStars.length} star(s).` : '',
    ].filter(Boolean).join(' · ')
    status(summary, summary ? 'notice' : '')
    return result
  } catch (error) {
    if (full) render()
    status(error.message, 'error')
    return undefined
  }
}

function open(next, message, slot) {
  clearTimeout(knobTimer)
  knobPending = activeBlock = null
  armed = placement = selection = null
  page = firstOccupiedPage(next)
  model = new PatchModel(next)
  if (slot !== undefined) $('slot').value = slot
  sync({ regraph: true })
  status(message)
}

function openBin(bytes, file) {
  const decoded = decodePatch(bytes)
  const slot = /(?:^|_)(\d{3})_zoia_/i.exec(file)
  open(decoded, `Opened ${file}`, slot ? Number(slot[1]) : undefined)
}

function select(kind, index) {
  commitKnob()
  selection = { kind, index }
  renderGrid()
  showInspector()
}

function removeSelection() {
  if (!selection) return
  const previous = selection
  edit(() => {
    const result = previous.kind === 'module' ? model.deleteModule(previous.index) : model.disconnect(previous.index)
    selection = armed = null
    return result
  })
}

function history(method) {
  commitKnob()
  if (!model[method]()) return
  selection = armed = placement = null
  sync({ regraph: true })
  status(method === 'undo' ? 'Edit undone.' : 'Edit redone.')
}

function renderPages() {
  const indices = pageIndices()
  const pages = indices.map(index => {
    const tab = button(pageName(patch, index), () => {
      page = index
      renderPages()
      renderGrid()
      $('pages').querySelector('[aria-current=page]').focus()
    })
    if (index === page) tab.setAttribute('aria-current', 'page')
    return tab
  })
  $('pages').replaceChildren(...pages)
  $('delete-page').disabled = indices.length <= 1
}

function renderPalette() {
  const query = $('module-search').value
  const open = new Set([...$('palette').querySelectorAll('details[open]')].map(details => details.dataset.group))
  const firstRender = !$('palette').children.length
  const groups = groupModules(moduleTypes, query)
  $('palette').replaceChildren(...groups.map(group => {
    const details = el('details')
    details.dataset.group = group.label
    details.open = Boolean(query.trim()) || open.has(group.label) || (firstRender && group.index === 0)
    details.append(el('summary', group.label))
    group.types.forEach(type => {
      const color = DEFAULT_COLORS[group.index]
      const item = button(type.name, () => {
        placement = placement?.id === type.id ? null : { ...type, color }
        armed = null
        renderPlacement()
        renderGrid()
      }, 'palette-item')
      item.dataset.type = type.id
      item.draggable = true
      item.ondragstart = event => startDrag(event, { type: { ...type, color } })
      item.ondragend = () => {
        drag = null
        showPlacementPreview(null)
      }
      details.append(item)
    })
    return details
  }))
  if (!groups.length) $('palette').append(el('p', 'No matching modules.', 'meta'))
  renderPlacement()
}

function renderPlacement() {
  $('palette').querySelectorAll('[data-type]').forEach(item =>
    item.setAttribute('aria-pressed', Number(item.dataset.type) === placement?.id))
  renderOled()
  $('grid-help').textContent = placement ? `Choose a pad for ${placement.name}. Esc cancels.` :
    armed ? `Cable from ${endpoint(patch, armed).text}. Choose an input on any page. Esc cancels.` :
      'Drag modules to move them. For a cable, click an output pad, then an input pad.'
}

function startDrag(event, payload) {
  drag = payload
  event.dataTransfer.setData('text/plain', payload.type?.name ?? 'ZOIA module')
  event.dataTransfer.effectAllowed = payload.type ? 'copy' : 'move'
}

function addAt(type, position) {
  edit(() => {
    const color = patch.modules?.length && !patch.colors?.length && type.color > 7 ? 1 : type.color
    const index = model.addModule(type.id, { page, position, color })
    placement = armed = null
    $('module-search').value = ''
    renderPalette()
    selection = { kind: 'module', index }
  })
}

function activateJack(index, block) {
  if (armed && block?.signal.endsWith('_in')) {
    edit(() => {
      const cableIndex = model.connect(armed, [index, block.index])
      selection = { kind: 'cable', index: cableIndex }
      armed = null
    })
    return
  }
  if (block?.signal.endsWith('_out')) {
    armed = armed?.[0] === index && armed[1] === block.index ? null : [index, block.index]
  }
  select('module', index)
}

function activatePad(cell, position, direction) {
  if (placement) {
    addAt(placement, position)
    return
  }
  if (!cell) {
    selection = armed = null
    renderGrid()
    showInspector()
    return
  }
  const wanted = direction ?? (armed ? 'in' : 'out')
  let matching = cell.blocks.filter(block => block.signal.endsWith(`_${wanted}`))
  // While a cable is armed, clicking a pad that only has outputs switches the cable source.
  if (!matching.length && armed && !direction) matching = cell.blocks.filter(block => block.signal.endsWith('_out'))
  if (matching.length > 1) {
    select('module', cell.index)
    $('inspector').querySelector(`.jack-list .port-${wanted}`)?.focus()
    return
  }
  activateJack(cell.index, matching[0])
}

function showPlacementPreview(position, type = placement) {
  const grid = $('grid')
  for (const pad of grid.querySelectorAll('.ghost-fit, .ghost-blocked')) {
    pad.classList.remove('ghost-fit', 'ghost-blocked')
  }
  if (!type || position === null) return
  const candidate = { type_id: type.id, page, position }
  const span = moduleWidth(candidate)
  const className = placementIssue(patch, candidate) ? 'ghost-blocked' : 'ghost-fit'
  for (let slot = 0; slot < span; slot++) grid.children[position + slot]?.classList.add(className)
}

function renderGrid() {
  renderPlacement()
  drawCables(patch, page, selection?.kind === 'cable' ? selection.index : null,
    selection?.kind === 'module' ? selection.index : null,
    index => select('cable', index), (remote, index) => {
      page = remote.page
      renderPages()
      select('cable', index)
    })
  const knob = selectedKnob()
  const pads = pagePads(patch, page).map(([first, ...overlapping], position) => {
    const cell = [first, ...overlapping].find(cell => selection?.kind === 'module' && cell?.index === selection.index) ?? first
    const pad = button(null, event => {
      const shown = cell?.blocks.find(block => block.parameterIndex >= 0) ?? cell?.blocks[0]
      activeBlock = shown ? { module: cell.index, name: shown.name } : null
      activatePad(cell, position, event.target.dataset.direction)
      if (!document.activeElement?.closest('#inspector')) $('grid').children[position]?.focus()
    }, 'pad')
    pad.dataset.position = position
    if (cell) {
      const { index, blocks, record, slot, span } = cell
      pad.dataset.module = index
      if (blocks[0]) pad.dataset.signal = blocks[0].signal
      pad.classList.toggle('join-left', slot > 0 && position % GRID_COLUMNS !== 0)
      pad.classList.toggle('join-right', slot + 1 < span && position % GRID_COLUMNS !== GRID_COLUMNS - 1)
      pad.classList.toggle('join-up', slot >= GRID_COLUMNS)
      pad.classList.toggle('join-down', slot + GRID_COLUMNS < span)
      pad.classList.toggle('has-port', blocks.length > 0)
      pad.classList.toggle('is-target', Boolean(armed && blocks.some(block => block.signal.endsWith('_in'))))
      pad.classList.add('occupied')
      pad.classList.toggle('is-selected', selection?.kind === 'module' && selection.index === index)
      pad.classList.toggle('is-source', armed?.[0] === index && blocks.some(block => block.index === armed[1]))
      const hex = colors[moduleColor(patch, index) - 1]?.[1] ?? '#75858a'
      const chosen = selection?.kind === 'module' && selection.index === index
      const lit = chosen && knob?.block && blocks.some(block => block.name === knob.block.name)
      const light = padLight(hex, lit ? 1 : chosen ? .8 : .55)
      pad.classList.toggle('is-lit', Boolean(lit))
      pad.style.setProperty('--pad-color', hex)
      pad.style.setProperty('--pad-bg', light.background)
      pad.style.setProperty('--pad-ink', light.ink)
      const jacks = blocks.map(block => `${label(block.name)} (${block.signal.endsWith('_out') ? 'output' : 'input'})`)
      const description = `${moduleName(record)} · ${jacks.join(', ') || 'Unknown block'}`
      pad.setAttribute('aria-label', description)
      pad.title = description
      pad.draggable = true
      pad.ondragstart = event => startDrag(event, { index, slot })
      pad.ondragend = () => { drag = null }
    } else {
      pad.setAttribute('aria-label', `Empty pad ${position + 1}`)
    }
    pad.append(padFace(cell, true))
    return pad
  })
  $('grid').replaceChildren(...pads)
  const hardware = patch.modules?.flatMap((record, index) => {
    if ((record.page ?? 0) !== page || !fixedHardwarePad(record)) return []
    const block = moduleBlocks(record)[0]
    const out = block?.signal.endsWith('_out')
    const pad = button(`${out ? '◆' : '●'} ${moduleName(record)}`, () => activateJack(index, block),
      out ? 'port-out' : 'port-in')
    if (armed && !out) pad.classList.add('hardware-target')
    return [pad]
  }) ?? []
  $('hardware-pads').replaceChildren(...hardware)
}

function showInspector() {
  renderOled()
  const index = selection?.index
  renderInspector(patch, selection, {
    name: name => edit(() => model.renameModule(index, name), { regraph: false }),
    color: color => edit(() => model.setModuleColor(index, color), { regraph: false }),
    option: (name, value) => edit(() => {
      const changes = model.setOption(index, name, value)
      armed = null
      return changes
    }),
    strength: strength => edit(() => model.setConnectionStrength(index, strength)),
    notice: message => status(message, 'notice'),
    jack: block => activateJack(index, block),
    span: selection?.kind === 'module' ? gridFootprint(patch, patch.modules[index]) : 0,
    remove: removeSelection,
    star: (block, starred) => edit(() => {
      if (starred) model.unstarParam(index, block)
      else model.starParam(index, block)
    }, { regraph: false }),
    preview: (block, raw) => simulator.send('setParam', { module: index, block, raw }),
    param: (block, value, inUnits) => {
      const raw = edit(() => inUnits ? model.setParamDisplay(index, block, value)
        : model.setParam(index, block, value), { regraph: false, full: false })
      if (raw !== undefined) simulator.send('setParam', { module: index, block, raw })
      return raw
    },
  })
}

function renderValidation() {
  const issues = [...model.validate(), ...engineIssues]
  const items = issues.map(issue => {
    const li = el('li', null, issue.severity)
    const message = `${issue.severity === 'error' ? 'Error' : 'Warning'} · ${issue.message}`
    const cable = patch.connections?.[issue.connection]
    const record = patch.modules?.[issue.module]
    if (record || cable) {
      li.append(button(message, () => {
        page = record?.page ?? (cable ? endpoint(patch, cable.source).page : 0)
        renderPages()
        select(record ? 'module' : 'cable', record ? issue.module : issue.connection)
      }, issue.severity))
    } else li.textContent = message
    return li
  })
  $('validation').replaceChildren(...(items.length ? items : [el('li', 'No validation issues.', 'meta')]))
}

function renderPerformance() {
  const entries = (patch.modules ?? []).map((record, index) => ({ index, record }))
  function control(text, modules, title) {
    const node = button(text)
    node.title = title
    node.disabled = !modules.length
    let held = false
    const isLatching = record => record.type_id !== 56 && record.options?.[record.type_id === 44 ? 1 : 0] === 1
    const resting = record => record.type_id !== 56 && record.options?.[record.type_id === 44 ? 2 : 1] === 1
    const current = (index, record) => buttonStates.get(index) ??
      (isLatching(record) && record.saved_data_hex ? parseInt(record.saved_data_hex.slice(0, 2), 16) !== 0 : resting(record))
    function update(down) {
      if (held === down) return
      held = down
      for (const { index, record } of modules) {
        if (!down && isLatching(record)) continue
        const state = isLatching(record) ? !current(index, record) : resting(record) !== down
        buttonStates.set(index, state)
        simulator.send('setState', { module: index, state })
      }
      showState()
    }
    function showState() {
      node.setAttribute('aria-pressed', modules.some(({ index, record }) => current(index, record) !== resting(record)))
    }
    showState()
    node.onpointerdown = event => {
      if (event.button !== 0) return
      node.setPointerCapture(event.pointerId)
      update(true)
    }
    node.onlostpointercapture = node.onpointerup = node.onpointercancel = () => update(false)
    node.onkeydown = event => {
      if (![' ', 'Enter'].includes(event.key)) return
      event.preventDefault()
      update(true)
    }
    node.onkeyup = event => { if ([' ', 'Enter'].includes(event.key)) update(false) }
    node.onblur = () => update(false)
    node.onclick = event => {
      if (event.detail === 0) { update(true); update(false) }
    }
    return node
  }
  $('stomps').replaceChildren(...['Left', 'Middle', 'Right'].map((side, number) => {
    const matches = entries.filter(({ record }) => record.type_id === 44 && (record.options?.[0] ?? 0) === number)
    const switchName = ['SELECT', 'SCROLL', 'BYPASS'][number]
    const stomp = control('', matches, matches.length ? `${switchName} (${side}) · ${matches.map(({ record }) => moduleName(record)).join(', ')}`
      : `${switchName} (${side}): no Stompswitch module assigned`)
    stomp.className = 'stomp'
    stomp.dataset.label = switchName
    stomp.setAttribute('aria-label', `${switchName} stompswitch (${side.toLowerCase()})`)
    return stomp
  }))
  const buttons = entries.filter(({ record }) => [15, 56, 97, 98].includes(record.type_id) ||
    (record.type_id === 44 && record.options?.[0] === 3))
  $('buttons').replaceChildren(...buttons.map(entry =>
    control(moduleName(entry.record), [entry], pageName(patch, entry.record.page ?? 0))))
  if (!buttons.length) $('buttons').append(el('small', 'No pushbuttons on this patch.'))
}

function selectedKnob() {
  if (selection?.kind !== 'module') return null
  const record = patch.modules?.[selection.index]
  if (!record) return null
  const blocks = moduleBlocks(record)
  const named = activeBlock?.module === selection.index && blocks.find(block => block.name === activeBlock.name)
  const block = named || blocks.find(candidate => candidate.parameterIndex >= 0) || blocks[0]
  if (!block) return null
  const adjustable = block.parameterIndex >= 0
  const pending = knobPending?.module === selection.index && knobPending.block === block.name ? knobPending.raw : null
  return { index: selection.index, record, block, adjustable, raw: adjustable ? pending ?? knobRaw(record, block) : 0 }
}

function renderOled() {
  const knob = selectedKnob()
  const cable = selection?.kind === 'cable' ? patch.connections?.[selection.index] : null
  let cableInfo = null
  if (cable) {
    const from = endpoint(patch, cable.source)
    const to = endpoint(patch, cable.destination)
    const audio = from.block?.signal === 'audio_out' && to.block?.signal === 'audio_in'
    cableInfo = {
      from: `${from.name} ${from.block ? label(from.block.name) : ''}`,
      to: `${to.name} ${to.block ? label(to.block.name) : ''}`,
      strength: audio ? `${display(cableDb(cable, from, to))} dB` : `${display(cable.strength / 100)} %`,
    }
  }
  let selected = null
  if (knob) {
    const units = knob.block.units && knob.block.units !== 'normalized' ? ` ${knob.block.units}` : ''
    selected = {
      module: moduleName(knob.record), label: label(knob.block.name),
      value: knob.adjustable ? `${display(knob.block.display(knob.raw))}${units}` : label(knob.block.signal),
      position: knob.adjustable ? knob.raw / 65535 : null,
    }
  }
  const pages = pageIndices()
  const armedText = armed ? endpoint(patch, armed).name : null
  paintOled($('oled'), oledModel({
    patch, slot: Number($('slot').value), page: Math.max(0, pages.indexOf(page)), pageCount: pages.length,
    pageLabel: pageName(patch, page), selected, cable: cableInfo, armed: armedText, cpu: cpuText,
  }))
  const knobNode = $('knob')
  const adjustable = Boolean(knob?.adjustable)
  knobNode.classList.toggle('idle', !adjustable)
  knobNode.style.setProperty('--angle', `${-135 + 270 * (adjustable ? knob.raw / 65535 : 0)}deg`)
  knobNode.setAttribute('aria-valuenow', adjustable ? knob.raw : 0)
  knobNode.setAttribute('aria-label', adjustable ? `Knob: ${label(knob.block.name)}` : 'Knob (select a knob button)')
  knobNode.setAttribute('aria-disabled', !adjustable)
}

function knobTurn(delta, fine) {
  const knob = selectedKnob()
  if (!knob?.adjustable) return
  const raw = Math.max(0, Math.min(65535, Math.round(knob.raw + delta * (fine ? .1 : 1))))
  if (raw === knob.raw) return
  knobPending = { module: knob.index, block: knob.block.name, raw }
  simulator.send('setParam', { module: knob.index, block: knob.block.name, raw })
  renderOled()
  clearTimeout(knobTimer)
  knobTimer = setTimeout(commitKnob, 350)
}

function commitKnob() {
  clearTimeout(knobTimer)
  const pending = knobPending
  knobPending = null
  if (!pending) return
  const raw = edit(() => model.setParam(pending.module, pending.block, pending.raw), { regraph: false, full: false })
  if (raw !== undefined) simulator.send('setParam', { module: pending.module, block: pending.block, raw })
  showInspector()
  renderGrid()
}

function gotoPage(step) {
  const indices = pageIndices()
  const next = indices[Math.max(0, Math.min(indices.length - 1, indices.indexOf(page) + step))]
  if (next === page) return
  commitKnob()
  page = next
  renderPages()
  renderGrid()
  renderOled()
}

function goBack() {
  commitKnob()
  if (armed || placement) armed = placement = null
  else selection = null
  renderGrid()
  showInspector()
}

function starSelected() {
  const knob = selectedKnob()
  if (!knob?.adjustable) return
  commitKnob()
  const starred = patch.starred?.some(star => star.module === knob.index && star.block === knob.block.index)
  edit(() => starred ? model.unstarParam(knob.index, knob.block.name) : model.starParam(knob.index, knob.block.name),
    { regraph: false })
}

function initPedal() {
  const keys = [
    ['◀', 'Page left', () => gotoPage(-1), 'page-left'],
    ['▶', 'Page right', () => gotoPage(1), 'page-right'],
    ['STAR', 'Star the selected knob', starSelected, 'star'],
    ['DELETE', 'Delete the selected module or cable', removeSelection, 'delete'],
    ['UNDO', 'Undo (Ctrl+Z)', () => history('undo'), 'undo'],
    ['BACK', 'Back out of the selection (Esc)', goBack, 'back'],
  ]
  $('keys').replaceChildren(...keys.map(([text, title, action, id]) => {
    const key = button(text, action, 'key')
    key.title = title
    key.id = `key-${id}`
    key.setAttribute('aria-label', title)
    return key
  }))
  const knobNode = $('knob')
  knobNode.addEventListener('wheel', event => {
    event.preventDefault()
    knobTurn(-event.deltaY * 6.55, event.shiftKey)
  }, { passive: false })
  let pointer = null
  knobNode.onpointerdown = event => {
    if (event.button !== 0) return
    knobNode.setPointerCapture(event.pointerId)
    pointer = { id: event.pointerId, y: event.clientY }
    knobNode.focus()
    event.preventDefault()
  }
  knobNode.onpointermove = event => {
    if (pointer?.id !== event.pointerId) return
    knobTurn((pointer.y - event.clientY) * 328, event.shiftKey)
    pointer.y = event.clientY
  }
  knobNode.onpointerup = knobNode.onpointercancel = event => {
    if (pointer?.id !== event.pointerId) return
    pointer = null
    commitKnob()
  }
  knobNode.onkeydown = event => {
    const steps = { ArrowUp: 655, ArrowRight: 655, ArrowDown: -655, ArrowLeft: -655, PageUp: 6553, PageDown: -6553 }
    if (!(event.key in steps)) return
    event.preventDefault()
    knobTurn(steps[event.key], event.shiftKey)
  }
}

function render() {
  $('patch-name').value = patch.name ?? ''
  renderPages()
  renderGrid()
  showInspector()
  renderPerformance()
  renderValidation()
}

$('grid-wrap').onpointermove = event => {
  if (placement) showPlacementPreview(gridHit($('grid').getBoundingClientRect(), event.clientX, event.clientY))
}
$('grid-wrap').onpointerleave = () => showPlacementPreview(null)
$('grid-wrap').ondragleave = event => {
  if (!$('grid-wrap').contains(event.relatedTarget)) showPlacementPreview(null)
}
$('grid-wrap').ondragover = event => {
  if (!drag) return
  event.preventDefault()
  event.dataTransfer.dropEffect = drag.type ? 'copy' : 'move'
  if (drag.type) showPlacementPreview(gridHit($('grid').getBoundingClientRect(), event.clientX, event.clientY), drag.type)
}
$('grid-wrap').ondrop = event => {
  if (!drag) return
  event.preventDefault()
  const position = gridHit($('grid').getBoundingClientRect(), event.clientX, event.clientY)
  const moving = drag
  drag = null
  if (position === null) return
  if (moving.type) addAt(moving.type, position)
  else edit(() => {
    model.moveModule(moving.index, { page, position: position - moving.slot })
    selection = { kind: 'module', index: moving.index }
    placement = armed = null
  }, { regraph: false })
}

$('module-search').oninput = renderPalette
$('new').onclick = () => { patchLoad++; open(newPatch('Untitled').patch, 'New patch.', 0) }
$('patch-name').onchange = event => edit(() => model.renamePatch(event.target.value), { regraph: false })
$('add-page').onclick = () => edit(() => { page = model.addPage() }, { regraph: false })
$('rename-page').onclick = () => {
  const name = prompt('Page name (up to 16 ASCII characters)', patch.pages?.[page]?.name ?? '')
  if (name !== null) edit(() => {
    if (!model.pageCount) model.addPage(name)
    else model.renamePage(page, name)
  }, { regraph: false })
}
$('delete-page').onclick = () => {
  if (confirm(`Delete ${pageName(patch, page)} and its modules?`)) edit(() => {
    const changes = model.deletePage(page)
    selection = armed = null
    return changes
  })
}
$('undo').onclick = () => history('undo')
$('redo').onclick = () => history('redo')
$('save-bin').onclick = () => {
  try {
    if (!$('slot').reportValidity()) return
    const slot = String(Number($('slot').value)).padStart(3, '0')
    download(encodePatch(patch), `${slot}_zoia_${filename()}.bin`, 'application/octet-stream')
    status('Binary patch saved.')
  } catch (error) { status(error.message, 'error') }
}
$('save-text').onclick = () => {
  try {
    download(patchToYaml(patch), `${filename()}.txt`, 'text/plain')
    status('Text patch saved.')
  } catch (error) { status(error.message, 'error') }
}
$('print').onclick = () => window.print()
window.addEventListener('beforeprint', () => buildPrint(patch, pageIndices()))
window.addEventListener('afterprint', () => $('print-sheet').replaceChildren())

document.addEventListener('keydown', event => {
  if ($('corpus').open) return
  if (event.key === 'Escape' && (armed || placement)) {
    armed = placement = null
    renderGrid()
    return
  }
  if (event.target.closest?.('input,textarea,select,[contenteditable]')) return
  if (event.key === 'Delete') {
    event.preventDefault()
    removeSelection()
  } else if ((event.ctrlKey || event.metaKey) && ['z', 'y'].includes(event.key.toLowerCase())) {
    event.preventDefault()
    history(event.shiftKey || event.key.toLowerCase() === 'y' ? 'redo' : 'undo')
  }
})

async function readPatch(file, binary) {
  const request = ++patchLoad
  try {
    const data = await (binary ? file.arrayBuffer() : file.text())
    if (request !== patchLoad) return
    if (binary) openBin(data, file.name)
    else open(yamlToPatch(data), `Opened ${file.name}`)
  } catch (error) { if (request === patchLoad) status(error.message, 'error') }
}

function picker(buttonId, inputId, read) {
  $(buttonId).onclick = () => $(inputId).click()
  $(inputId).onchange = event => {
    const file = event.target.files[0]
    event.target.value = ''
    if (file) read(file)
  }
}
picker('open-bin', 'bin-file', file => readPatch(file, true))
picker('open-text', 'text-file', file => readPatch(file, false))
picker('open-audio', 'sound-file', loadAudioFile)
initCorpus((bytes, file) => { patchLoad++; openBin(bytes, file) })
window.addEventListener('dragover', event => {
  if (event.dataTransfer.types.includes('Files')) event.preventDefault()
})
window.addEventListener('drop', event => {
  const file = event.dataTransfer.files[0]
  if (!file) return
  event.preventDefault()
  if (/\.bin$/i.test(file.name)) readPatch(file, true)
  else if (/\.(txt|ya?ml)$/i.test(file.name)) readPatch(file, false)
  else loadAudioFile(file)
})

let activeSource = $('source').value
let activeFile = null
async function sourceChanged() {
  const version = ++audioFileLoad
  const source = $('source').value
  const file = audioFile
  try {
    await simulator.useSource(source, file)
    if (version !== audioFileLoad) return
    activeSource = source
    activeFile = file
  } catch (error) {
    if (version !== audioFileLoad) return
    $('source').value = activeSource
    audioFile = activeFile
    $('audio-file').textContent = audioFile?.name ?? ''
    status(error.message, 'error')
  }
}

function loadAudioFile(file) {
  audioFile = file
  $('source').value = 'file'
  $('audio-file').textContent = file.name
  sourceChanged()
  if (!playing) status(`Selected audio file ${file.name}`)
}

function setTransport(stopped) {
  $('play').disabled = !stopped
  $('leds').classList.toggle('engaged', !stopped)
  $('stop').disabled = stopped
  $('record').disabled = stopped || !playing
  $('record').textContent = 'Record 10 s to WAV'
}
function stop() {
  transport++
  audioFileLoad++
  simulator.stop()
  playing = false
  engineIssues = []
  buttonStates.clear()
  setTransport(true)
  simulator.meters({ peak: [0, 0] })
  renderPerformance()
  renderValidation()
}

$('play').onclick = async () => {
  const request = ++transport
  const source = $('source').value
  const file = audioFile
  setTransport(false)
  status(source === 'live' ? 'Waiting for live input…' : 'Starting simulator…')
  try {
    await simulator.start(() => patch, source, file, Number($('volume').value))
    if (request !== transport) return
    playing = true
    if ($('source').value === source && audioFile === file) {
      activeSource = source
      activeFile = file
    } else {
      await sourceChanged()
      if (request !== transport) return
    }
    simulator.setVolume(Number($('volume').value))
    buttonStates.forEach((state, module) => simulator.send('setState', { module, state }))
    setTransport(false)
    if ($('status').className !== 'error') status('Simulator running.')
  } catch (error) {
    if (request !== transport) return
    stop()
    status(error.message, 'error')
  }
}
$('stop').onclick = () => { stop(); status('Simulator stopped.') }
$('source').onchange = sourceChanged
$('volume').oninput = event => simulator.setVolume(Number(event.target.value))
$('record').onclick = () => {
  $('record').disabled = true
  $('record').textContent = 'Recording 10 s…'
  simulator.record()
}
window.addEventListener('pagehide', stop)

const systemTheme = matchMedia('(prefers-color-scheme: dark)')
function applyTheme() {
  const mode = $('theme').value
  document.documentElement.dataset.theme = mode === 'system' ? (systemTheme.matches ? 'dark' : 'light') : mode
}
$('theme').value = readStorage('zoia-editor.theme') ?? 'system'
$('theme').onchange = () => {
  writeStorage('zoia-editor.theme', $('theme').value)
  applyTheme()
}
systemTheme.addEventListener('change', applyTheme)
applyTheme()
initPedal()
renderPalette()
sync()
