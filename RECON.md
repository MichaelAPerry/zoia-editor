# ZOIA pedal patch codec

## Binary layout

Files are exactly 32,768 bytes. Words are unsigned 32-bit little-endian integers. Offsets and record lengths below follow zoia_lib’s [Binary Format document](vendor/zoia_lib/documentation/Binary%20Format.docx) and the Juniper bytes. Names are 16-byte ASCII fields, zero-padded if shorter.

| Order | Layout |
| --- | --- |
| Header | Payload length in words, including the length word itself. Patch name at byte 4, then module count at byte 20. |
| Modules | Per record, eight words for record length in words (including itself), type ID, version-like field, zero-based page, legacy color ID, first grid position (0–39), parameter count, and an additional version/save-data word. Then eight individual option bytes, the counted raw parameter words, any extra saved bytes, and a final 16-byte module name on modern patches. Older records may omit the name. |
| Connections | Count word, then five words per connection for source module and block, destination module and block, and raw strength. Module indices are zero-based. Block indices refer to the complete module type layout, including hidden positions. Raw 10000 is 0 dB (unity). |
| Page names | Count word, then one 16-byte name per entry in page order. A count of zero is valid. Modules can occupy pages beyond the stored names. |
| Stars | Count word, then one word per star. Bit 31 distinguishes connection stars. Complement a connection star before reading its fields. Bits 0–15 hold the module or connection index, bits 16–22 hold the parameter block or reserved bits, and bits 23–30 hold MIDI CC plus one, with zero meaning unassigned. |
| Extended colors | Optional array of one word per module, in module order, without a count. The codec detects it by checking the space remaining after the stars within the declared payload. ID 1–15 means blue, green, red, yellow, aqua, magenta, white, orange, lime, surf, sky, purple, pink, peach, mango respectively. Legacy colors use IDs 1–7. |
| End | Juniper has zero padding from the declared payload end to EOF. Neither source uses a checksum, and no checksum field was identified in Juniper. |

The document calls module offset 8 unknown and offset 28 the module type version. The Python parser calls them version and size of saveable data respectively. The codec exposes both words verbatim as `version` and `save_word`. Parameter words commonly carry values in the 0–65535 range. Their ordering and interpretation depend on module type, options, and firmware. The save word is insufficient to delimit the saved data by itself, so the codec uses the record length and preserves the intervening bytes.

## JSON and CLI

Run from the repository root.

```sh
python3 -m zoiacodec decode in.bin out.json
python3 -m zoiacodec encode in.json out.bin
```

For scratch patches, provide a patch `name`, module records with `type_id` and `position`, and any `options` and raw `parameters` each configuration needs. Provide connections as `{"source": [module, block], "destination": [module, block], "strength": 10000}` and page names as `{"name": "Thru"}` entries in `pages`. Module names, page indices, and other header fields have defaults. The encoder derives sizes and counts, defaults extended colors to the modules’ header colors, and accepts `colors: []` for older layouts. Decoded `type` is a display label. `type_id` controls encoding.

The JSON preserves unknown data in `saved_data_hex`, `payload_tail_hex`, `padding_hex`, and `name_hex` when needed. The latter retains the original 16 bytes while the displayed name remains unchanged. For a recognizable header with an unsupported body, `decode_error` explains the fallback and `opaque_body_hex` and `module_count` preserve the original body and count. Such a file can be re-encoded, with body edits limited to its raw bytes.

## Connection checks

The editor encoder and IR generator use the same validator. It resolves fixed wire IDs through the option-dependent Module Index layout and requires audio-out to audio-in or CV-out to CV-in. The editor uses the same direction and signal checks on new cables. The Python codec also serves as the byte-preserving binary writer.

At the time of the audit, the corpus contained 414 files (including three empty slots). The audit covered 29,332 connections. The strict active layout flagged 31 connections in 22 patches. All matched three corpus-proven CV endpoint configurations:

