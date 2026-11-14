#!/usr/bin/env python3
"""Turn a fixed-format study note into notes/YYYY-MM-DD.json and update the index.

The script uses only the Python standard library. Run it from any directory;
input paths are relative to the current directory, and notes are written next
to this repository's scripts folder.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
NOTES_DIR = ROOT / "notes"
INDEX_PATH = NOTES_DIR / "index.json"

SECTION_OF = {
    "【主題】": "topic",
    "【句型】": "patterns",
    "【單字】": "vocabulary",
    "【例句】": "examples",
    "【錯誤訂正】": "corrections",
}
HEADER_OF = {value: key for key, value in SECTION_OF.items()}
TRIPLE_KEYS = ("patterns", "vocabulary", "examples", "corrections")
REQUIRED_KEYS = ("topic", "patterns", "vocabulary")


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
    rows: dict[str, list[list[str]]] = {key: [] for key in TRIPLE_KEYS}

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

        if stripped.startswith("【"):
            close_section()
            if stripped not in SECTION_OF:
                add(line_no, f"未知的區段標題「{stripped}」")
                current = None
                current_count = 0
                continue
            key = SECTION_OF[stripped]
            if key in seen:
                add(line_no, f"區段{stripped}重複")
            seen[key] = line_no
            current = key
            current_header_line = line_no
            current_count = 0
            continue

        if current is None:
            add(line_no, "這一行不在任何區段裡")
            continue

        current_count += 1
        if current == "topic":
            topic_lines.append(stripped)
            continue

        parts = [part.strip() for part in re.split(r"[|｜]", stripped)]
        header = HEADER_OF[current]
        if len(parts) != 3:
            add(line_no, f"{header}欄位數量應為 3，實際為 {len(parts)}")
            continue
        empty_at = [index for index, part in enumerate(parts, 1) if part == ""]
        if empty_at:
            joined = "、".join(str(index) for index in empty_at)
            add(line_no, f"{header}第 {joined} 個欄位不可為空")
            continue
        rows[current].append(parts)

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

    return {
        "date": date,
        "topic": topic,
        "patterns": [
            {"jp": jp, "reading": reading, "zh": zh}
            for jp, reading, zh in rows["patterns"]
        ],
        "vocabulary": [
            {"jp": jp, "reading": reading, "zh": zh}
            for jp, reading, zh in rows["vocabulary"]
        ],
        "examples": [
            {"jp": jp, "reading": reading, "zh": zh}
            for jp, reading, zh in rows["examples"]
        ],
        "corrections": [
            {"wrong": wrong, "correct": correct, "explanation": explanation}
            for wrong, correct, explanation in rows["corrections"]
        ],
    }


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
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        note = parse_note(read_source(args.path))
        exists = day_exists(note["date"])
        if exists and not args.force:
            raise NoteError([f"錯誤：{note['date']} 的筆記已存在。若要覆寫請加上 --force"])
        if args.dry_run:
            suffix = "（將覆寫既有檔案，尚未寫入）" if exists else "（未寫入檔案）"
            print(f"驗證通過：{note['date']} {note['topic']}{suffix}")
            return 0
        write_text(NOTES_DIR / f"{note['date']}.json", dump_json(note))
        write_text(INDEX_PATH, dump_json(merge_index(load_index(), note)))
        action = "已覆寫" if exists else "已寫入"
        print(f"{action} notes/{note['date']}.json，並更新 notes/index.json")
        return 0
    except NoteError as exc:
        print("\n".join(exc.messages), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
