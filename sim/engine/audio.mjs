import { clamp, dbGain, scaled } from './layout.mjs'
import { allpass, blend, clean, coefficient, dcBlock, delayAllpass, delayLine, eq, reverbChannel, sampleRate, stateVariable, tap, tau, vcaGain, wave } from './dsp.mjs'
import { delayMaximum } from './control.mjs'

export const audio = {
  0: filter,
  1: ({ put }) => io => {
    put('output_L', io.left)
    put('output_R', io.right)
  },
  2: ({ p, unit, has }) => io => {
    const gain = has('gain') ? dbGain(unit('gain')) : 1
    io.outL += p('input_L') * gain
    io.outR += p('input_R') * gain
  },
  3({ p, unit, put }) {
    let phase = 1, held = 0
    return () => {
      if (phase >= 1) {
        held = p('audio_in')
        phase -= 1
      }
      phase += unit('alias_amount') / sampleRate
      put('audio_out', held)
    }
  },
  7: ({ p, put }) => () => {
    const gain = vcaGain(p('level_control'))
    put('audio_out_1', p('audio_in_1') * gain)
    put('audio_out_2', p('audio_in_2') * gain)
  },
  9: ({ p, unit, put, options }) => () => {
    const bits = unit('crushed_bits')
    const scale = 2 ** (30 - (options.fractions === 'on' ? bits : Math.round(bits)))
    put('audio_out', Math.round(p('audio_in') * scale) / scale)
  },
  11: drive,
  12({ p, unit, put, has, options }) {
    let level = 0
    return () => {
      const x = Math.abs(p('audio_in'))
      const rising = x > level
      const seconds = has('rise_time') ? unit(rising ? 'rise_time' : 'fall_time') * 0.001 : rising ? 0.005 : 0.05
      level = clean(blend(level, x, coefficient(seconds)))
      put('cv_output', clamp(options.output_scale === 'log' ? Math.log1p(99 * level) / Math.log(100) : level))
    }
  },
  13({ p, unit, put, options, u32 }) {
    const max = delayMaximum(options.max_time) * sampleRate
    const line = delayLine(max)
    const period = tap(clamp(u32(0, sampleRate / 2), 1, max))
    const clocked = options.tap_tempo_in === 'yes'
    const benchOption = options.max_time === '1s' && options.interpolation === 'on'
    const key = clocked ? 'modulation_in' : 'delay_time'
    return () => {
      const position = clamp(p(key))
      let samples
      if (clocked) {
        const amount = options['CV Input'] === 'linear' ? position : unit(key) / 16000
        samples = period(p('tap_tempo_in')) + amount * max
      } else if (options['CV Input'] === 'linear') {
        samples = position * max
      } else if (benchOption) {
        // Pedal measurements in CALIBRATION.md
        // Slots 012–014 give 72, 133 and 640 samples at quarter-scale steps.
        const lo = 16384 / 65535, hi = 49152 / 65535
        if (position < lo) {
          // ASSUMPTION: unmeasured; geometric from 1 sample up to the measured 72 so the knob stays continuous.
          samples = Math.max(1, Math.trunc(72 ** (position / lo)))
        } else if (position <= hi) {
          samples = 64 + Math.trunc(4800 ** (position * 65535 / 65536))
        } else {
          // ASSUMPTION: unmeasured; geometric from the measured 640 up to full capacity so the knob stays continuous.
          samples = Math.trunc(640 * ((max - 65) / 640) ** ((position - hi) / (1 - hi)))
        }
      } else {
        samples = clamp(Math.trunc(max ** (position * 65535 / 65536)), 1, max - 65)
      }
      put('audio_out', line.read(samples, options.interpolation === 'on'))
      line.write(clamp(p('audio_in'), -1, 1))
    }
  },
  23: dynamics,
  24: filter,
  25: reverb,
  26({ p, put, options }) {
    const samples = options.buffer_length * 64
    if (!samples) return () => put('audio_out', p('audio_in'))
    const line = delayLine(samples)
    return () => {
      put('audio_out', line.read(samples, false))
      line.write(p('audio_in'))
    }
  },
  27({ p, unit, put, options }) {
    const stages = Array.from({ length: options['#_of_poles'] }, allpass)
    return () => {
      let y = p('audio_in')
      const gain = Math.min(0.98, dbGain(unit('filter_gain')))
      for (const stage of stages) y = stage(y, gain)
      put('audio_out', y)
    }
  },
  29: modulation,
  40: dynamics,
  41: modulation,
  42(m) {
    return stereoEffect(m, () => {
      const low = eq('low_shelf'), high = eq('hi_shelf'), mid = eq('bell'), second = eq('bell')
      return x => {
        const { unit, options } = m
        let y = low(x, 180, unit('low_shelf'))
        y = mid(y, unit('mid_freq_1'), unit('mid_gain_1'), 1)
        if (options.num_mid_bands === 2) y = second(y, unit('mid_freq_2'), unit('mid_gain_2'), 1)
        return high(y, 5000, unit('high_shelf'))
      }
    })
  },
  43: echo,
  53({ p, unit, put, options }) {
    if (options.method === 'haas') {
      const delay = delayLine(1680)
      return () => {
        const x = p('audio_in_1')
        put('audio_out_1', x)
        put('audio_out_2', delay.read(unit('delay_time') * 48))
        delay.write(x)
      }
    }
    return () => {
      const a = p('audio_in_1'), b = p('audio_in_2')
      const mid = (a + b) * 0.5, side = (a - b) * 0.5 * dbGain(unit('side_gain'))
      put('audio_out_1', mid + side)
      put('audio_out_2', mid - side)
    }
  },
  57({ p, put, has, options }) {
    return () => {
      const pan = clamp(p('pan'))
      const a = p('audio_in_L'), b = has('audio_in_R') ? p('audio_in_R') : a
      put('audio_out_L', a * panGain(1 - pan, options.pan_type))
      put('audio_out_R', b * panGain(pan, options.pan_type))
    }
  },
  64: ({ p, put }) => () => {
    const mix = clamp(p('mix'))
    put('audio_output_L', blend(p('audio_in_1_L'), p('audio_in_2_L'), mix))
    put('audio_output_R', blend(p('audio_in_1_R'), p('audio_in_2_R'), mix))
  },
  66: drive,
  67: reverb,
  69: modulation,
  70: modulation,
  71: modulation,
  74: reverb,
  75: echo,
  76({ p, unit, put, options }) {
    const stereo = options.stereo === 'stereo'
    const pan = options.panning === 'on'
    const inputs = Array.from({ length: options.channels }, (_, i) => [`audio_in_${i + 1}_L`,
      `audio_in_${i + 1}_R`, `gain_${i + 1}`, `pan_${i + 1}`])
    return () => {
      let left = 0, right = 0
      for (const [l, r, gain, position] of inputs) {
        const g = dbGain(unit(gain))
        const balance = pan ? clamp(p(position)) : 0.5
        left += p(l) * g * Math.min(1, 2 * (1 - balance))
        if (stereo || pan) right += p(stereo ? r : l) * g * Math.min(1, 2 * balance)
      }
      put('audio_out_L', left)
      put('audio_out_R', right)
    }
  },
  78({ p, unit, put }) {
    const stages = Array.from({ length: 4 }, () => delayAllpass(5500))
    let phase = 0
    return () => {
      let x = p('audio_in')
      const gain = Math.min(0.95, dbGain(unit('gain')))
      const size = unit('size'), width = unit('mod_width')
      for (let i = 0; i < stages.length; i++) {
        const samples = size * (1 - 0.19 * i) + width * Math.sin(tau * phase + i)
        x = stages[i](x, samples, gain)
      }
      phase = (phase + unit('mod_rate') / sampleRate) % 1
      put('audio_out', x)
    }
  },
  79: reverb,
  80: reverb,
}

