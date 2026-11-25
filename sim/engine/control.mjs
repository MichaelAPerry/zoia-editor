import { clamp } from './layout.mjs'
import { blend, delayLine, edge, sampleRate, tap, wave } from './dsp.mjs'

export function delayMaximum(option) {
  return option?.endsWith('ms') ? parseFloat(option) / 1000 : parseFloat(option || '1s')
}

// Pedal measurements in CALIBRATION.md
const lfoSlowPosition = 1050 / 65535
const lfoSlowRate = 0.06131662
const lfoBenchPosition = 2142 / 65535
const lfoBenchRate = 0.12906869
const lfoBenchExponent = 1.04396
const lfoBenchSpan = (lfoBenchPosition / lfoSlowPosition) ** lfoBenchExponent - 1

// Saved LFO rates (CALIBRATION.md), with duplicate positions consolidated and
// isolated reversals omitted. Positions are in the pedal's 16-bit knob units.
const lfoSavedRates = [
  [2142, lfoBenchRate],
  [2148, 0.12943],
  [2212, 0.13354],
  [2240, 0.13534],
  [2268, 0.13714],
  [2322, 0.14062],
  [2348, 0.14231],
  [2360, 0.14308],
  [2428, 0.1475],
  [2440, 0.14828],
  [2588, 0.15795],
  [2668, 0.16321],
  [2677, 0.1638],
  [2680, 0.164],
  [2708, 0.16585],
  [2748, 0.16849],
  [2813, 0.1728],
  [2868, 0.17646],
  [2880, 0.17727],
  [2908, 0.17913],
  [2948, 0.18181],
  [2988, 0.18449],
  [3028, 0.18718],
  [3352, 0.20918],
  [3508, 0.22307],
  [3608, 0.22685],
  [3760, 0.23746],
  [3788, 0.23942],
  [3808, 0.24083],
  [4028, 0.25639],
  [4108, 0.2621],
  [4148, 0.26497],
  [4172, 0.26669],
  [4188, 0.26784],
  [4348, 0.27938],
  [4680, 0.30368],
  [4708, 0.30575],
  [5068, 0.33266],
  [5258, 0.34708],
  [5520, 0.36723],
  [5788, 0.38815],
  [6268, 0.42643],
  [6280, 0.42655],
  [6308, 0.42967],
  [6468, 0.44269],
  [6588, 0.45253],
  [6760, 0.46676],
  [6788, 0.46908],
  [6948, 0.48246],
  [6988, 0.48583],
  [7398, 0.52075],
  [7668, 0.5442],
  [8110, 0.58336],
  [8360, 0.60595],
  [8800, 0.64649],
  [9148, 0.67928],
  [9240, 0.68806],
  [9388, 0.70228],
  [9560, 0.71895],
  [9828, 0.74525],
  [10108, 0.77316],
  [10228, 0.78526],
  [10308, 0.79337],
  [10388, 0.80152],
  [11028, 0.86805],
  [11548, 0.92392],
  [11708, 0.94144],
  [11774, 0.94871],
  [12085, 0.98336],
  [12210, 0.99746],
  [12215, 0.99802],
  [12588, 1.0407],
  [12668, 1.04997],
  [13093, 1.09994],
  [13108, 1.1012],
  [13280, 1.12549],
  [13388, 1.13534],
  [13440, 1.14164],
  [13588, 1.15968],
  [13920, 1.20069],
  [14040, 1.21571],
  [14108, 1.22426],
  [14428, 1.26496],
  [16170, 1.49994],
  [16268, 1.51386],
  [16308, 1.51957],
  [16383.75, 1.53],
  [16428, 1.53676],
  [16560, 1.5558],
  [16708, 1.57733],
  [17000, 1.62032],
  [17468, 1.69074],
  [17788, 1.73998],
  [17800, 1.74184],
  [18188, 1.80279],
  [18588, 1.86704],
  [18628, 1.87355],
  [18948, 1.92613],
  [19341, 1.99202],
  [19400, 2.00204],
  [19423, 2.00596],
  [19588, 2.0342],
  [19908, 2.08972],
  [19920, 2.09182],
  [19948, 2.09673],
  [20734, 2.23777],
  [21226, 2.3293],
  [22028, 2.48409],
  [22188, 2.51583],
  [22668, 2.61219],
  [22892, 2.65891],
  [22988, 2.67887],
  [23867, 2.86675],
  [24788, 3.07391],
  [24828, 3.08315],
  [25198, 3.16966],
  [25348, 3.20525],
  [26228, 3.42026],
  [26268, 3.43029],
  [26308, 3.44035],
  [27828, 3.83975],
  [27948, 3.87277],
  [28348, 3.98448],
  [28388, 3.99579],
  [28468, 4.01849],
  [28840, 4.12539],
  [29068, 4.19204],
  [29628, 4.35944],
  [30408, 4.60163],
  [30708, 4.69767],
  [31080, 4.81904],
  [31628, 5.00257],
  [31634, 5.00462],
  [32308, 5.23838],
  [32455, 5.29056],
  [32767.5, 5.4],
].map(([position, hz]) => [position, Math.log(hz)])

