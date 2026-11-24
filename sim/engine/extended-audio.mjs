import { stereoEffect } from './audio.mjs'
import { allpass, blend, clean, coefficient, delayLine, edge, eq, sampleRate, stateVariable, tap, tau, wave } from './dsp.mjs'
import { clamp, dbGain } from './layout.mjs'
import { loopBuffer } from './loop.mjs'
import { sampler } from './sampler.mjs'

const cabinetProfiles = {
  '4x12_full': [75, 4800, 2], '2x12_dark': [90, 3200, -2], '2x12_modern': [95, 5400, 2],
  '1x12': [115, 4600, 1], '1x8_lofi': [200, 2800, 4], '1x12_vintage': [130, 3900, 3],
  '4x12_hifi': [65, 6800, 0],
}

const pcm = value => Math.round(clamp(value, -1, 1) * 32767)

export const extendedAudio = {
  102: sampler,
  106(m) {
    const { p, unit, has } = m
    const minimum = 3000, maximum = 60000
    const clocked = has('tap_tempo_in'), tempo = tap(sampleRate / 2)
    // ASSUMPTION: The tap-ratio CV selects the same divisions as Ping Pong Delay.
    const ratios = [1, 2 / 3, 1 / 2, 1 / 3, 3 / 8, 1 / 4, 3 / 16, 1 / 8, 1 / 16, 1 / 32]
    let length = minimum, speed = 1, feedback = 0, mix = 0
    return stereoEffect(m, () => {
      // ASSUMPTION: Alternate fixed capture windows and resample the previous
      // window in reverse, wrapping pitch-shifted reads inside that window.
      let capture = new Float32Array(maximum), previous = new Float32Array(maximum)
      let head = 0, captureLength = 0, previousLength = 0, read = 0
      return x => {
        if (head === 0) captureLength = length
        let wet = 0
        if (previousLength) {
          const index = Math.floor(read)
          wet = blend(previous[index], previous[(index + 1) % previousLength], read - index)
          read = ((read - speed) % previousLength + previousLength) % previousLength
        }
        capture[head++] = clean(x + wet * feedback)
        if (head === captureLength) {
          const completed = capture
          capture = previous
          previous = completed
          previousLength = captureLength
          read = previousLength - 1
          head = 0
        }
        return blend(x, wet, mix)
      }
    }, () => {
      length = Math.round(clamp(clocked
        ? tempo(p('tap_tempo_in')) * ratios[Math.round(clamp(p('tap_ratio')) * (ratios.length - 1))]
        : unit('delay_time') * sampleRate / 1000, minimum, maximum))
      speed = 2 ** (unit('pitch') / 12)
      feedback = Math.min(0.99, dbGain(unit('feedback')))
      mix = clamp(p('mix'))
    })
  },
  107(m) {
    const { p, unit, has } = m
    const clocked = has('tap_tempo_in'), direct = has('direct')
    const tempo = tap(sampleRate / 2)
    let phase = 0, depth = 0, resonance = 0, mix = 0
    return stereoEffect(m, channel => {
      // ASSUMPTION: Model the topology with a short vibrato delay and four
      // unequal allpass stages, with a quarter-cycle stereo offset.
      const line = delayLine(256)
      const stages = [180, 380, 760, 1500].map(hz => ({ hz, filter: allpass() }))
      let previous = 0
      return x => {
        const sweep = direct ? clamp(p('direct')) : 0.5 + 0.5 * Math.sin(tau * (phase + channel / 4))
        const vibrato = line.read(24 + 192 * depth * sweep)
        line.write(x)
        let wet = vibrato + previous * resonance
        for (const { hz, filter } of stages) {
          const t = Math.tan(Math.PI * hz * (0.5 + 3 * depth * sweep) / sampleRate)
          wet = filter(wet, (1 - t) / (1 + t))
        }
        previous = wet
        return blend(x, wet, depth * mix)
      }
    }, () => {
      if (!direct) phase = (phase + (clocked ? 1 / tempo(p('tap_tempo_in')) : unit('rate') / sampleRate)) % 1
      depth = clamp(p('depth'))
      resonance = 0.8 * clamp(p('resonance'))
      mix = clamp(p('mix'))
    })
  },
  8: ({ p, put }) => () => put('audio_out', clamp(p('audio_in_1') * p('audio_in_2'), -1, 1)),
  30({ p, put, unit, has, options }) {
    const buffer = loopBuffer(parseInt(options.max_rec_time, 10) * sampleRate)
    const record = edge(), restart = edge(), stop = edge(), reset = edge()
    let recording = false, playing = false, overdub = false
    return () => {
      const x = p('audio_in')
      let rewind = false
      const reverse = p('reverse_playback') > 0.5
      if (reset(p('reset'))) {
        buffer.clear()
        recording = playing = overdub = false
      }
      if (record(p('record'))) {
        if (recording) {
          recording = false
          playing = true
          rewind = true
        } else if (options.overdub === 'yes' && buffer.length) {
          overdub = !overdub
          playing = true
        } else {
          buffer.clear()
          recording = true
          playing = false
        }
      }
      if (stop(p('stop_play'))) playing = !playing
      const speed = unit('speed_pitch') / 100
      const start = has('start_position') ? clamp(Math.round(unit('start_position') * sampleRate), 0, Math.max(0, buffer.length - 1)) : 0
      const span = has('loop_length') ? Math.round(unit('loop_length') * sampleRate * (options.length === 'pre_speed' ? speed : 1)) : buffer.length
      const end = Math.min(buffer.length, start + Math.max(1, span))
      if (restart(p('restart_playback'))) {
        playing = true
        rewind = true
      }
      if (rewind) buffer.rewind(reverse, start, end)
      let y = 0
      if (recording) {
        y = options.hear_while_rec === 'yes' ? x : 0
        if (!buffer.record(clamp(x, -1, 1))) {
          recording = false
          playing = true
          buffer.rewind(reverse, start, Math.min(buffer.length, start + Math.max(1, span)))
        }
      } else if (playing && buffer.length) {
        y = buffer.read(start, end, reverse ? -speed : speed, options.playback === 'loop', overdub ? x : undefined)
      }
      put('audio_out', y)
    }
  },
  36({ p, put }) {
    const fastCoef = coefficient(0.002), slowCoef = coefficient(0.04)
    let fast = 0, slow = 0, cooldown = 0
    return () => {
      const x = Math.abs(p('audio_in'))
      fast = blend(fast, x, fastCoef)
      slow = blend(slow, x, slowCoef)
      const sensitivity = clamp(p('sensitivity', 0.5))
      if (!cooldown && fast > slow * 2.5 + 0.1 * (1 - sensitivity) + 0.002) cooldown = 2400
      put('audio_out', Number(cooldown > 2352))
      if (cooldown) cooldown--
    }
  },
  58({ p, put }) {
    let previous = 0, elapsed = 0, period = 0, note = 0, armed = false
    return () => {
      const x = p('audio_in')
      elapsed++
      if (x < -0.004) armed = true
      if (armed && x >= 0 && previous < 0) {
        if (elapsed >= 12 && elapsed <= 1800) {
          period = period ? blend(period, elapsed, 0.3) : elapsed
          note = clamp(Math.log2(sampleRate / (27.5 * period)) / 10)
        } else period = 0
        elapsed = 0
        armed = false
      }
      previous = x
      put('cv_output', note)
    }
  },
  59({ p, put, unit }) {
    const window = 2048
    const line = delayLine(window + 1)
    let phase = 0
    return () => {
      const x = p('audio_in')
      const semitones = unit('pitch_shift')
      const ratio = 2 ** (semitones / 12)
      const opposite = (phase + 0.5) % 1
      const weight = 0.5 - 0.5 * Math.cos(tau * phase)
      const shifted = blend(line.read(1 + window * opposite), line.read(1 + window * phase), weight)
      put('audio_out', Math.abs(semitones) < 0.002 ? x : shifted)
      phase += (1 - ratio) / window
      phase -= Math.floor(phase)
      line.write(x)
    }
  },
  63({ p, put, options }) {
    const combine = options.type === 'and' ? (a, b) => a & b
      : options.type === 'or' ? (a, b) => a | b : (a, b) => a ^ b
    return () => put('audio_out', combine(pcm(p('audio_in_1')), pcm(p('audio_in_2'))) / 32768)
  },
  65: ({ p, put }) => () => put('audio_out', -p('audio_in')),
  68(m) {
    const [low, high, presence] = cabinetProfiles[m.options.type]
    return stereoEffect(m, () => {
      const highpass = eq('hpf'), lowpass = eq('lpf'), mid = eq('bell')
      return x => lowpass(mid(highpass(x, low, 0), 1300, presence), high, 0)
    })
  },
  72(m) {
    const { p, unit, options } = m
    const type = { bpf: 'band', hpf: 'high', lpf: 'low' }[options.filter_type]
    const attack = coefficient(0.008), release = coefficient(0.12)
    let level = 0, frequency = 0
    return stereoEffect(m, () => {
      const filter = stateVariable(), out = {}
      return x => {
        filter(x, frequency, unit('filter_q'), out)
        return out[type]
      }
    }, (left, right) => {
      const x = Math.max(Math.abs(left), Math.abs(right))
      level = blend(level, x, x > level ? attack : release)
      const amount = clamp(level * (1 + 24 * clamp(p('sensitivity'))))
      const low = unit('min_freq'), high = unit('max_freq')
      frequency = low * (high / low) ** (options.direction === 'down' ? 1 - amount : amount)
    })
  },
  73({ p, put, unit, options }) {
    let phase = 0
    return () => {
      const x = p('audio_in')
      const carrier = options.ext_audio_in === 'on' ? p('ext_in')
        : wave(options.waveform, phase, clamp(p('duty_cycle', 0.5), 0.01, 0.99))
      if (options.ext_audio_in === 'off') phase = (phase + unit('frequency') / sampleRate) % 1
      put('audio_out', blend(x, x * carrier, clamp(p('mix'))))
    }
  },
  83(m) {
    const { p, unit, options, u32 } = m
    const limit = parseInt(options.max_grain_size, 10) * sampleRate
    const count = options.num_grains
    const sizeTap = tap(u32(4, sampleRate / 4)), positionTap = tap(u32(8, sampleRate / 4))
    let size, position, speed, density, texture, frozen
    return stereoEffect(m, () => {
      const line = delayLine(2 * limit)
      const ages = new Float64Array(count).fill(-1)
      const lengths = new Float64Array(count)
      const offsets = new Float64Array(count)
      const rates = new Float64Array(count)
      let wait = 0, grain = 0
      return x => {
        if (--wait <= 0 && density > 0) {
          ages[grain] = 0
          lengths[grain] = size
          offsets[grain] = position + (m.random() - 0.5) * texture * size * 0.5
          rates[grain] = speed
          grain = (grain + 1) % count
          wait = Math.max(1, Math.round(size / (count * density)))
        }
        let sum = 0, total = 0
        for (let i = 0; i < count; i++) {
          if (ages[i] < 0 || ages[i] >= lengths[i]) continue
          const age = ages[i]++
          const weight = Math.sin(Math.PI * age / lengths[i]) ** (1 + 3 * texture)
          const offset = offsets[i] + (frozen ? -rates[i] : 1 - rates[i]) * age
          sum += weight * line.read(offset)
          total += weight
        }
        if (!frozen) line.write(x)
        return sum / Math.max(1, total)
      }
    }, () => {
      size = clamp(options.size_control === 'tap_tempo' ? sizeTap(p('grain_size')) : unit('grain_size') / 16000 * limit, 16, limit)
      position = clamp(options.pos_control === 'tap_tempo' ? positionTap(p('grain_position')) : unit('grain_position') / 16000 * limit, 1, limit)
      speed = unit('speed_pitch') / 100
      density = clamp(p('density'))
      texture = clamp(p('texture'))
      frozen = p('freeze') > 0.5
    })
  },
}