function panGain(value, law) {
  if (law === 'linear') return value
  if (law === '-4.5dB') return Math.sqrt(value * Math.sin(value * Math.PI / 2))
  return Math.sin(value * Math.PI / 2)
}

export function stereoEffect({ p, put, has }, channel, update = () => {}) {
  const left = channel(0)
  const right = has('audio_out_R') ? channel(1) : undefined
  const stereo = has('audio_in_R')
  return () => {
    const l = p('audio_in_L'), r = stereo ? p('audio_in_R') : l
    update(l, r)
    put('audio_out_L', left(l))
    if (right) put('audio_out_R', right(r))
  }
}

function filter({ id, p, unit, put, options }) {
  const shape = options.filter_shape
  if (['bell', 'hi_shelf', 'low_shelf'].includes(shape)) {
    const process = eq(shape)
    return () => put('audio_out', process(p('audio_in'), unit('frequency'), unit('gain'), unit('q')))
  }
  const process = stateVariable()
  const out = {}
  return () => {
    const q = id === 0 ? 0.707 * Math.sqrt(unit('resonance')) : unit('q')
    process(p('audio_in'), unit('frequency'), q, out)
    if (id === 0) {
      put('lowpass_output', out.low)
      put('hipass_output', out.high)
      put('bandpass_output', out.band)
    } else put('audio_out', out[shape === 'lowpass' ? 'low' : shape === 'highpass' ? 'high' : 'band'])
  }
}

