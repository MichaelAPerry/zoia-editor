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

Delay w/Mod measured 1031.042 ms between repeats (about 1031 ms), with feedback of 0.498. The simulator uses about 1031 ms and 0.500 at this setting and now adds the measured 64-sample offset once on the wet path. The simulator matches both measured slow LFO periods and all three Delay Line lags for the 1 s interpolated option. The curves between and beyond the measured settings are estimates.

## Reverb

Wet/dry values are peak ratios as recorded. The wet channel measured 0.8 dB higher on a same-signal reference, so subtract 0.8 dB from the hardware ratios to account for the recording offset. Hardware decay values are T20 fits extrapolated to a 60 dB drop. The simulator used T30 except for Ghostverb at 25%, where it used T20. A dash marks bands without a reliable hardware fit. No hardware fits passed the checks from 500 Hz through 8 kHz.

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
| Ghostverb 25% | −24.6 / −33.0 | — | — | 3.08 / 1.43 |
| Ghostverb 75% | −19.1 / −23.2 | — | — | 31.53 / 10.02 |

Plate, Hall, Room and Lite levels are within about 2 dB. Their decay estimates are mostly within 0.6 s at 125 and 250 Hz. Ghostverb needs a retake. At 75%, the 250 Hz tail persisted into the next burst and the decay estimate varied with the analysis window. Reverb stereo decorrelation and behavior of modules marked Approximate in the [simulator README](sim/README.md#module-support) remain open.
