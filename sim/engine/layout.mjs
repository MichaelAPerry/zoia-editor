import { moduleIndex } from './module-index.mjs'

export const clamp = (x, min = 0, max = 1) => Math.max(min, Math.min(max, x))
export const dbGain = db => 10 ** (db / 20)

export function layout(record) {
  const id = record.type_id
  const [name, choices, blocks, parameters] = moduleIndex[id] ?? [record.type ?? `Type ${id}`, {}, [], {}]
  const options = Object.fromEntries(Object.entries(choices).map(([key, values], i) =>
    [key, values[record.options?.[i]] ?? values[0]]))
  const o = options
  const stereoIn = ['stereo', '2in->2out'].includes(o.channels)
  const stereoOut = stereoIn || o.channels === '1in->2out'
  const enabled = (...keys) => keys.filter(key => o[key] === 'on')
  const series = (prefix, count) => Array.from({ length: count }, (_, i) => prefix + (i + 1))
  const stereo = (middle, input = stereoIn, output = stereoOut) => [
    'audio_in_L', ...(input ? ['audio_in_R'] : []), ...middle,
    'audio_out_L', ...(output ? ['audio_out_R'] : []),
  ]
  const control = (rate = 'rate', direct = 'direct') =>
    o.control === 'rate' ? rate : o.control === 'tap_tempo' ? 'tap_tempo_in' : direct
  let visible
  switch (id) {
    case 0: visible = ['audio_in', 'frequency', 'resonance', ...enabled('lowpass_output', 'hipass_output', 'bandpass_output')]; break
    case 1:
    case 2: {
      const prefix = id === 1 ? 'output_' : 'input_'
      visible = [...(o.channels !== 'right' ? [prefix + 'L'] : []),
        ...(o.channels !== 'left' ? [prefix + 'R'] : []), ...(o.gain_control === 'on' ? ['gain'] : [])]
      break
    }
    case 4: visible = [...series('step_', o.number_of_steps), 'gate_in',
      ...(o.restart_jack === 'on' ? ['queue_start'] : []),
      ...(o.key_input !== 'off' ? ['key_input_note', 'key_input_gate'] : []),
      ...series('out_track_', o.num_of_tracks)]; break
    case 5: visible = [o.input === 'tap' ? 'tap_control' : 'cv_control',
      ...enabled('swing_control').map(() => 'swing_amount'), ...enabled('phase_input', 'phase_reset'), 'output']; break
    case 6: visible = ['gate_input', ...(o.retrigger_input === 'on' ? ['retrigger'] : []),
      ...(o.initial_delay === 'on' ? ['delay'] : []), 'attack', ...enabled('hold_attack_decay'), 'decay',
      ...(o.str === 'on' ? ['sustain'] : []), ...enabled('hold_sustain_release'),
      ...(o.str === 'on' ? ['release'] : []), 'cv_output']; break
    case 7: visible = ['audio_in_1', 'level_control', 'audio_out_1', ...(stereoIn ? ['audio_in_2', 'audio_out_2'] : [])]; break
    case 12: visible = ['audio_in', ...(o.rise_fall_time === 'on' ? ['rise_time', 'fall_time'] : []), 'cv_output']; break
    case 13: visible = ['audio_in', ...(o.tap_tempo_in === 'yes' ? ['modulation_in', 'tap_tempo_in'] : ['delay_time']), 'audio_out']; break
    case 14: visible = ['frequency', ...(o.fm_in === 'on' ? ['fm_input'] : []), ...enabled('duty_cycle'), 'audio_out']; break
    case 16: visible = [...series('note_', o['#_of_notes']), 'note_out', 'gate_out', 'trigger_out']; break
    case 19: visible = ['cv_input', ...(o.control === 'linked' ? ['slew_rate'] : ['rising_lag', 'falling_lag']), 'cv_output']; break
    case 20: visible = [...series('note_out_', o['#_of_outputs']), ...series('gate_out_', o['#_of_outputs']),
      ...(o.velocity_output === 'on' ? series('velocity_out_', o['#_of_outputs']) : []),
      ...(o.trigger_pulse === 'on' ? series('trigger_out_', o['#_of_outputs']) : [])]; break
    case 22: visible = [...series('cv_input_', o.num_inputs), 'cv_output']; break
    case 23:
    case 40: visible = stereo(['threshold', ...(o.attack_ctrl === 'on' ? ['attack'] : []),
      ...(o.release_ctrl === 'on' ? ['release'] : []), ...(o.ratio_ctrl === 'on' ? ['ratio'] : []),
      ...(o.sidechain === 'external' ? ['sidechain_in'] : [])]); break
    case 24: visible = ['audio_in', 'frequency', 'q', 'audio_out',
      ...(['bell', 'hi_shelf', 'low_shelf'].includes(o.filter_shape) ? ['gain'] : [])]; break
    case 28: visible = ['cv_input', 'cv_output', ...(o.key_scale_jacks === 'yes' ? ['key', 'scale'] : [])]; break
    case 29: visible = stereo([control('rate', 'control_in'), 'resonance', 'width', 'mix']); break
    case 30: visible = ['audio_in', 'record', 'restart_playback', 'speed_pitch', 'audio_out',
      ...(o.length_edit === 'on' ? ['start_position', 'loop_length'] : []),
      ...(o.play_reverse === 'yes' ? ['reverse_playback'] : []),
      ...(o.overdub === 'yes' ? ['reset'] : []), ...(o.stop_play_button === 'yes' ? ['stop_play'] : [])]; break
    case 31: visible = [...series('cv_input_', o.num_inputs), 'in_select', 'cv_output']; break
    case 32: visible = ['cv_input', 'out_select', ...series('cv_output_', o.num_outputs)]; break
    case 33: visible = [...series('audio_input_', o.num_inputs), 'in_select', 'audio_output']; break
    case 34: visible = ['audio_input', 'in_select', ...series('audio_output_', o.num_outputs)]; break
    case 36: visible = ['audio_in', 'audio_out', ...enabled('sensitivity')]; break
    case 37: visible = ['rec_start_stop', 'rhythm_in', 'play', ...(o.done_ctrl === 'on' ? ['done_out'] : []), 'rhythm_out']; break
    case 39: visible = ['cv_output', ...(o.new_val_on_trig === 'on' ? ['trigger_in'] : [])]; break
    case 41: visible = stereo([control(), 'depth']); break
    case 42: visible = stereo(['low_shelf', 'mid_gain_1', 'mid_freq_1',
      ...(o.num_mid_bands === 2 ? ['mid_gain_2', 'mid_freq_2'] : []), 'high_shelf']); break
    case 43:
    case 75: visible = stereo([control('delay_time', 'delay_time'), 'feedback', 'mod_rate', 'mod_depth', 'mix'],
      stereoIn, stereoOut || id === 75); break
    case 47: visible = ['cv_input', 'record', 'play', 'playback_speed', 'restart_loop', 'cv_output',
      ...(o.length_edit === 'on' ? ['start_position', 'stop_position'] : [])]; break
    case 48: visible = ['cv_input', 'cv_output', ...(o.control === 'linked' ? ['time_constant'] : ['rise_constant', 'fall_constant'])]; break
    case 49: visible = ['cv_input', 'reset_in', 'cv_output',
      ...(record.parameters?.length >= 4 || record.version >= 1 ? ['dividend', 'divisor'] : ['modifier'])]; break
    case 53: visible = ['audio_in_1', ...(o.method === 'haas' ? ['delay_time'] : ['audio_in_2', 'side_gain']),
      'audio_out_1', 'audio_out_2']; break
    case 56: visible = ['in', ...(o.cv_output === 'enabled' ? ['cv_output'] : [])]; break
    case 57: visible = stereo(['pan'], stereoIn, true); break
    case 60: visible = ['note_in', 'gate_in', ...(o.velocity_output === 'on' ? ['velocity_out'] : [])]; break
    case 64: visible = ['audio_in_1_L', 'audio_in_2_L', 'mix', 'audio_output_L',
      ...(o.stereo === 'stereo' ? ['audio_in_1_R', 'audio_in_2_R', 'audio_output_R'] : [])]; break
    case 67: visible = stereo(['decay_feedback', 'rate', 'resonance', 'mix']); break
    case 68: visible = stereo([]); break
    case 69: visible = stereo([control(), 'regen', 'width', 'tone_tilt_eq', 'mix']); break
    case 70: visible = stereo([control(), 'width', 'tone_tilt_eq', 'mix']); break
    case 71: visible = stereo([control(), 'width']); break
    case 72: visible = stereo(['sensitivity', 'min_freq', 'max_freq', 'filter_q']); break
    case 73: visible = ['audio_in', o.ext_audio_in === 'on' ? 'ext_in' : 'frequency',
      ...enabled('duty_cycle'), 'mix', 'audio_out']; break
    case 76: {
      const input = series('audio_in_', o.channels)
      visible = [...input.map(k => k + '_L'), ...series('gain_', o.channels), 'audio_out_L',
        ...(o.stereo === 'stereo' ? input.map(k => k + '_R') : []),
        ...(o.stereo === 'stereo' || o.panning === 'on' ? ['audio_out_R'] : []),
        ...(o.panning === 'on' ? series('pan_', o.channels) : [])]
      break
    }
    case 79: visible = stereo(['decay_time', 'mix']); break
    case 81: visible = [o.control === 'cv' ? 'cv_in' : 'audio_in']; break
    case 82: visible = ['quarter_out', ...(o.clock_out === 'enabled' ? ['clock_out'] : []),
      ...(o.run_out === 'enabled' ? ['reset_out'] : []), ...(o.divider === 'enabled' ? ['run_out'] : [])]; break
    case 83: visible = stereo(['grain_size', 'grain_position', 'density', 'texture', 'speed_pitch', 'freeze']); break
    case 84: visible = ['tap_cv_control', ...(o.run_in === 'enabled' ? ['sent'] : []),
      ...(o.reset_in === 'enabled' ? ['reset'] : []),
      ...(o.position === 'enabled' ? ['send_position', 'song_position'] : [])]; break
    case 85: visible = ['tap_input', 'output', ...(o.range === 'on' ? ['min_time', 'max_time'] : [])]; break
    case 102: visible = [...(o.record !== 'disabled' ? ['audio_in_L', 'audio_in_R', 'record'] : []),
      'sample_playback', 'speed_pitch', ...enabled('reverse_button').map(() => 'direction'), 'start', 'length',
      ...(o.cv_outputs === 'on' ? ['position_cv_out', 'loop_end_cv_out'] : []), 'audio_out_L', 'audio_out_R']; break
    case 103: visible = [o.control === 'stomp aux' ? 'aux' : o.control === 'perform' ? 'performance' : 'bypass']; break
    case 104: visible = [...series('cv_in_', o.num_channels), ...series('atten_', o.num_channels), 'cv_output']; break
    case 105: visible = [...series('in_', o.operation === 'NOT' ? 1 : o.num_of_inputs), ...enabled('threshold'), 'cv_out']; break
    case 106: visible = stereo([...(o.control === 'rate' ? ['delay_time'] : ['tap_tempo_in', 'tap_ratio']),
      'feedback', 'pitch', 'mix']); break
    case 107: visible = stereo([control(), 'depth', 'resonance', 'mix']); break
  }
  let catalog = blocks
  // Corpus Tremolo wiring places depth before the audio outputs, one block
  // earlier than the module index. Reserve block 7 for the unobserved direct jack.
  if (id === 41) catalog = catalog.map(([key, position, type, knob]) => [
    key, key === 'direct' ? 7 : position >= 5 ? position - 1 : position, type, knob,
  ])
  if (id === 36) catalog = catalog.map(([key, position, type, knob]) => [
    key, position, key === 'audio_out' ? 'cv_out' : type, knob,
  ])
  if (id === 103) catalog = catalog.map(([key, , type, knob]) => [key, 0, type, knob])
  // Corpus sequencers place track outputs before the two optional key jacks.
  if (id === 4) catalog = catalog.map(([key, position, type, knob]) => [
    key, key.startsWith('out_track_') ? position - 2 : key.startsWith('key_input_') ? position + 8 : position, type, knob,
  ])
  const active = catalog.filter(([key]) => !visible || visible.includes(key))
  const knobNames = active.filter(([, , , knob]) => knob).map(([key]) => key)
  knobNames.sort((a, b) => (parameters[a]?.[3] ?? 0) - (parameters[b]?.[3] ?? 0))
  // The Plate stores mix before decay, even though the catalog lists it last.
  if (id === 25) knobNames.splice(0, knobNames.length, 'mix', 'decay_time', 'low_eq', 'high_eq')
  // Delay w/Mod and Ping Pong share the same stored parameter order.
  if (id === 43 || id === 75)
    knobNames.splice(0, knobNames.length, 'mix', 'feedback', control('delay_time', 'delay_time'), 'mod_rate', 'mod_depth')
  return { name, options, active, catalog, parameters, knobNames }
}

