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


class GrammarParseTest(unittest.TestCase):
    def test_explanation_keeps_internal_separators(self) -> None:
        text = """日期：2026-11-15

【主題】
結帳

【句型】
a｜a｜甲

【單字】
b｜b｜乙

【文法】
禮貌體與普通體｜對陌生人和店員句尾用「です／ます」；跟朋友多用普通體。｜持っています／もっています／禮貌；持ってる／もってる／口語
"""
        note = add_note.parse_note(text)
        item = note["grammar"][0]
        self.assertEqual(item["explanation"], "對陌生人和店員句尾用「です／ます」；跟朋友多用普通體。")
        self.assertEqual(
            [(example["jp"], example["reading"], example["zh"]) for example in item["examples"]],
            [("持っています", "もっています", "禮貌"), ("持ってる", "もってる", "口語")],
        )
        self.assertEqual(note["_warnings"], [])

    def test_optional_reading_and_chinese(self) -> None:
        text = """日期：2026-11-16

【主題】
點餐

【句型】
a｜a｜甲

【單字】
b｜b｜乙

【文法】
人數的說法｜一人讀法特殊。｜一人です／ひとりです；これ
をだけ｜只有日文，沒有漢字。｜これ
"""
        note = add_note.parse_note(text)
        first, second = note["grammar"]
        self.assertEqual(first["examples"][0]["zh"], "")
        self.assertEqual(first["examples"][0]["reading"], "ひとりです")
        self.assertEqual(second["examples"][0], {"jp": "これ", "reading": "", "zh": ""})
        self.assertEqual(note["_warnings"], [])

    def test_kanji_without_reading_warns(self) -> None:
        text = """日期：2026-11-16

【主題】
點餐

【句型】
a｜a｜甲

【單字】
b｜b｜乙

【文法】
助詞｜說明。｜水を飲む；写真を撮る/しゃしんをとる/拍照
"""
        note = add_note.parse_note(text)
        self.assertEqual(note["grammar"][0]["examples"][0]["reading"], "")
        self.assertIn("水を飲む", note["_warnings"][0])
        warnings = add_note.attach_segments(note, {})
        bare = note["grammar"][0]["examples"][0]
        self.assertEqual(bare["segments"], [{"t": "水を飲む"}])
        ruby = note["grammar"][0]["examples"][1]
        self.assertEqual(add_note_format(ruby["segments"]), "写真(しゃしん)を撮(と)る")
        self.assertFalse(any("写真" in warning for warning in warnings))

    def test_halfwidth_separators(self) -> None:
        text = """日期：2026-11-16

【主題】
點餐

【句型】
a|a|甲

【單字】
b|b|乙

【文法】
點|說明|これをください/これをください/這個;水を飲む/みずをのむ
"""
        note = add_note.parse_note(text)
        examples = note["grammar"][0]["examples"]
        self.assertEqual(examples[0]["zh"], "這個")
        self.assertEqual(examples[1]["zh"], "")
        self.assertEqual(examples[1]["reading"], "みずをのむ")

    def test_note_without_grammar(self) -> None:
        text = Path(__file__).resolve().parents[1].joinpath("examples/2026-11-14.txt").read_text(encoding="utf-8")
        note = add_note.parse_note(text)
        self.assertEqual(note["grammar"], [])


if __name__ == "__main__":
    unittest.main()