function interpolateLfoRate(position) {
  const raw = position * 65535
  let start = 0, end = lfoSavedRates.length - 1
  while (end - start > 1) {
    const middle = (start + end) >> 1
    if (raw < lfoSavedRates[middle][0]) end = middle
    else start = middle
  }
  const [lowPosition, lowLogHz] = lfoSavedRates[start]
  const [highPosition, highLogHz] = lfoSavedRates[end]
  return Math.exp(blend(lowLogHz, highLogHz, (raw - lowPosition) / (highPosition - lowPosition)))
}

export const controls = {
  4(m) {
    const { p, put, options: o } = m
    const advance = edge(), restart = edge()
    const steps = o.number_of_steps
    let step = -1
    const trackKeys = Array.from({ length: o.num_of_tracks }, (_, i) => `out_track_${i + 1}`)
    const stepKeys = Array.from({ length: steps }, (_, i) => `step_${i + 1}`)
    const tracks = trackKeys.map((_, track) => stepKeys.map((__, index) => m.u16(2 * (32 * track + index)) / 65535))
    return () => {
      const tick = advance(p('gate_in'))
      if (restart(p('queue_start'))) step = -1
      if (o.behavior === 'cv_step') step = Math.min(steps - 1, Math.floor(clamp(p('gate_in')) * steps))
      else if (tick) step = o.behavior === 'one_shot' ? Math.min(step + 1, steps - 1) : (step + 1) % steps
      for (let i = 0; i < trackKeys.length; i++) {
        const value = i === 0 && step >= 0 && (m.connected(stepKeys[step]) || !m.hasSaved)
          ? p(stepKeys[step]) : tracks[i][step] ?? 0
        put(trackKeys[i], value)
      }
    }
  },
  5(m) {
    const { p, unit, put, options: o, random } = m
    const reset = edge(), period = tap(m.f32(4, 0.5) * sampleRate)
    let phase = 0, held = 2 * random() - 1, odd = false
    let lastPosition, interpolatedRate
    return () => {
      if (reset(p('phase_reset'))) phase = 0
      const position = clamp(p('cv_control'))
      let hz
      if (o.input === 'tap') hz = sampleRate / period(p('tap_control'))
      else if (o.input === 'linear_cv') hz = 40 * position
      // ASSUMPTION: Below the measured range, continue linearly to zero.
      else if (position < lfoSlowPosition) hz = lfoSlowRate * position / lfoSlowPosition
      else if (position <= lfoBenchPosition) {
        const progress = ((position / lfoSlowPosition) ** lfoBenchExponent - 1) / lfoBenchSpan
        hz = blend(lfoSlowRate, lfoBenchRate, progress)
      } else if (position < 0.5) {
        if (position !== lastPosition) {
          lastPosition = position
          interpolatedRate = interpolateLfoRate(position)
        }
        hz = interpolatedRate
      } else hz = unit('cv_control')
      const y = o.waveform === 'random' ? held : wave(o.waveform, phase + 2 * (p('phase_input', 0.5) - 0.5),
        0.5 + 0.45 * (2 * p('swing_amount', 0.5) - 1))
      put('output', o.output === '-1 to 1' ? y : 0.5 + 0.5 * y)
      const swing = o.swing_control === 'on' ? 0.8 * (p('swing_amount') - 0.5) : 0
      phase += hz / (sampleRate * (1 + (odd ? swing : -swing)))
      if (phase >= 1) {
        phase -= Math.floor(phase)
        odd = !odd
        if (o.waveform === 'random') held = 2 * random() - 1
      }
    }
  },
  6({ p, unit, put, options: o }) {
    const trigger = edge(), retrigger = edge()
    let stage = 'idle', samples = 0, level = 0, start = 0
    const next = (name, from = level) => {
      stage = name
      samples = 0
      start = from
    }
    const duration = name => sampleRate * 0.001 * (o.time_scale === 'linear' ? 60000 * clamp(p(name)) : unit(name))
    return () => {
      const gate = p('gate_input')
      const fire = trigger(gate), repeat = retrigger(p('retrigger'))
      if (fire || repeat) next(o.initial_delay === 'on' ? 'delay' : 'attack')
      if (o.str === 'on' && gate <= 0.5 && (o.immediate_release === 'on' || stage === 'sustain')
        && !['idle', 'hold_sustain_release', 'release'].includes(stage)) {
        next(o.hold_sustain_release === 'on' ? 'hold_sustain_release' : 'release')
      }
      const sustain = o.str === 'on' ? clamp(p('sustain')) : 0
      samples++
      switch (stage) {
        case 'delay': if (samples >= duration('delay')) next('attack'); break
        case 'attack':
          level = blend(start, 1, clamp(samples / Math.max(1, duration('attack'))))
          if (level >= 1) next(o.hold_attack_decay === 'on' ? 'hold_attack_decay' : 'decay')
          break
        case 'hold_attack_decay': if (samples >= duration('hold_attack_decay')) next('decay'); break
        case 'decay': {
          const progress = clamp(samples / Math.max(1, duration('decay')))
          level = blend(start, sustain, progress)
          if (progress >= 1) next(o.str === 'on' ? 'sustain' : 'idle')
          break
        }
        case 'sustain': level = sustain; break
        case 'hold_sustain_release': if (samples >= duration('hold_sustain_release')) next('release'); break
        case 'release':
          level = start * (1 - clamp(samples / Math.max(1, duration('release'))))
          if (level <= 0) next('idle')
          break
        default: level = 0
      }
      put('cv_output', level)
    }
  },
  10({ p, put, options }) {
    const rising = edge()
    let held = 0
    return () => {
      const trigger = p('trigger')
      if (options['track & hold'] === 'on' ? trigger > 0.5 : rising(trigger)) held = p('cv_input')
      put('cv_output', held)
    }
  },
  14({ p, unit, put, options }) {
    let phase = 0
    return () => {
      put('audio_out', wave(options.waveform, phase, clamp(p('duty_cycle', 0.5), 0.02, 0.98)))
      phase += clamp(unit('frequency') * 2 ** clamp(10 * p('fm_input'), -10, 10), 0, 23500) / sampleRate
      if (phase >= 1) phase -= 1
    }
  },
  15: button,
  17: ({ p, put }) => () => put('cv_output', -p('cv_input')),
  19({ p, unit, put, options }) {
    let level = 0
    return () => {
      const x = p('cv_input')
      const time = unit(options.control === 'linked' ? 'slew_rate' : x > level ? 'rising_lag' : 'falling_lag')
      const step = 1 / Math.max(1, time * sampleRate)
      level += clamp(x - level, -step, step)
      put('cv_output', level)
    }
  },
  22({ p, put, options }) {
    const inputs = Array.from({ length: options.num_inputs }, (_, i) => `cv_input_${i + 1}`)
    return () => {
      let value = 1
      for (const key of inputs) value *= p(key)
      put('cv_output', clamp(value, -1, 1))
    }
  },
  31: routeSwitch,
  32: routeSwitch,
  33: routeSwitch,
  34: routeSwitch,
  38: ({ put, random }) => () => put('audio_out', 2 * random() - 1),
  39({ p, put, options, random }) {
    const rising = edge()
    let held = random()
    return () => {
      if (rising(p('trigger_in'))) held = random()
      put('cv_output', options.output === '-1 to 1' ? 2 * held - 1 : held)
    }
  },
  44: button,
  45: ({ p, put, options }) => () => put('cv_output', options.output === '-1 to 1' ? 2 * p('value') - 1 : p('value')),
  46({ p, unit, put, options }) {
    const delay = delayLine(60 * sampleRate)
    return () => {
      const ms = options.cv_input === 'linear' ? 60000 * clamp(p('delay_time')) : unit('delay_time')
      put('cv_output', delay.read(ms * 48, false))
      delay.write(p('cv_input'))
    }
  },
  49({ p, unit, put, options, has }) {
    const measured = tap(sampleRate / 2), reset = edge(), inputEdge = edge()
    let phase = 0, running = options.input === 'cv_control', pulse = 0
    return () => {
      const input = p('cv_input')
      const tick = inputEdge(input)
      const period = measured(input)
      const ratio = has('divisor') ? Math.round(unit('dividend')) / Math.round(unit('divisor'))
        : 1 / (1 + Math.round(31 * clamp(p('modifier'))))
      if (tick && !running) {
        running = true
        phase = 1
      }
      if (reset(p('reset_in'))) phase = 1
      if (phase >= 1) {
        phase -= Math.floor(phase)
        pulse = 64
      }
      put('cv_output', pulse > 0 ? 1 : 0)
      pulse = Math.max(0, pulse - 1)
      if (running) phase += ratio * (options.input === 'tap' ? 1 / period : unit('cv_input') / sampleRate)
    }
  },
  50: ({ p, put, options }) => () => put('cv_output',
    p('cv_positive_input') > p('cv_negative_input') ? 1 : options.output === '-1 to 1' ? -1 : 0),
  52({ p, put }) {
    const rising = edge()
    let samples = 0
    return () => {
      if (rising(p('cv_input'))) samples = 64
      put('cv_output', samples > 0 ? 1 : 0)
      samples = Math.max(0, samples - 1)
    }
  },
  56: button,
  81: () => () => {},
  104({ p, put, options }) {
    const keys = Array.from({ length: options.num_channels }, (_, i) => [`cv_in_${i + 1}`, `atten_${i + 1}`])
    const divisor = options.levels === 'average' ? keys.length : 1
    return () => {
      let sum = 0
      for (const [input, atten] of keys) sum += p(input) * (2 * clamp(p(atten)) - 1)
      put('cv_output', clamp(sum / divisor, -1, 1))
    }
  },
}

