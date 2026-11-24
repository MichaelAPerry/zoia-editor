import { clamp } from './layout.mjs'

export const sampleRate = 48000
export const tau = 2 * Math.PI
export const blend = (a, b, t) => a + (b - a) * t
export const clean = x => Math.abs(x) >= 1e-24 && Number.isFinite(x) ? x : 0
export const coefficient = seconds => 1 - Math.exp(-1 / Math.max(1, seconds * sampleRate))

export function delayLine(size) {
  const data = new Float32Array(Math.ceil(size) + 2)
  let head = 0
  return {
    read(samples, interpolate = true) {
      const offset = clamp(samples, 1, data.length - 2)
      const whole = interpolate ? Math.floor(offset) : Math.round(offset)
      const index = head - whole + data.length
      const a = data[index % data.length]
      return interpolate ? blend(a, data[(index - 1) % data.length], offset - whole) : a
    },
    write(value) {
      data[head] = clean(value)
      head = (head + 1) % data.length
    },
  }
}

export function edge() {
  let previous = false
  return value => {
    const high = value > 0.5
    const rising = high && !previous
    previous = high
    return rising
  }
}

export function tap(initial) {
  const rising = edge()
  let count = 0
  let started = false
  let period = initial
  return value => {
    count++
    if (rising(value)) {
      if (started) period = clamp(count, 1200, 30 * sampleRate)
      started = true
      count = 0
    }
    return period
  }
}

export function randomSource(seed) {
  let state = seed >>> 0 || 1
  return () => {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    return (state >>> 0) / 4294967296
  }
}

export function wave(shape, p, duty = 0.5) {
  p -= Math.floor(p)
  switch (shape) {
    case 'square': return p < duty ? 1 : -1
    case 'triangle': return 1 - 4 * Math.abs(p - 0.5)
    case 'ramp': return 2 * p - 1
    case 'sawtooth': return 1 - 2 * p
    default: return Math.sin(tau * p)
  }
}

export function stateVariable() {
  let i1 = 0, i2 = 0, previousHz, previousQ, g, k, a
  return (input, hz, q, out) => {
    if (hz !== previousHz || q !== previousQ) {
      previousHz = hz
      previousQ = q
      g = Math.tan(Math.PI * clamp(hz, 5, 21000) / sampleRate)
      k = 1 / clamp(q, 0.15, 20)
      a = 1 / (1 + g * (g + k))
    }
    const band = a * (i1 + g * (input - i2))
    const low = i2 + g * band
    i1 = clean(2 * band - i1)
    i2 = clean(2 * low - i2)
    out.low = low
    out.band = band
    out.high = input - k * band - low
  }
}

// Cookbook biquad for the EQ and cutoff shapes, with coefficient updates when controls change.
export function eq(shape) {
  let z1 = 0, z2 = 0, oldHz, oldDb, oldQ, b0, b1, b2, a1, a2
  return (x, hz, db, q = 0.707) => {
    if (hz !== oldHz || db !== oldDb || q !== oldQ) {
      oldHz = hz
      oldDb = db
      oldQ = q
      const w = tau * clamp(hz, 5, 21000) / sampleRate
      const c = Math.cos(w), s = Math.sin(w)
      const A = 10 ** (db / 40)
      const alpha = s / (2 * clamp(q, 0.15, 20))
      const beta = Math.sqrt(2 * A) * s
      let a0
      if (shape === 'lpf' || shape === 'hpf') {
        const highpass = shape === 'hpf'
        a0 = 1 + alpha
        a1 = -2 * c
        a2 = 1 - alpha
        b0 = (1 + (highpass ? c : -c)) / 2
        b1 = (highpass ? -2 : 2) * b0
        b2 = b0
      } else if (shape === 'bell') {
        a0 = 1 + alpha / A
        a1 = -2 * c
        a2 = 1 - alpha / A
        b0 = 1 + alpha * A
        b1 = a1
        b2 = 1 - alpha * A
      } else {
        const sign = shape === 'low_shelf' ? 1 : -1
        const plus = A + 1, minus = A - 1
        a0 = plus + sign * minus * c + beta
        a1 = -2 * sign * (minus + sign * plus * c)
        a2 = plus + sign * minus * c - beta
        b0 = A * (plus - sign * minus * c + beta)
        b1 = 2 * sign * A * (minus - sign * plus * c)
        b2 = A * (plus - sign * minus * c - beta)
      }
      b0 /= a0
      b1 /= a0
      b2 /= a0
      a1 /= a0
      a2 /= a0
    }
    const y = b0 * x + z1
    z1 = clean(b1 * x - a1 * y + z2)
    z2 = clean(b2 * x - a2 * y)
    return y
  }
}

export function allpass() {
  let state = 0
  return (x, a) => {
    const y = state - a * x
    state = clean(x + a * y)
    return y
  }
}

export function delayAllpass(size) {
  const line = delayLine(size)
  return (x, samples, gain, interpolate = true) => {
    const y = line.read(samples, interpolate) - gain * x
    line.write(x + gain * y)
    return y
  }
}

export function dcBlock(hz) {
  const pole = Math.exp(-tau * hz / sampleRate)
  let previous = 0, y = 0
  return x => {
    y = clean(x - previous + pole * y)
    previous = x
    return y
  }
}

// Parallel damped combs and serial allpasses. Comb feedback is set by RT60.
export function reverbChannel(size, offset) {
  const lengths = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617]
    .map(n => Math.round(n * size + offset))
  const combs = lengths.map(n => delayLine(n))
  const filtered = new Float64Array(combs.length)
  const diffuserLengths = [556, 441, 341, 225].map(n => Math.round(n * size + offset))
  const diffusers = diffuserLengths.map(n => delayAllpass(n))
  const feedback = new Float64Array(combs.length)
  let previousDecay
  const removeDC = dcBlock(20)
  return (x, decay, damping) => {
    const highpass = removeDC(x)
    if (decay !== previousDecay) {
      previousDecay = decay
      for (let i = 0; i < combs.length; i++) feedback[i] = 0.001 ** (lengths[i] / (sampleRate * decay))
    }
    let sum = 0
    for (let i = 0; i < combs.length; i++) {
      const y = combs[i].read(lengths[i], false)
      filtered[i] = clean(blend(y, filtered[i], damping))
      combs[i].write(highpass + feedback[i] * filtered[i])
      sum += y
    }
    sum *= 0.025
    for (let i = 0; i < diffusers.length; i++) sum = diffusers[i](sum, diffuserLengths[i], 0.5, false)
    return sum
  }
}

export const vcaGain = x => clamp(x)