| Module | Saved endpoint | Connections | Example |
| --- | --- | --- | --- |
| Rhythm | CV output block 3 with done control off and 168-byte save state | 7 | Instru to MIDI, slightlyrandom, Zoiasine |
| Delay w/Mod | CV input block 2 in tap-tempo mode | 15 | Arpulator, Upwards |
| Ping Pong Delay | CV input block 3 in rate mode | 9 | Am I Conscious, Slow Grind |

The encoder accepts those fixed endpoints in the observed configurations. The editor exposes the active jacks for new cables. Every corpus connection passed with those mappings, and the audit found zero direction or audio/CV exceptions.

## Sources and fixtures

- **zoia_lib**, GPL-3.0, local revision `fb32c3ec4239c73ca8af1cafe9ee0c2cb18d7a45`. The Python parser is the main modern layout reference. Its encoder reconstructs patches from the parser’s dictionary, with support for raw parameter values, connections, module saved data, and color tables. It can normalize names, option slots, page counts, stars, and padding, so use its output as a structural reference. The bundled module ID/name data has GPL provenance and a copy of the license beside it. [Parser](vendor/zoia_lib/zoia_lib/backend/patch_binary.py) · [Encoder](vendor/zoia_lib/zoia_lib/backend/patch_encode.py)
- **zoia-editor**, archived, GPL-3.0, local revision `6b8f53c6f738ed53f2c81ab9ade0e2e0d6ce1495`. The TypeScript UI delegates binary compilation to a Python service using pinned zoia_lib revision `9a959c4ef2ecbaa82f6525761472058bbead7d66`. It returns original bytes for unchanged imported documents and uses encode/reparse checks for supported edits and scratch configurations. Export is experimental and its conformance guide calls for hardware validation. [Compiler](vendor/zoia-editor/service/patch_compiler.py) · [Conformance guide](vendor/zoia-editor/docs/testing/patch-compiler-conformance.md)
- **zoia_lib assets** in `zoia_lib/tests/sample_files/`. The standalone `input_test.bin` is a patch-shaped test fixture with invalid modern record lengths. Its first module declares just one word, and the apparent second record also declares one. It round-trips through the opaque fallback. `sampleZIPBytes.bin` is a ZIP archive and is excluded as a patch. Its ten patch members are all copied into [fixtures](tests/fixtures): `000_zoia_Juniper.bin`, `001_zoia_Juniper.bin`, `002_zoia_Juniper.bin`, `003_zoia_Juniper.bin`, `004_zoia_Juniper.bin`, `005_zoia_Juniper.bin`, `006_zoia_Juniper.bin`, `007_zoia_Juniper.bin`, `008_zoia_Juniper.bin`, and `009_zoia_Juniper.bin`. The archive also contains Juniper patch notes.
- **zoia-editor assets**. No checked-in `.bin` files were found. Its `patches/` files are authored JSON documents and its conformance guide points to the upstream Juniper fixture.

## Hardware test

Back up the pedal’s patches with **Patches to SD** and copy the backup off the card. On a FAT32 microSD card, put [000_zoia_Test_Thru.bin](out/000_zoia_Test_Thru.bin) in a top-level `to_zoia/` folder by itself. `to_zoia` is the documented Librarian export default. Use the pedal’s **Patches from SD** command in the configuration menu and select the folder if prompted. The `000` prefix targets slot 0. Open **Test Thru** and check left and right separately. The patch routes stereo input through a stereo VCA set to its maximum raw level and then to stereo output. Record the firmware and whether the import and both channels work. [Vendored Librarian manual](vendor/zoia_lib/documentation/resources/manual.html)

## Open questions

Actual pedal import and audio behavior are pending. The exact menu wording and folder selection behavior depend on firmware and have yet to be checked against the pedal. The available modern fixtures are variations of one patch. More firmware versions and backups would help verify offset 8 and 28 semantics, old layouts without names or extended colors, real starred connections and MIDI assignments, and newer module options and saved-data formats. Legacy name detection is heuristic. Unknown bytes can be preserved without knowing their meaning.
