#!/usr/bin/env python3
"""Turn a fixed-format study note into notes/YYYY-MM-DD.json and update the index.

The script uses only the Python standard library. Run it from any directory;
input paths are relative to the current directory, and notes are written next
to this repository's scripts folder.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
NOTES_DIR = ROOT / "notes"
INDEX_PATH = NOTES_DIR / "index.json"
INDEX_HTML = ROOT / "index.html"
VERSION_PATH = ROOT / "version.txt"
ASSET_PATHS = (ROOT / "css" / "style.css", ROOT / "js" / "app.js")

SECTION_OF = {
    "【主題】": "topic",
    "【句型】": "patterns",
    "【文法】": "grammar",
    "【單字】": "vocabulary",
    "【例句】": "examples",
    "【錯誤訂正】": "corrections",
}
HEADER_OF = {value: key for key, value in SECTION_OF.items()}
TRIPLE_KEYS = ("patterns", "vocabulary", "examples", "corrections")
REQUIRED_KEYS = ("topic", "patterns")
OVERRIDES_PATH = NOTES_DIR / "ruby-overrides.json"

# Punctuation and whitespace are ignored when a kana anchor is matched to the reading.
_STRIPPED = frozenset(
    " \t\r\n\u3000。、？！?!，,．.・「」『』（）()［］[]【】／/…‥〜~～､｡･：:；;・"
)


def _is_base(char: str) -> bool:
    """Kanji, 々, and the ideographic placeholder 〇 get furigana."""
    if char in "々〇○〻":
        return True
    code = ord(char)
    return (
        0x3400 <= code <= 0x4DBF
        or 0x4E00 <= code <= 0x9FFF
        or 0xF900 <= code <= 0xFAFF
        or 0x20000 <= code <= 0x2CEAF
    )


def _kata_to_hira(char: str) -> str:
    code = ord(char)
    if 0x30A1 <= code <= 0x30F6:
        return chr(code - 0x60)
    return char


def _normalize_with_map(text: str) -> tuple[str, list[int]]:
    normalized: list[str] = []
    mapping: list[int] = []
    for index, char in enumerate(text):
        if char in _STRIPPED or char.isspace():
            continue
        normalized.append(_kata_to_hira(char))
        mapping.append(index)
    return "".join(normalized), mapping


def _normalize(text: str) -> str:
    return _normalize_with_map(text)[0]


def _tokenize(surface: str) -> list[tuple[str, str]]:
    tokens: list[tuple[str, str]] = []
    for char in surface:
        if _is_base(char):
            kind = "base"
        elif char in _STRIPPED or char.isspace():
            kind = "punct"
        else:
            kind = "kana"
        if tokens and tokens[-1][0] == kind:
            tokens[-1] = (kind, tokens[-1][1] + char)
        else:
            tokens.append((kind, char))
    collapsed: list[tuple[str, str]] = []
    index = 0
    while index < len(tokens):
        kind, text = tokens[index]
        if (
            kind == "base"
            and index + 2 < len(tokens)
            and tokens[index + 1][0] == "punct"
            and tokens[index + 2][0] == "base"
        ):
            merged = text + tokens[index + 1][1] + tokens[index + 2][1]
            index += 3
            while (
                index + 1 < len(tokens)
                and tokens[index][0] == "punct"
                and tokens[index + 1][0] == "base"
            ):
                merged += tokens[index][1] + tokens[index + 1][1]
                index += 2
            collapsed.append(("base", merged))
            continue
        collapsed.append((kind, text))
        index += 1
    return collapsed


def _match_spans(tokens: list[tuple[str, str]], reading_norm: str) -> dict[int, tuple[int, int]] | None:
    """Assign every kanji run a non-empty span of the normalized reading.

    Kana runs are anchors. Backtracking handles an anchor that also occurs
    inside a kanji reading. Consecutive kanji stay one run, so the match is
    pinned by the anchors around that run.
    """
    sequence: list[tuple[str, object]] = []
    for token_index, (kind, text) in enumerate(tokens):
        if kind == "punct":
            continue
        if kind == "base":
            sequence.append(("base", token_index))
            continue
        anchor = _normalize(text)
        if anchor:
            sequence.append(("anchor", anchor))

    if not sequence:
        return {} if reading_norm == "" else None

    solutions: list[dict[int, tuple[int, int]]] = []

    def walk(seq_index: int, pos: int, assigned: dict[int, tuple[int, int]]) -> None:
        if len(solutions) > 1:
            return
        if seq_index == len(sequence):
            if pos == len(reading_norm):
                solutions.append(dict(assigned))
            return
        kind, data = sequence[seq_index]
        if kind == "anchor":
            anchor = str(data)
            if reading_norm.startswith(anchor, pos):
                walk(seq_index + 1, pos + len(anchor), assigned)
            return
        later = sequence[seq_index + 1 :]
        reserved = sum(len(str(item[1])) for item in later if item[0] == "anchor")
        reserved += sum(1 for item in later if item[0] == "base")
        last = len(reading_norm) - reserved
        token_index = int(data)
        for end in range(pos + 1, last + 1):
            assigned[token_index] = (pos, end)
            walk(seq_index + 1, end, assigned)
            if len(solutions) > 1:
                return

    walk(0, 0, {})
    if len(solutions) != 1:
        return None
    return solutions[0]


def _fallback_segments(surface: str, reading: str) -> list[dict[str, str]]:
    if _normalize(surface) == _normalize(reading):
        return [{"t": surface}]
    return [{"t": surface, "r": reading}]


def _segments_cover(surface: str, segments: object) -> bool:
    if not isinstance(segments, list) or not segments:
        return False
    parts: list[str] = []
    for segment in segments:
        if not isinstance(segment, dict):
            return False
        text = segment.get("t")
        if not isinstance(text, str) or text == "":
            return False
        if "r" in segment and (not isinstance(segment["r"], str) or segment["r"] == ""):
            return False
        parts.append(text)
    return "".join(parts) == surface


def align_reading(
    surface: str,
    reading: str,
    overrides: dict | None = None,
) -> tuple[list[dict[str, str]], bool]:
    """Return furigana segments and whether a whole-word fallback was used.

    ``overrides`` maps the Japanese surface to a segments array. A missing or
    invalid override falls through to automatic alignment.
    """
    if overrides and surface in overrides and _segments_cover(surface, overrides[surface]):
        return overrides[surface], False

    try:
        tokens = _tokenize(surface)
        reading_norm, reading_map = _normalize_with_map(reading)
        spans = _match_spans(tokens, reading_norm)
        if spans is None:
            return _fallback_segments(surface, reading), True
        segments: list[dict[str, str]] = []

        def add_plain(text: str) -> None:
            if segments and "r" not in segments[-1]:
                segments[-1]["t"] += text
            else:
                segments.append({"t": text})

        for token_index, (kind, text) in enumerate(tokens):
            if kind != "base":
                add_plain(text)
                continue
            start, end = spans[token_index]
            ruby = "".join(reading[reading_map[index]] for index in range(start, end))
            if not ruby:
                return _fallback_segments(surface, reading), True
            segments.append({"t": text, "r": ruby})
        if not _segments_cover(surface, segments):
            return _fallback_segments(surface, reading), True
        return segments, False
    except Exception:
        return _fallback_segments(surface, reading), True


def load_overrides() -> dict:
    if not OVERRIDES_PATH.exists():
        return {}
    try:
        data = json.loads(OVERRIDES_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        print("警告：notes/ruby-overrides.json 無法讀取，已略過手動注音。", file=sys.stderr)
        return {}
    if not isinstance(data, dict):
        print("警告：notes/ruby-overrides.json 格式不正確，已略過手動注音。", file=sys.stderr)
        return {}
    return data


def _with_segments(entry: dict, overrides: dict, warnings: list[str]) -> dict:
    reading = entry.get("reading") or ""
    if not reading:
        return {**entry, "segments": [{"t": entry.get("jp", "")}]}
    try:
        segments, fallback = align_reading(entry["jp"], reading, overrides)
    except Exception:
        segments, fallback = _fallback_segments(entry.get("jp", ""), reading), True
    if fallback:
        warnings.append(f"警告：無法對齊讀音：{entry.get('jp', '')}｜{reading}")
    return {**entry, "segments": segments}


def attach_segments(note: dict, overrides: dict | None = None) -> list[str]:
    """Add segments to patterns, vocabulary, examples, and grammar. Never raises."""
    chosen = load_overrides() if overrides is None else overrides
    warnings: list[str] = []
    for key in ("patterns", "vocabulary", "examples"):
        note[key] = [_with_segments(entry, chosen, warnings) for entry in note.get(key, [])]
    for item in note.get("grammar", []):
        item["examples"] = [
            _with_segments(example, chosen, warnings) for example in item.get("examples", [])
        ]
    return warnings


class NoteError(Exception):
    """One or more problems in a note, already formatted for the terminal."""

    def __init__(self, messages: list[str]) -> None:
        super().__init__("\n".join(messages))
        self.messages = messages


def parse_note(text: str) -> dict:
    """Parse the fixed message format. Raise NoteError with every problem found."""
    errors: list[tuple[int, int, str]] = []

    def add(line: int | None, message: str) -> None:
        if line is None:
            errors.append((0, len(errors), f"錯誤：{message}"))
        else:
            errors.append((1, line, f"錯誤：第 {line} 行：{message}"))

    date: str | None = None
    saw_date = False
    seen: dict[str, int] = {}
    current: str | None = None
    current_header_line = 0
    current_count = 0
    topic_lines: list[str] = []
    rows: dict[str, list[tuple[list[str], str | None]]] = {key: [] for key in TRIPLE_KEYS}
    grammar_items: list[dict] = []
    grammar_warnings: list[str] = []
    default_situation: str | None = None

    def close_section() -> None:
        if current is None or current_count > 0:
            return
        header = HEADER_OF[current]
        if current == "topic":
            add(current_header_line, "【主題】不可為空")
        else:
            add(current_header_line, f"區段{header}是空的")

    for line_no, raw in enumerate(text.splitlines(), 1):
        stripped = raw.strip()
        if not stripped or stripped.startswith("#"):
            continue

        if stripped.startswith("日期：") or stripped.startswith("日期:"):
            saw_date = True
            match = re.fullmatch(r"日期[:：]\s*(\d{4}-\d{2}-\d{2})\s*", stripped)
            value = match.group(1) if match else ""
            if not match:
                add(line_no, "日期無效，請使用「日期：YYYY-MM-DD」")
                continue
            try:
                datetime.strptime(value, "%Y-%m-%d")
            except ValueError:
                add(line_no, f"日期無效：{value}")
                continue
            if date is not None:
                add(line_no, "日期重複")
                continue
            date = value
            continue

        if stripped.startswith("【情境】"):
            name = re.sub(r"^[:：]\s*", "", stripped[len("【情境】") :].strip())
            if not name:
                add(line_no, "【情境】不可為空")
            elif default_situation is not None:
                add(line_no, "【情境】重複")
            else:
                default_situation = name
            continue

        def consume_content(content: str, content_line: int) -> None:
            nonlocal current_count
            try:
                content, tagged = _split_situation_tag(content)
            except ValueError:
                add(content_line, "情境名稱不可為空")
                return
            if not content:
                add(content_line, "情境標記前面沒有項目內容")
                return
            current_count += 1
            if current == "topic":
                topic_lines.append(content)
                return
            if current == "grammar":
                item = _parse_grammar_line(content, content_line, add, grammar_warnings)
                if item is not None:
                    item["situation"] = tagged or default_situation or UNCATEGORIZED
                    grammar_items.append(item)
                return
            parts = [part.strip() for part in re.split(r"[|｜]", content)]
            header = HEADER_OF[current]
            if len(parts) != 3:
                add(content_line, f"{header}欄位數量應為 3，實際為 {len(parts)}")
                return
            empty_at = [index for index, part in enumerate(parts, 1) if part == ""]
            if empty_at:
                joined = "、".join(str(index) for index in empty_at)
                add(content_line, f"{header}第 {joined} 個欄位不可為空")
                return
            rows[current].append((parts, tagged))

        if stripped.startswith("【"):
            close_section()
            header_name = _match_header(stripped)
            if header_name is None:
                add(line_no, f"未知的區段標題「{stripped}」")
                current = None
                current_count = 0
                continue
            key = SECTION_OF[header_name]
            if key in seen:
                add(line_no, f"區段{header_name}重複")
            seen[key] = line_no
            current = key
            current_header_line = line_no
            current_count = 0
            rest = stripped[len(header_name):].strip()
            if rest:
                consume_content(rest, line_no)
            continue

        if current is None:
            add(line_no, "這一行不在任何區段裡")
            continue

        consume_content(stripped, line_no)

    close_section()

    if date is None and not saw_date:
        add(None, "缺少日期")
    for key in REQUIRED_KEYS:
        if key not in seen:
            add(None, f"缺少{HEADER_OF[key]}")

    if errors:
        errors.sort(key=lambda item: (item[0], item[1], item[2]))
        raise NoteError([item[2] for item in errors])

    assert date is not None
    topic = "\n".join(topic_lines).strip()
    if not topic:
        raise NoteError(["錯誤：【主題】不可為空"])

    def place(tagged: str | None) -> str:
        return tagged or default_situation or UNCATEGORIZED

    def triples(key: str) -> list[dict]:
        return [
            {"jp": jp, "reading": reading, "zh": zh, "situation": place(tagged)}
            for (jp, reading, zh), tagged in rows[key]
        ]

    return {
        "date": date,
        "topic": topic,
        "situation": default_situation or UNCATEGORIZED,
        "patterns": triples("patterns"),
        "vocabulary": triples("vocabulary"),
        "examples": triples("examples"),
        "corrections": [
            {
                "wrong": wrong,
                "correct": correct,
                "explanation": explanation,
                "situation": place(tagged),
            }
            for (wrong, correct, explanation), tagged in rows["corrections"]
        ],
        "grammar": grammar_items,
        "_warnings": grammar_warnings,
    }


_SITUATION_TAG = re.compile(r"(?:\s+)?#情境[:：]\s*(.*?)\s*$")
UNCATEGORIZED = "未分類"


def _split_situation_tag(line: str) -> tuple[str, str | None]:
    """Remove a trailing situation tag. Empty category raises ValueError."""
    match = _SITUATION_TAG.search(line)
    if not match:
        return line, None
    category = match.group(1).strip()
    if not category:
        raise ValueError("empty")
    return line[: match.start()].rstrip(), category


def _match_header(line: str) -> str | None:
    """Return the section header at the start of a line, if it is a known one."""
    found = ""
    for name in SECTION_OF:
        if line == name or line.startswith(name):
            if len(name) > len(found):
                found = name
    return found or None


def _contains_kanji(text: str) -> bool:
    return any(_is_base(char) for char in text)


def _parse_grammar_line(
    line: str,
    line_no: int,
    add,
    warnings: list[str],
) -> dict | None:
    """Split a grammar line on the first two pipes only.

    The explanation may contain ｜, ；, and ／. Example separators apply only
    to the third field.
    """
    parts = [part.strip() for part in re.split(r"[|｜]", line, maxsplit=2)]
    if len(parts) != 3:
        add(line_no, f"【文法】欄位數量應為 3，實際為 {len(parts)}")
        return None
    point, explanation, examples_field = parts
    missing = [str(index) for index, part in enumerate(parts, 1) if part == ""]
    if missing:
        add(line_no, f"【文法】第 {'、'.join(missing)} 個欄位不可為空")
        return None
    examples = []
    ok = True
    for chunk in re.split(r"[;；]", examples_field):
        piece = chunk.strip()
        if piece == "":
            add(line_no, "【文法】例句不可為空")
            ok = False
            continue
        fields = [field.strip() for field in re.split(r"[/／]", piece)]
        if len(fields) > 3:
            add(line_no, f"【文法】例句最多三欄（日文／讀音／中文）：{piece}")
            ok = False
            continue
        if fields[0] == "":
            add(line_no, "【文法】例句的日文不可為空")
            ok = False
            continue
        jp = fields[0]
        reading = fields[1] if len(fields) > 1 else ""
        zh = fields[2] if len(fields) > 2 else ""
        if not reading and _contains_kanji(jp):
            warnings.append(f"警告：第 {line_no} 行：文法例句含漢字但沒有讀音：{jp}")
        examples.append({"jp": jp, "reading": reading, "zh": zh})
    if not ok or not examples:
        return None
    return {"point": point, "explanation": explanation, "examples": examples}


def note_topics(note: dict) -> list[str]:
    topics = note.get("topics")
    if isinstance(topics, list):
        names = [topic for topic in topics if isinstance(topic, str) and topic]
        if names:
            return names
    topic = note.get("topic")
    return [topic] if isinstance(topic, str) and topic else []


def _item_key(kind: str, item: dict) -> str:
    if kind == "grammar":
        examples = "\u0002".join(
            "\u0001".join([example.get("jp", ""), example.get("reading", ""), example.get("zh", "")])
            for example in item.get("examples") or []
        )
        return "\u0000".join([item.get("point", ""), item.get("explanation", ""), examples])
    if kind == "corrections":
        return "\u0000".join([item.get("wrong", ""), item.get("correct", ""), item.get("explanation", "")])
    return "\u0000".join([item.get("jp", ""), item.get("reading", ""), item.get("zh", "")])


def merge_notes(existing: dict, incoming: dict) -> dict:
    """Keep the day's current items and append a second topic."""
    merged = dict(existing)
    topics = note_topics(existing)
    if incoming["topic"] not in topics:
        topics.append(incoming["topic"])
    merged["topics"] = topics
    merged["topic"] = "；".join(topics)
    for key in ("patterns", "vocabulary", "examples", "grammar", "corrections"):
        current = list(existing.get(key) or [])
        seen = {_item_key(key, item) for item in current}
        for item in incoming.get(key) or []:
            key_text = _item_key(key, item)
            if key_text in seen:
                continue
            seen.add(key_text)
            current.append(item)
        merged[key] = current
    return merged