export function button({ id, put, knob, options, u8, hasSaved }) {
  const initial = options.normally === 'one' ? 1 : 0
  const stored = id !== 56 && hasSaved && options.action === 'latching' ? Number(u8(0) !== 0) : initial
  return () => put('cv_output', knob('state', stored) >= 0.5 ? 1 : 0)
}

function routeSwitch({ id, p, put, options }) {
  const input = id === 31 || id === 33
  const prefix = id === 31 || id === 32 ? 'cv_' : 'audio_'
  const count = input ? options.num_inputs : options.num_outputs
  const keys = Array.from({ length: count }, (_, i) => prefix + (input ? 'input_' : 'output_') + (i + 1))
  const select = id === 32 ? 'out_select' : 'in_select'
  // Multi-channel audio switches span channel 1 at 0 CV to the last at 1 CV.
  // A single-channel switch still uses its selector as an on/off gate.
  const audioSelector = prefix === 'audio_' && count > 1
  const index = () => audioSelector
    ? Math.round(clamp(p(select)) * (count - 1))
    : Math.round(clamp(p(select)) * count) - 1
  if (input) return () => put(prefix + 'output', p(keys[index()]))
  return () => {
    const selected = index()
    const value = p(prefix + 'input')
    for (let i = 0; i < count; i++) put(keys[i], i === selected ? value : 0)
  }
}
