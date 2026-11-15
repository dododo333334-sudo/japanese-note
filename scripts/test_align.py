#!/usr/bin/env python3
"""Unit tests for furigana alignment."""

from __future__ import annotations

import importlib.util
import unittest
from pathlib import Path


def _load():
    path = Path(__file__).with_name("add_note.py")
    spec = importlib.util.spec_from_file_location("add_note", path)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


add_note = _load()


def ruby(surface: str, reading: str) -> str:
    segments, fallback = add_note.align_reading(surface, reading)
    if fallback:
        return "FALLBACK " + add_note_format(segments)
    return add_note_format(segments)


def add_note_format(segments: list[dict]) -> str:
    parts = []
    for segment in segments:
        if segment.get("r"):
            parts.append(f"{segment['t']}({segment['r']})")
        else:
            parts.append(segment["t"])
    return "".join(parts)


class AlignReadingTest(unittest.TestCase):
    def test_compound_between_kana(self) -> None:
        self.assertEqual(
            ruby("袋はご利用ですか", "ふくろはごりようですか"),
            "袋(ふくろ)はご利用(りよう)ですか",
        )

    def test_okurigana(self) -> None:
        self.assertEqual(ruby("温めますか", "あたためますか"), "温(あたた)めますか")

    def test_honorific_prefix(self) -> None:
        self.assertEqual(ruby("お願いします", "おねがいします"), "お願(ねが)いします")

    def test_katakana_word(self) -> None:
        self.assertEqual(
            ruby("ポイントカードはお持ちですか", "ポイントカードはおもちですか"),
            "ポイントカードはお持(も)ちですか",
        )

    def test_daijoubu(self) -> None:
        self.assertEqual(ruby("大丈夫です", "だいじょうぶです"), "大丈夫(だいじょうぶ)です")

    def test_motte_imasen(self) -> None:
        self.assertEqual(ruby("持っていません", "もっていません"), "持(も)っていません")

    def test_punctuation_sentence(self) -> None:
        self.assertEqual(
            ruby("まっすぐ行って、信号を右です。", "まっすぐいって、しんごうをみぎです。"),
            "まっすぐ行(い)って、信号(しんごう)を右(みぎ)です。",
        )

    def test_anchor_also_inside_kanji_reading(self) -> None:
        self.assertEqual(ruby("聞きます", "ききます"), "聞(き)きます")

    def test_identical_kana_has_no_ruby(self) -> None:
        segments, fallback = add_note.align_reading("すみません", "すみません")
        self.assertFalse(fallback)
        self.assertEqual(segments, [{"t": "すみません"}])

    def test_override(self) -> None:
        segments, fallback = add_note.align_reading(
            "お願いします",
            "おねがいします",
            {"お願いします": [{"t": "お"}, {"t": "願", "r": "ねが"}, {"t": "いします"}]},
        )
        self.assertFalse(fallback)
        self.assertEqual(segments[1], {"t": "願", "r": "ねが"})


if __name__ == "__main__":
    unittest.main()
