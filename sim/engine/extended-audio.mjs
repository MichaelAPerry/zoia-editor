import { stereoEffect } from './audio.mjs'
import { blend, coefficient, delayLine, edge, eq, sampleRate, stateVariable, tap, tau, wave } from './dsp.mjs'
import { clamp } from './layout.mjs'
import { loopBuffer } from './loop.mjs'

const cabinetProfiles = {
  '4x12_full': [75, 4800, 2], '2x12_dark': [90, 3200, -2], '2x12_modern': [95, 5400, 2],
  '1x12': [115, 4600, 1], '1x8_lofi': [200, 2800, 4], '1x12_vintage': [130, 3900, 3],
  '4x12_hifi': [65, 6800, 0],
}

const pcm = value => Math.round(clamp(value, -1, 1) * 32767)

export const extendedAudio = {
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