const scalingCache = new WeakMap()

export function scaled(value, definition) {
  const [defaultValue, unit, range] = definition ?? []
  const x = clamp(value)
  if (!range?.every(v => v === null || typeof v === 'number')) return x
  if (x === 0 && range[0] === null) return -Infinity
  if (range.length === 2) return range[0] + (range[1] - range[0]) * x
  if (range.length !== 5) return x
  if (range[0] === null && range[4] === 0) {
    // The VCA/feedback anchors correspond to linear amplitude.
    return range[1] === -12 ? 20 * Math.log10(x) : 20 * Math.log(x)
  }
  let anchors = scalingCache.get(definition)
  if (!anchors) {
    anchors = range.map((v, i) => [i / 4, v ?? (unit === 's' ? 487.68 : 120)])
    if (unit === 'dB' && defaultValue === 0.83 && !range.includes(0)) anchors.splice(4, 0, [0.83, 0])
    scalingCache.set(definition, anchors)
  }
  for (let i = 1; i < anchors.length; i++) {
    const [end, high] = anchors[i]
    if (x <= end) {
      const [start, low] = anchors[i - 1]
      const t = (x - start) / (end - start)
      return low > 0 && high / low > 2 && (unit === 'Hz' || unit === 'ms' || unit === 's')
        ? low * (high / low) ** t : low + (high - low) * t
    }
  }
  return anchors.at(-1)[1]
}