def load_day(date: str) -> dict | None:
    path = NOTES_DIR / f"{date}.json"
    if not path.is_file():
        return None
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise NoteError([f"錯誤：notes/{date}.json 格式不正確"])
    return data


def merge_index(entries: list[dict], note: dict) -> list[dict]:
    """Return index entries with this day inserted, sorted by date."""
    merged = [item for item in entries if item.get("date") != note["date"]]
    merged.append({"date": note["date"], "topic": note["topic"]})
    merged.sort(key=lambda item: item["date"])
    return merged


def load_index() -> list[dict]:
    if not INDEX_PATH.exists():
        return []
    try:
        data = json.loads(INDEX_PATH.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise NoteError([f"錯誤：notes/index.json 不是合法的 JSON（第 {exc.lineno} 行）"]) from exc
    if not isinstance(data, list) or not all(
        isinstance(item, dict) and isinstance(item.get("date"), str) for item in data
    ):
        raise NoteError(["錯誤：notes/index.json 格式不正確"])
    return data


def day_exists(date: str) -> bool:
    if (NOTES_DIR / f"{date}.json").exists():
        return True
    return any(item.get("date") == date for item in load_index())


def asset_hash() -> str:
    digest = hashlib.sha256()
    for path in ASSET_PATHS:
        digest.update(path.name.encode())
        digest.update(b"\0")
        digest.update(path.read_bytes())
    return digest.hexdigest()[:12]


def next_asset_version(number: int, previous_hash: str, digest: str) -> int:
    if digest != previous_hash:
        return number + 1
    return number


def read_version_record() -> tuple[int, str]:
    if not VERSION_PATH.is_file():
        return 0, ""
    lines = VERSION_PATH.read_text(encoding="utf-8").splitlines()
    number = int(lines[0]) if lines and lines[0].isdigit() else 0
    digest = lines[1].strip() if len(lines) > 1 else ""
    return number, digest


def apply_asset_version(html: str, version: str) -> str:
    if not re.fullmatch(r"[0-9]+", version):
        raise NoteError([f"錯誤：資源版本必須是數字，目前是 {version}"])
    html, css_count = re.subn(r"(css/style\.css\?v=)[0-9]+", rf"\g<1>{version}", html, count=1)
    html, script_count = re.subn(r'(var current = ")[0-9]+(")', rf"\g<1>{version}\2", html, count=1)
    if css_count != 1 or script_count != 1:
        raise NoteError(["錯誤：index.html 找不到 css/style.css 或 app.js 的版本標記"])
    return html


def sync_asset_version() -> int:
    """Bump the asset query when app.js or style.css changes, and never move it backwards."""
    digest = asset_hash()
    number, previous = read_version_record()
    version = next_asset_version(number, previous, digest)
    html = INDEX_HTML.read_text(encoding="utf-8")
    updated = apply_asset_version(html, str(version))
    if updated != html:
        write_text(INDEX_HTML, updated)
    record = f"{version}\n{digest}\n"
    if not VERSION_PATH.is_file() or VERSION_PATH.read_text(encoding="utf-8") != record:
        write_text(VERSION_PATH, record)
    return version


def dump_json(data: object) -> str:
    return json.dumps(data, ensure_ascii=False, indent=2) + "\n"


def write_text(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.tmp")
    temporary.write_text(text, encoding="utf-8")
    temporary.replace(path)


def read_source(path: str | None) -> str:
    if path is None or path == "-":
        if hasattr(sys.stdin, "reconfigure"):
            try:
                sys.stdin.reconfigure(encoding="utf-8")
            except (OSError, ValueError):
                pass
        return sys.stdin.read()
    file = Path(path)
    if not file.is_file():
        raise NoteError([f"錯誤：找不到檔案 {path}"])
    try:
        return file.read_text(encoding="utf-8-sig")
    except UnicodeDecodeError as exc:
        raise NoteError([f"錯誤：無法以 UTF-8 讀取 {path}"]) from exc


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="把固定格式的日語筆記轉成 notes/YYYY-MM-DD.json，並更新 notes/index.json。"
    )
    parser.add_argument(
        "path",
        nargs="?",
        help="筆記文字檔路徑。省略或使用 - 時，從標準輸入讀取。",
    )
    parser.add_argument("--dry-run", action="store_true", help="只驗證格式，不寫入檔案。")
    parser.add_argument("--force", action="store_true", help="覆寫已經存在的同一天筆記。")
    parser.add_argument(
        "--sync-assets",
        action="store_true",
        help="依 js/app.js 與 css/style.css 的內容更新 version.txt 和 index.html 的版本參數。",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    if args.sync_assets and not args.path:
        try:
            version = sync_asset_version()
        except NoteError as exc:
            print("\n".join(exc.messages), file=sys.stderr)
            return 1
        print(f"已更新靜態資源版本 {version}")
        return 0
    try:
        note = parse_note(read_source(args.path))
        warnings = list(note.pop("_warnings", []))
        warnings.extend(attach_segments(note))
        for warning in warnings:
            print(warning, file=sys.stderr)
        existing = load_day(note["date"])
        topics = note_topics(existing) if existing else []
        same_topic = note["topic"] in topics
        if existing and same_topic and not args.force:
            raise NoteError([f"錯誤：{note['date']} 已有主題「{note['topic']}」。若要整篇覆寫請加上 --force"])
        merging = bool(existing) and not same_topic and not args.force
        if merging:
            note = merge_notes(existing, note)
        if args.dry_run:
            if merging:
                suffix = "（將併入既有筆記，尚未寫入）"
            elif existing:
                suffix = "（將整篇覆寫，尚未寫入）"
            else:
                suffix = "（未寫入檔案）"
            print(f"驗證通過：{note['date']} {note['topic']}{suffix}")
            return 0
        write_text(NOTES_DIR / f"{note['date']}.json", dump_json(note))
        write_text(INDEX_PATH, dump_json(merge_index(load_index(), note)))
        sync_asset_version()
        if merging:
            action = "已併入"
        elif existing:
            action = "已覆寫"
        else:
            action = "已寫入"
        print(f"{action} notes/{note['date']}.json，並更新 notes/index.json")
        return 0
    except NoteError as exc:
        print("\n".join(exc.messages), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