function drive({ id, p, unit, put, options }) {
  const flavor = options.model
  const color = { plexi: 0.45, germ: 0.75, classic: 0.6, pushed: 0.3, edgy: 0.70,
    efuzzy: 0.3, burly: 0.65, scoopy: 0.28, ugly: 0.1 }[flavor]
  const removeDC = dcBlock(15)
  let low = 0
  return () => {
    const x = p('audio_in') * (1 + unit('input_gain'))
    let y
    // Fuzz: no extra 2x drive (factory drones 034 046 048 053 057 all 3-6 dB closer; FACTORY-FIXES Continuation 3 B).
    if (id === 66) y = clamp(x, -0.83, 1)
    else if (flavor === 'edgy') y = clamp(x, -0.22, 0.22)
    else y = Math.tanh(x + (flavor === 'germ' ? 0.15 * x * x / (1 + x * x) : 0))
    low = clean(blend(low, y, color))
    y = flavor === 'scoopy' ? y - 0.65 * low : low
    put('audio_out', removeDC(y) * dbGain(unit('output_gain')))
  }
}

function dynamics(m) {
  const { p, unit, id, has } = m
  let envelope = 0, gain = 1
  return stereoEffect(m, () => x => x * gain, (l, r) => {
    const detector = has('sidechain_in') ? Math.abs(p('sidechain_in')) : Math.max(Math.abs(l), Math.abs(r))
    const seconds = detector > envelope ? unit('attack') * 0.001 : unit('release')
    const alpha = coefficient(seconds)
    envelope = clean(blend(envelope, detector, alpha))
    const threshold = dbGain(unit('threshold'))
    if (id === 40) gain = clean(blend(gain, envelope >= threshold ? 1 : 0, alpha))
    else gain = envelope <= threshold ? 1 : (threshold / envelope) ** (1 - 1 / Math.max(1, unit('ratio')))
  })
}

function echo(m) {
  const { id, p, put, unit, options, has, u32 } = m
  const pingPong = id === 75
  const left = delayLine(2.1 * sampleRate)
  const right = has('audio_out_R') ? delayLine(2.1 * sampleRate) : undefined
  // Pedal measurements in CALIBRATION.md
  // Delay w/Mod adds one 64-sample block to the wet path outside the feedback loop.
  const wetPathL = id === 43 ? delayLine(64) : undefined
  const wetPathR = id === 43 && right ? delayLine(64) : undefined
  const tempo = tap(clamp(u32(0, sampleRate / 2), 1, 2 * sampleRate))
  const [num, den] = (options.tap_ratio || '1:1').split(':').map(Number)
  let phase = 0, toneL = 0, toneR = 0
  const tone = { clean: 1, tape: 0.35, old_tape: 0.18, bbd: 0.11 }[options.type]
  return () => {
    const l = p('audio_in_L'), r = has('audio_in_R') ? p('audio_in_R') : l
    const base = has('tap_tempo_in') ? tempo(p('tap_tempo_in')) * num / den : unit('delay_time') * 48
    phase = (phase + unit('mod_rate') / sampleRate) % 1
    const offset = 390 * clamp(p('mod_depth')) * Math.sin(tau * phase)
    toneL = clean(blend(toneL, left.read(base + offset), tone))
    if (right) toneR = clean(blend(toneR, right.read(base - offset), tone))
    const feedback = Math.min(0.985, dbGain(unit('feedback')))
    const mix = clamp(p('mix'))
    left.write(l + feedback * (pingPong ? toneR : toneL))
    if (right) right.write((pingPong && !has('audio_in_R') ? 0 : r) + feedback * (pingPong ? toneL : toneR))
    put('audio_out_L', blend(l, wetPathL ? wetPathL.read(64) : toneL, mix))
    if (right) put('audio_out_R', blend(r, wetPathR ? wetPathR.read(64) : toneR, mix))
    wetPathL?.write(toneL)
    wetPathR?.write(toneR)
  }
}

