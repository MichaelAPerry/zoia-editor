"""Round-trip every downloaded PatchStorage patch in corpus/."""
import json
import pathlib
import unittest

import zoiacodec
from tools.dedupe_corpus import duplicate_groups
from tools.licence_filter import read_index

CORPUS = pathlib.Path(__file__).resolve().parent.parent / "corpus"


class CorpusRoundTrip(unittest.TestCase):
    def test_corpus_index_matches_files(self):
        _, rows = read_index(CORPUS)
        names = sorted(row["file"] for row in rows)
        self.assertTrue(names)
        self.assertEqual(names, sorted(path.name for path in CORPUS.glob("*.bin")))

    def test_corpus_has_no_duplicates(self):
        self.assertEqual(duplicate_groups(CORPUS), {})

    def test_corpus(self):
        files = sorted(CORPUS.glob("*.bin"))
        self.assertTrue(files)
        for f in files:
            with self.subTest(f.name):
                data = f.read_bytes()
                patch = json.loads(json.dumps(zoiacodec.decode(data)))
                self.assertNotIn("decode_error", patch)
                self.assertEqual(zoiacodec.encode(patch), data)


if __name__ == "__main__":
    unittest.main()
