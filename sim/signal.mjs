import { sampleRate } from './engine/index.mjs'

export function fillTestSignal(left, right, offset) {
  for (let i = 0; i < left.length; i++) {
    const t = (offset + i) / sampleRate
    const beat = Math.floor(t * 2.5)
    const since = t - beat / 2.5
    const frequency = [110, 164.81, 220, 261.63][beat % 4]
    const pluck = t < 1.6 ? 0.24 * Math.min(1, since * 240) * Math.exp(-since * 16)
      * (Math.sin(2 * Math.PI * frequency * since) + 0.25 * Math.sin(6 * Math.PI * frequency * since)) : 0
    const click = offset + i === 0 ? 0.65 : 0
    left[i] = click + pluck
    right[i] = click + pluck * 0.83
  }
}