function modulation(m) {
  const { id, p, unit, has, options, u32, f32 } = m
  // The Flanger stores its tap period in samples at offset 0. See CALIBRATION.md.
  const flangerPeriod = id === 69 && has('tap_tempo_in') ? u32(0) : 0
  const period = tap(flangerPeriod >= 1200 && flangerPeriod <= 30 * sampleRate
    ? flangerPeriod : f32(4, 0.5) * sampleRate)
  let phase = 0
  return stereoEffect(m, channel => {
    const line = [69, 70, 71].includes(id) ? delayLine(1800) : undefined
    const stages = id === 29 ? Array.from({ length: options.number_of_stages }, allpass) : []
    const tilt = eq('hi_shelf')
    let previous = 0
    return x => {
      const direct = has('control_in') || has('direct')
      const shape = options.waveform === 'triangle' || options.waveform === 'square' ? options.waveform : 'sine'
      const position = direct ? clamp(p(id === 29 ? 'control_in' : 'direct'))
        : 0.5 + 0.5 * wave(shape, phase + channel * 0.25)
      if (id === 41) return x * (1 - clamp(p('depth')) * position)
      const width = clamp(p('width'))
      if (id === 29) {
        let y = x + previous * clamp(p('resonance'), 0, 0.85)
        const t = Math.tan(Math.PI * (200 + 5000 * position * width) / sampleRate)
        const a = (1 - t) / (1 + t)
        for (const stage of stages) y = stage(y, a)
        previous = clean(y)
        return blend(x, y, clamp(p('mix')))
      }
      const time = id === 69 ? 0.4 + 8 * width * position : id === 70 ? 9 + 18 * width * position : 2 + 8 * width * position
      const y = line.read(time * 48)
      const regen = id === 69 ? Math.min(0.94, dbGain(unit('regen'))) : 0
      line.write(x + y * regen)
      return id === 71 ? y : blend(x, tilt(y, 2500, unit('tone_tilt_eq')), clamp(p('mix')))
    }
  }, () => {
    if (options.control === 'cv_direct') return
    phase = (phase + (has('tap_tempo_in') ? 1 / period(p('tap_tempo_in')) : unit('rate') / sampleRate)) % 1
  })
}

const ghostDecay25 = 3.35, ghostDecay75 = 48

// Effective low-octave decay anchors for this comb model. See CALIBRATION.md.
const reverbDecay = {
  25: [0.5, 's', [0, 3.15, 4.12, 10.6, null]],
  // Isolated pedal bursts anchor the 250 Hz tail at 25% and 75%.
  // The other positions estimate a bounded rise in feedback.
  67: [0.5, 's', [0.5, ghostDecay25, 12, ghostDecay75, 52]],
  74: [0.5, 's', [0, 2.8, 4.12, 9.5, null]],
  79: [0.5, 's', [0, 2.5, 4.12, 6.8, null]],
  80: [0.16, 's', [0, 1.75, 4.12, 5.8, null]],
}

// Wet peak corrections at raw 16384 and 49152. See CALIBRATION.md.
const reverbWetDb = {
  25: [15.5, 14],
  67: [6.85, 9.46],
  74: [21, 16],
  79: [16, 16],
  80: [16, 13],
}

function reverb(m) {
  const { id, p, unit, has } = m
  const size = { 25: 1, 67: 1.2, 74: 1.5, 79: 0.9, 80: 0.65 }[id]
  const decayKey = id === 67 ? 'decay_feedback' : 'decay_time'
  const [lowWetDb, highWetDb] = reverbWetDb[id]
  let feed = 0, phase = 0, previousPosition, decay, wetGain
  return stereoEffect(m, channel => {
    // The isolated Ghostverb burst loses bass much faster than the 250 Hz octave.
    const wet = reverbChannel(size * sampleRate / 44100, channel * 27, id === 67 ? 2.5 : 0)
    const low = eq('low_shelf'), high = eq('hi_shelf')
    return x => {
      const position = clamp(p(decayKey))
      if (position !== previousPosition) {
        previousPosition = position
        decay = scaled(position, reverbDecay[id])
        if (id !== 67) decay = clamp(decay, 0.15, 30)
        let wetDb = blend(lowWetDb, highWetDb, clamp((position - 0.25) * 2))
        if (id === 67) {
          // Recover the isolated wet peaks after adding bass loss. Interpolate
          // the correction in squared decay progress between the measured settings.
          const progress = clamp((decay - ghostDecay25) / (ghostDecay75 - ghostDecay25))
          wetDb += blend(1.58, 3.33, progress ** 2)
        }
        wetGain = dbGain(wetDb)
      }
      const damping = has('lpf_freq') ? Math.exp(-tau * unit('lpf_freq') / sampleRate) : id === 25 ? 0.25 : 0.55
      const send = id === 67 ? feed * (0.8 + 0.2 * Math.sin(tau * phase + channel)) : feed
      let y = wet(send, decay, damping)
      if (id === 67) y = high(y, 1200, 10 * clamp(p('resonance')))
      if (has('low_eq')) y = low(y, 230, unit('low_eq'))
      if (has('high_eq')) y = high(y, 3500, unit('high_eq'))
      return blend(x, y * wetGain, clamp(p('mix')))
    }
  }, (l, r) => {
    feed = (l + r) * 0.5
    if (id === 67) phase = (phase + unit('rate') / sampleRate) % 1
  })
}
