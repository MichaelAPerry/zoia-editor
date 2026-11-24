import json
import struct
import unittest
from pathlib import Path

from zoiacodec import decode, encode

HERE = Path(__file__).resolve().parent


class CodecTests(unittest.TestCase):
    def test_every_vendor_fixture_round_trips_through_json(self):
        fixtures = sorted((HERE / "fixtures").glob("*.bin"))
        self.assertEqual(
            [file.name for file in fixtures],
            [f"{slot:03d}_zoia_Juniper.bin" for slot in range(10)] + ["input_test.bin"],
        )
        for fixture in fixtures:
            with self.subTest(fixture=fixture.name):
                original = fixture.read_bytes()
                patch = json.loads(json.dumps(decode(original), allow_nan=False))
                if fixture.name == "input_test.bin":
                    self.assertEqual(patch["name"], "UserPatch")
                    self.assertIn("invalid size 1 words", patch["decode_error"])
                else:
                    self.assertEqual(patch["name"], "Juniper")
                    self.assertEqual(len(patch["modules"]), 75)
                    self.assertEqual(patch["modules"][0]["type"], "Value")
                    self.assertEqual(len(patch["connections"]), 157)
                    self.assertEqual(len(patch["pages"]), 11)
                    self.assertEqual(len(patch["colors"]), 75)
                self.assertEqual(encode(patch), original)

    def test_scratch_thru_matches_binary_format_spec(self):
        draft = {
            "name": "Direct Thru",
            "modules": [
                {"type_id": 1, "position": 0, "options": [1]},
                {"type_id": 2, "position": 2, "options": [0, 1]},
            ],
            "connections": [{"source": [0, 0], "destination": [1, 0], "strength": 10000}],
            "pages": [{"name": "Thru"}],
        }
        # Independent byte layout from Binary Format.docx, including module
        # sizes, left-channel options, zero parameters and the color table.
        expected = (
            struct.pack("<I16sI", 48, b"Direct Thru", 2)
            + struct.pack("<8I8s16s", 14, 1, 0, 0, 1, 0, 0, 0, b"\x01", b"")
            + struct.pack("<8I8s16s", 14, 2, 0, 0, 1, 2, 0, 0, b"\x00\x01", b"")
            + struct.pack("<7I16s3I", 1, 0, 0, 1, 0, 10000, 1, b"Thru", 0, 1, 1)
        ).ljust(32768, b"\0")
        binary = encode(draft)
        self.assertEqual(binary, expected)

        for module, name in zip(draft["modules"], ["Audio Input", "Audio Output"]):
            module.update(
                type=name, version=0, page=0, header_color=1, save_word=0, name="",
                parameters=[], options=module["options"] + [0] * (8 - len(module["options"])),
            )
        draft.update(starred=[], colors=[1, 1])
        self.assertEqual(decode(binary), draft)

    def test_opaque_fields_and_connection_stars(self):
        patch = {
            "name": "X",
            "name_hex": (b"X\0\xff" + bytes(13)).hex(),
            "modules": [{
                "type_id": 999,
                "position": 3,
                "options": [1, 2, 3, 4, 5, 6, 7, 255],
                "parameters": [0xFFFFFFFF],
                "save_word": 600,
                "saved_data_hex": "deadbeef",
            }],
            "colors": [0],
            "starred": [
                {"module": 0, "block": 120, "midi_cc": 3},
                {"connection": 0, "reserved": 100, "midi_cc": None},
            ],
            "payload_tail_hex": "deadbeef",
            "padding_hex": "00ff",
        }
        binary = encode(patch)
        decoded = decode(binary)
        self.assertEqual(decoded["modules"][0]["type"], "Unknown module 999")
        for key in ("name_hex", "colors", "starred", "payload_tail_hex", "padding_hex"):
            self.assertEqual(decoded[key], patch[key])
        self.assertEqual(decoded["modules"][0]["saved_data_hex"], "deadbeef")
        self.assertEqual(binary, encode(decoded))
        decoded["name"] = "Renamed"
        self.assertEqual(decode(encode(decoded))["name"], "Renamed")

    def test_legacy_module_without_name_or_extended_color(self):
        patch = {
            "modules": [{"type_id": 1, "name": None, "position": 0}],
            "colors": [],
        }
        binary = encode(patch)
        decoded = decode(binary)
        self.assertIsNone(decoded["modules"][0]["name"])
        self.assertEqual(decoded["colors"], [])
        self.assertEqual(encode(decoded), binary)

    def test_hardware_artifact_is_stereo_vca_thru(self):
        binary = (HERE.parent / "out" / "000_zoia_Test_Thru.bin").read_bytes()
        patch = decode(binary)
        self.assertEqual(patch["name"], "Test Thru")
        self.assertEqual(patch["pages"], [{"name": "Thru"}])
        self.assertEqual([module["type_id"] for module in patch["modules"]], [1, 7, 2])
        self.assertEqual([module["options"][0] for module in patch["modules"]], [0, 1, 0])
        self.assertEqual(patch["modules"][2]["options"][1], 0)
        self.assertEqual(patch["modules"][1]["parameters"], [65535])
        self.assertEqual(
            [(c["source"], c["destination"], c["strength"]) for c in patch["connections"]],
            [([0, 0], [1, 0], 10000), ([0, 1], [1, 1], 10000),
             ([1, 3], [2, 0], 10000), ([1, 4], [2, 1], 10000)],
        )
        self.assertEqual(encode(patch), binary)

    def test_rejects_invalid_file_size(self):
        with self.assertRaisesRegex(ValueError, "exactly 32768"):
            decode(b"PK")
        self.assertEqual(decode(bytes(32768)), {"empty": True})  # blank slot
        self.assertEqual(encode({"empty": True}), bytes(32768))
        with self.assertRaisesRegex(ValueError, "Invalid patch size"):
            decode(b"\x01" + bytes(32767))
        with self.assertRaisesRegex(ValueError, "exceeds 32768"):
            encode({"pages": [{}] * 2048})
