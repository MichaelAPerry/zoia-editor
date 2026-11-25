# Simulator calibration

Bench patches ran on a ZOIA pedal with firmware 5.41. An audio interface recorded a dry reference burst on one channel and the effect output on the other at 48 kHz. The dry channel provided timing and level references for comparing each take with the simulator. For reverb, the same burst fed both effect inputs and the interface recorded one wet output.

## LFO and delay

| LFO raw setting | Measured period (s) |
| ---: | ---: |
| 2142 | 7.7478 |
| 1050 | 16.3088 |

| Delay setting | Hardware first lag (samples / ms) | Simulator first lag before calibration (samples) |
| --- | ---: | ---: |
| Delay Line 25% | 72 / 1.500 | 14 |
| Delay Line 50% | 133 / 2.771 | 219 |
| Delay Line 75% | 640 / 13.333 | 3242 |
| Delay w/Mod 50% | 49553 / 1032.354 | 49489 |

Delay w/Mod measured 1031.042 ms between repeats (about 1031 ms), with feedback of 0.498. The simulator uses about 1031 ms and 0.500 at this setting and now adds the measured 64-sample offset once on the wet path. The simulator matches both measured slow LFO periods and all three Delay Line lags for the 1 s interpolated option. The Delay Line curve between and beyond those settings remains approximate.

The pedal saves its CV-mode LFO rate as a float in Hz in each patch. A 195-point saved-rate dataset informs the simulator's curve. It interpolates in log Hz above the slow bench anchors through 50% CV, consolidating duplicates and omitting isolated reversals. NatGeo now runs at 0.143 Hz (previously 0.150 Hz), and another factory patch runs at 0.367 Hz (previously 0.461 Hz), matching the pedal at both settings.

Delay w/Mod's saved sample counts at 48 kHz show a linear knob from 62.5 to 2000 ms. The old interpolation made times in the bottom quarter up to 41% short. The simulator now interpolates evenly spaced ranges linearly, including the delay times for Ping Pong Delay, Reverse Delay and Stereo Spread, the Ghostverb rate, and the Gate and Compressor release times. Those other ranges remain approximate pending pedal measurements.

Flanger initializes its tap clock from the saved tap period. Syzygetic saves 13,824 samples (288 ms), giving a simulated sweep of 3.473 Hz versus 3.467 Hz on the pedal. The modulation depth remains approximate.

## Reverb

Wet/dry values are peak ratios as recorded. The wet channel measured 0.8 dB higher on a same-signal reference, so subtract 0.8 dB from the hardware ratios to account for the recording offset. Hardware decay values are T20 fits extrapolated to a 60 dB drop. The simulator used T30 for the measurements in this table. A dash marks bands without a reliable hardware fit. No hardware fits passed the checks from 500 Hz through 8 kHz.

| Reverb and decay setting | Wet/dry HW / sim (dB) | 63 Hz HW / sim (s) | 125 Hz HW / sim (s) | 250 Hz HW / sim (s) |
| --- | ---: | ---: | ---: | ---: |
| Plate 25% | −14.7 / −15.4 | — | 3.06 / 3.05 | 3.03 / 3.05 |
| Plate 75% | −16.2 / −14.7 | — | 10.33 / 10.79 | 9.13 / 10.64 |
| Hall 25% | −14.5 / −12.7 | 2.93 / 2.76 | 3.06 / 2.81 | 2.54 / 2.81 |
| Hall 75% | −16.1 / −14.4 | — | 8.52 / 9.13 | 6.45 / 8.70 |
| Room 25% | −12.4 / −14.5 | — | 1.82 / 1.75 | 1.85 / 1.73 |
| Room 75% | −13.8 / −15.5 | — | 5.93 / 5.63 | 5.78 / 5.18 |
| Lite 25% | −13.3 / −15.4 | — | 2.48 / 2.37 | 2.37 / 2.54 |
| Lite 75% | −14.0 / −13.1 | 5.35 / 6.80 | 6.02 / 7.01 | 5.75 / 6.52 |

Plate, Hall, Room and Lite levels are within about 2 dB. Their decay estimates are mostly within 0.6 s at 125 and 250 Hz. Reverb stereo decorrelation and unmeasured behavior remain approximate. See the [simulator module table](sim/README.md#module-support).

### Ghostverb

Five isolated pedal bursts per setting measured the long tail. The updated model adds low-frequency loss to the comb feedback and adjusts the wet gain. Decay values below use T20 for both pedal and simulator.

| Decay setting | 250 Hz pedal / sim (s) | 125 Hz pedal / sim (s) | Wet/dry peak pedal / sim (dB) |
| --- | ---: | ---: | ---: |
| 25% | 2.90 / 2.91 | — / 1.41 | −26.10 / −26.16 |
| 75% | 31.6 / 32.38 | 3.55 / 3.63 | −19.86 / −19.88 |

The 125 Hz tail at 75% was previously 33.31 s in the simulator. At 250 Hz and 75%, the longer T30 fit is still 33.58 s versus 29.05 s on the pedal. Other decay, modulation and resonance settings remain approximate.

## Distortion and audio switches

- OD & Distortion's Edgy model now hard-clips at ±0.22 and uses a post-clip smoothing coefficient of 0.70. In one factory drone recording, the level-matched 8 kHz error fell from 14.75 to 1.05 dB.
- Removing the extra 2× Fuzz drive reduced the level error by 3.4–6 dB across five factory drone recordings. The Edgy and Fuzz adjustments are partial. Distortion patches still render several dB too loud, and tone remains approximate.
- Multi-channel Audio In Switch and Audio Out Switch select channel 1 at 0 CV. A single-channel switch still uses the selector as an on/off gate.
