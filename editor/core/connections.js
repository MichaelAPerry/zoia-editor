import { layout } from '../../sim/engine/layout.mjs'

function blockSignal(record, moduleLayout, index, allowLegacy) {
  const active = moduleLayout?.active.find(block => block[1] === index)
  if (active || !allowLegacy || !record) return active?.[2]

  // These same-signal endpoints occur in saved corpus patches. Keep their
  // wire IDs without presenting them as active jacks for new cables.
  const { type_id, save_word } = record
  const { options, catalog } = moduleLayout
  const legacy =
    (type_id === 37 && save_word === 168 && options.done_ctrl === 'off' && index === 3) ||
    (type_id === 43 && options.control === 'tap_tempo' && index === 2) ||
    (type_id === 75 && options.control === 'rate' && index === 3)
  return legacy ? catalog.find(block => block[1] === index)?.[2] : undefined
}

export function cableIssue(source, destination) {
  if (!source || !destination) {
    return ['missing-block', 'Both endpoints must be active module jacks.']
  }
  if (!['audio_out', 'cv_out'].includes(source) || !['audio_in', 'cv_in'].includes(destination)) {
    return ['direction', 'Connect an output to an input.']
  }
  if (source.split('_')[0] !== destination.split('_')[0]) {
    return ['signal-mismatch', 'Audio outputs connect to audio inputs and CV outputs connect to CV inputs.']
  }
  return null
}

export function connectionIssues(patch, { allowLegacy = true } = {}) {
  const modules = patch.modules ?? []
  const layouts = modules.map(layout)
  const signal = ([module, block]) => blockSignal(modules[module], layouts[module], block, allowLegacy)
  const issues = []
  for (const [index, { source, destination }] of (patch.connections ?? []).entries()) {
    const issue = cableIssue(signal(source), signal(destination))
    if (issue) {
      issues.push({
        severity: 'error', code: issue[0], connection: index,
        message: `Cable ${index + 1} (${source.join('.')} → ${destination.join('.')}): ${issue[1]}`,
      })
    }
  }
  return issues
}

export function assertConnections(patch) {
  const issues = connectionIssues(patch)
  if (issues.length) throw new RangeError(issues.map(issue => issue.message).join('\n'))
}
