#!/usr/bin/env python3
"""
Utility script to reproduce the YomiToku evaluation flow introduced in
https://qiita.com/kanzoo/items/9d382fe4ec991a7eacd2 .

The script downloads sample documents (optional), runs the YomiToku
DocumentAnalyzer on each image, and exports HTML/JSON/Markdown/CSV
artifacts together with optional visualization overlays—mimicking the
article's CLI walkthrough in Python code.
"""

from __future__ import annotations

import argparse
import csv
import importlib.util
import json
import os
import logging
import re
import sys
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Set

import cv2
import numpy as np
import torch
from requests import Response, get

_SCRIPT_PATH = Path(__file__).resolve()
_SCRIPT_DIR = _SCRIPT_PATH.parent

def _strip_script_dir_from_syspath() -> None:
    filtered = []
    for entry in sys.path:
        try:
            resolved = Path(entry or ".").resolve()
        except Exception:
            filtered.append(entry)
            continue
        if resolved != _SCRIPT_DIR:
            filtered.append(entry)
    sys.path[:] = filtered

_strip_script_dir_from_syspath()

_SPEC = importlib.util.find_spec("yomitoku")
if _SPEC is None:
    raise ModuleNotFoundError(
        "The 'yomitoku' package is not installed. "
        "Install it with `pip install yomitoku` "
        "(or `pip install \"yomitoku[gpu]\"` for GPU/XPU environments)."
    )

from yomitoku import DocumentAnalyzer
from yomitoku.document_analyzer import DocumentAnalyzerSchema
from yomitoku.export import export_csv, export_html, export_json, export_markdown
from google.api_core import exceptions as google_api_exceptions

# Ensure local Supabase helper is importable even after pruning sys.path.
_SUPABASE_UTILS_PATH = _SCRIPT_DIR / "supabase_utils.py"

logger = logging.getLogger("bcms.yomitoku")
if not logger.handlers:
    handler = logging.StreamHandler()
    formatter = logging.Formatter("[%(levelname)s] %(message)s")
    handler.setFormatter(formatter)
    logger.addHandler(handler)
logger.setLevel(logging.INFO)
if _SUPABASE_UTILS_PATH.exists():
    try:
        _supabase_spec = importlib.util.spec_from_file_location("supabase_utils", _SUPABASE_UTILS_PATH)
        if _supabase_spec and _supabase_spec.loader:
            _supabase_module = importlib.util.module_from_spec(_supabase_spec)
            sys.modules["supabase_utils"] = _supabase_module
            _supabase_spec.loader.exec_module(_supabase_module)
    except Exception as _exc:
        raise RuntimeError(f"Failed to load local supabase_utils module: {_exc}") from _exc

from supabase_utils import (
    SupabaseConfigError,
    SupabaseRepository,
    build_result_payload,
)

SUPPORTED_EXTENSIONS = {".png", ".jpg", ".jpeg", ".bmp", ".tif", ".tiff", ".webp"}

SUMMARY_HEADERS = [
    "名前",
    "名前（英語）",
    "職業",
    "Tel",
    "e-mail",
    "所属",
    "代表Tel",
    "所属住所郵便番号",
    "所属住所",
    "URL",
    "その他",
]
GEMINI_API_KEY_ENV = "GEMINI_API_KEY"
GEMINI_DEFAULT_MODEL = "gemini-2.0-flash"
GEMINI_ENV_FILE = Path(".env.local")
GEMINI_MODEL_INSTANCE = None


def load_manifest_data(manifest_path: Path) -> Dict[str, Any]:
    data = json.loads(manifest_path.read_text(encoding="utf-8"))
    entries = data.get("entries")
    if not isinstance(entries, list):
        raise ValueError("Manifest JSON must contain an 'entries' array.")
    return data


def index_manifest_entries(entries: List[Dict[str, Any]], base_dir: Path) -> Dict[str, Dict[str, Any]]:
    index: Dict[str, Dict[str, Any]] = {}
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        for key in ("source_path", "processed_path"):
            value = entry.get(key)
            if isinstance(value, str):
                index[value] = entry
                try:
                    candidate_path = Path(value)
                    if not candidate_path.is_absolute():
                        candidates = [
                            (base_dir / candidate_path).resolve(),
                            (Path.cwd() / candidate_path).resolve(),
                        ]
                        if candidate_path.parts and candidate_path.parts[0] == base_dir.name:
                            stripped = Path(*candidate_path.parts[1:])
                            if stripped.parts:
                                candidates.append((base_dir / stripped).resolve())
                        for resolved in candidates:
                            index[str(resolved)] = entry
                    else:
                        index[str(candidate_path.resolve())] = entry
                except Exception:
                    continue
    return index

EMAIL_PATTERN = re.compile(r"[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}")
URL_PATTERN = re.compile(r"(?:https?://|www\.)[^\s<>]+")
POSTAL_PATTERN = re.compile(r"〒?\d{3}-?\d{4}")
PHONE_PATTERN = re.compile(r"(?=(?:.*?\d){7,})(?:\+?\d[\d\-\s()]{7,}\d)")

COMPANY_KEYWORDS = [
    "株式会社",
    "有限会社",
    "合同会社",
    "Inc",
    "Co.",
    "Company",
    "Corporation",
    "University",
    "College",
    "School",
    "Institute",
]

OCCUPATION_KEYWORDS = [
    "部長",
    "課長",
    "主任",
    "代表",
    "社長",
    "取締役",
    "マネージャ",
    "Manager",
    "Engineer",
    "Sales",
    "Consultant",
    "Professor",
    "研究員",
    "担当",
]

ADDRESS_KEYWORDS = [
    "都",
    "道",
    "府",
    "県",
    "市",
    "区",
    "町",
    "村",
    "丁目",
    "番地",
    "号",
]

KANJI_PATTERN = re.compile(r"^[\u4e00-\u9fff々〆ヶ]{2,6}$")
ROMAN_NAME_PATTERN = re.compile(r"^[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+$")


def load_env_local(path: Path = GEMINI_ENV_FILE) -> Dict[str, str]:
    env: Dict[str, str] = {}
    if not path.exists():
        return env

    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip()
        if key:
            env[key] = value
            os.environ.setdefault(key, value)
    return env


def initialize_gemini(model_name: str) -> object | None:
    load_env_local()
    api_key = os.getenv(GEMINI_API_KEY_ENV)
    if not api_key:
        raise RuntimeError(
            f"Environment variable {GEMINI_API_KEY_ENV} is not set. Configure it in env.local."
        )

    try:
        import google.generativeai as genai  # type: ignore
    except ImportError as exc:  # pragma: no cover - optional dependency
        raise RuntimeError(
            "google-generativeai is not installed. Run `uv pip install google-generativeai`."
        ) from exc

    try:
        genai.configure(api_key=api_key)
        return genai.GenerativeModel(model_name)
    except Exception as exc:  # pragma: no cover - api init
        raise RuntimeError(f"Failed to initialize Gemini model: {exc}") from exc


def _extract_json_from_text(text: str) -> Dict[str, str] | None:
    match = re.search(r"\{.*\}", text, re.DOTALL)
    if not match:
        return None
    snippet = match.group(0)
    try:
        data = json.loads(snippet)
        if isinstance(data, dict):
            return data
    except json.JSONDecodeError:
        return None
    return None


def build_table_strings(results: DocumentAnalyzerSchema) -> List[str]:
    table_strings: List[str] = []
    for table in results.tables:
        rows: Dict[int, Dict[int, str]] = {}
        for cell in table.cells:
            row_idx = cell.row - 1
            col_idx = cell.col - 1
            rows.setdefault(row_idx, {})
            content = (cell.contents or "").strip()
            rows[row_idx][col_idx] = content

        rendered_rows: List[str] = []
        for row_idx in sorted(rows.keys()):
            cols = rows[row_idx]
            if not cols:
                continue
            max_col = max(cols.keys())
            row_cells = [cols.get(col, "") for col in range(max_col + 1)]
            joined = " | ".join(cell for cell in row_cells if cell)
            if joined:
                rendered_rows.append(joined)
        if rendered_rows:
            table_strings.append("\n".join(rendered_rows))
    return table_strings


def build_gemini_payload(results: DocumentAnalyzerSchema) -> Dict[str, List[str]]:
    paragraphs: List[str] = []
    for paragraph in results.paragraphs:
        text = (paragraph.contents or "").strip()
        if text:
            paragraphs.append(text.replace("\n", " "))

    table_strings = build_table_strings(results)

    lines = extract_lines(results)
    unique_lines: List[str] = []
    seen: Set[str] = set()
    for line in lines:
        if line not in seen:
            seen.add(line)
            unique_lines.append(line)
        if len(unique_lines) >= 200:
            break

    return {
        "paragraphs": paragraphs,
        "tables": table_strings,
        "lines": unique_lines,
    }


class GeminiRateLimitError(RuntimeError):
    """Raised when Gemini API quota is exhausted after retries."""


def call_gemini_summary(model: object, payload_dict: Dict[str, List[str]]) -> Dict[str, str]:
    payload = json.dumps(payload_dict, ensure_ascii=False)
    prompt = (
        "You are an assistant that extracts contact information from business card OCR snippets."
        "Given the JSON payload (paragraphs / tables / lines), return exactly one JSON object with keys "
        "['名前','名前（英語）','職業','Tel','e-mail','所属','代表Tel','所属住所郵便番号','所属住所','URL','その他']."
        "Use empty strings for unknown values and separate multiple entries with ';'. Respond with JSON only."
    )

    response = None
    for attempt in range(MAX_GEMINI_RETRIES):
        try:
            response = model.generate_content([
                {"text": prompt},
                {"text": payload},
            ])
            break
        except google_api_exceptions.ResourceExhausted as exc:
            if attempt + 1 >= MAX_GEMINI_RETRIES:
                raise GeminiRateLimitError(str(exc)) from exc
            wait_seconds = GEMINI_RETRY_BASE_DELAY * (2**attempt)
            logger.warning(
                "Gemini API レート制限 (429)。%.1f 秒後に再試行します… [%d/%d]",
                wait_seconds,
                attempt + 1,
                MAX_GEMINI_RETRIES,
            )
            time.sleep(wait_seconds)
        except Exception as exc:  # pragma: no cover - network
            raise RuntimeError(f"Gemini request failed: {exc}") from exc

    if response is None:
        raise RuntimeError("Gemini response was empty after retries.")

    text = getattr(response, "text", None)
    if not text:
        raise RuntimeError("Gemini response did not contain text output.")

    parsed = _extract_json_from_text(text)
    if not parsed:
        raise RuntimeError("Could not parse JSON from Gemini response.")

    result: Dict[str, str] = {}
    for key in SUMMARY_HEADERS:
        value = parsed.get(key, "") if isinstance(parsed, dict) else ""
        if value is None:
            value = ""
        result[key] = str(value)
    return result


def generate_summary_fields(results: DocumentAnalyzerSchema, gemini_model: object | None) -> Dict[str, str]:
    if gemini_model is None:
        return extract_summary_fields_heuristic(results)
    payload = build_gemini_payload(results)
    try:
        return call_gemini_summary(gemini_model, payload)
    except GeminiRateLimitError as exc:
        logger.warning("Gemini API の利用上限に到達しました。ヒューリスティック抽出に切り替えます。 (%s)", exc)
        return extract_summary_fields_heuristic(results)

SAMPLE_IMAGE_PATHS = [
    "static/in/demo.jpg",
    "static/in/gallery1.jpg",
    "static/in/gallery2.jpg",
    "static/in/gallery3.jpg",
    "static/in/gallery4.jpg",
    "static/in/gallery5.jpg",
    "static/in/gallery6.jpg",
    "static/in/gallery7.jpeg",
]

RAW_GITHUB_BASE = "https://raw.githubusercontent.com/kotaro-kinoshita/yomitoku/main/"

MAX_GEMINI_RETRIES = int(os.getenv("GEMINI_MAX_RETRIES", "3"))
GEMINI_RETRY_BASE_DELAY = float(os.getenv("GEMINI_RETRY_BASE_DELAY", "5"))


def resolve_device(requested: str) -> str:
    requested = requested.lower()

    if requested == "auto":
        if torch.cuda.is_available():
            return "cuda"
        if hasattr(torch, "xpu") and torch.xpu.is_available():  # type: ignore[attr-defined]
            return "xpu"
        return "cpu"

    if requested == "cuda":
        if torch.cuda.is_available():
            return "cuda"
        print("[WARN] CUDA was requested but is unavailable. Falling back to CPU.", file=sys.stderr)
        return "cpu"

    if requested == "xpu":
        if hasattr(torch, "xpu") and torch.xpu.is_available():  # type: ignore[attr-defined]
            return "xpu"
        print("[WARN] XPU was requested but is unavailable. Falling back to CPU.", file=sys.stderr)
        return "cpu"

    return "cpu"


def download_samples(destination: Path, force: bool = False) -> List[Path]:
    destination.mkdir(parents=True, exist_ok=True)
    downloaded: List[Path] = []

    for rel_path in SAMPLE_IMAGE_PATHS:
        url = f"{RAW_GITHUB_BASE}{rel_path}"
        target_path = destination / Path(rel_path).name
        if target_path.exists() and not force:
            downloaded.append(target_path)
            continue

        response: Response = get(url, timeout=60)
        response.raise_for_status()
        target_path.write_bytes(response.content)
        downloaded.append(target_path)

    return downloaded


_XPU_PATCHED = False


def enable_xpu_support() -> None:
    global _XPU_PATCHED
    if _XPU_PATCHED:
        return

    os.environ.setdefault("PYTORCH_ENABLE_XPU_FALLBACK", "1")

    try:
        import intel_extension_for_pytorch as ipex  # type: ignore

        print(f"[INFO] Loaded intel-extension-for-pytorch {ipex.__version__}", file=sys.stderr)
    except Exception as exc:  # pragma: no cover - optional dependency
        print(f"[WARN] Intel Extension for PyTorch not available: {exc}", file=sys.stderr)

    try:
        from yomitoku import base as yomitoku_base
    except ImportError:
        _XPU_PATCHED = True
        return

    device_property = yomitoku_base.BaseModule.__dict__.get("device")
    if not isinstance(device_property, property):
        _XPU_PATCHED = True
        return

    getter = device_property.fget
    setter = device_property.fset
    deleter = device_property.fdel

    def patched_setter(self, device):  # type: ignore[override]
        device_str = str(device).lower()
        if "xpu" in device_str:
            if hasattr(torch, "xpu") and torch.xpu.is_available():  # type: ignore[attr-defined]
                self._device = torch.device(device_str)
                return
            yomitoku_base.logger.warning("XPU is unavailable. Falling back to CPU.")
            self._device = torch.device("cpu")
            return
        assert setter is not None
        setter(self, device)

    yomitoku_base.BaseModule.device = property(  # type: ignore[assignment]
        getter,
        patched_setter,
        deleter,
        device_property.__doc__,
    )

    _XPU_PATCHED = True


def collect_image_paths(inputs: Sequence[Path]) -> List[Path]:
    collected: Dict[Path, None] = {}
    for item in inputs:
        path = item.expanduser()
        if not path.exists():
            raise FileNotFoundError(f"Input path does not exist: {path}")

        if path.is_file():
            if path.suffix.lower() not in SUPPORTED_EXTENSIONS:
                raise FileNotFoundError(f"Unsupported file type: {path.suffix} ({path})")
            collected[path.resolve()] = None
            continue

        for candidate in sorted(path.rglob("*")):
            if candidate.is_file() and candidate.suffix.lower() in SUPPORTED_EXTENSIONS:
                collected[candidate.resolve()] = None

    if not collected:
        raise FileNotFoundError("No supported images were found in the supplied inputs.")

    return sorted(collected.keys())


def load_bgr_image(path: Path) -> np.ndarray:
    image = cv2.imread(str(path), cv2.IMREAD_COLOR)
    if image is None:
        raise ValueError(f"Failed to load image: {path}")
    return image


def save_bgr_image(image: np.ndarray | None, path: Path) -> None:
    if image is None:
        return

    path.parent.mkdir(parents=True, exist_ok=True)
    success = cv2.imwrite(str(path), image)
    if not success:
        raise ValueError(f"Failed to save visualization to {path}")


def export_results(
    results: DocumentAnalyzerSchema,
    image_bgr: np.ndarray,
    base_path: Path,
    formats: Sequence[str],
    ignore_line_break: bool,
    export_figure: bool,
    export_figure_letter: bool,
) -> Dict[str, Path]:
    outputs: Dict[str, Path] = {}

    if not formats:
        return outputs

    base_path.mkdir(parents=True, exist_ok=True)
    stem = base_path.name
    image_arg = image_bgr if export_figure else None

    if "json" in formats:
        out_path = base_path / f"{stem}.json"
        export_json(
            results,
            str(out_path),
            ignore_line_break=ignore_line_break,
            img=image_arg,
            export_figure=export_figure,
        )
        outputs["json"] = out_path

    if "md" in formats:
        out_path = base_path / f"{stem}.md"
        export_markdown(
            results,
            str(out_path),
            ignore_line_break=ignore_line_break,
            img=image_arg,
            export_figure_letter=export_figure_letter,
            export_figure=export_figure,
        )
        outputs["md"] = out_path

    if "html" in formats:
        out_path = base_path / f"{stem}.html"
        export_html(
            results,
            str(out_path),
            ignore_line_break=ignore_line_break,
            img=image_arg,
            export_figure=export_figure,
            export_figure_letter=export_figure_letter,
        )
        outputs["html"] = out_path

    if "csv" in formats:
        out_path = base_path / f"{stem}.csv"
        export_csv(
            results,
            str(out_path),
            ignore_line_break=ignore_line_break,
            img=image_arg,
            export_figure=export_figure,
            export_figure_letter=export_figure_letter,
        )
        outputs["csv"] = out_path

    return outputs


def normalize_lines(text: str) -> List[str]:
    text = text.replace("<br>", "\n").replace("<BR>", "\n")
    parts = re.split(r"[\r\n]+", text)
    return [part.strip() for part in parts if part.strip()]


def extract_lines(results: DocumentAnalyzerSchema) -> List[str]:
    lines: List[str] = []
    seen: Set[str] = set()

    def add_line(line: str) -> None:
        normalized = line.strip()
        if normalized and normalized not in seen:
            seen.add(normalized)
            lines.append(normalized)

    for paragraph in results.paragraphs:
        for line in normalize_lines(paragraph.contents):
            add_line(line)

    for table in results.tables:
        for cell in table.cells:
            if cell.contents:
                for line in normalize_lines(cell.contents):
                    add_line(line)

    for word in results.words:
        content = getattr(word, "content", "") or getattr(word, "contents", "")
        if content:
            add_line(content)

    return lines


def extract_emails(lines: List[str]) -> List[str]:
    emails: Set[str] = set()
    for line in lines:
        for match in EMAIL_PATTERN.findall(line):
            emails.add(match)
    return sorted(emails)


def extract_urls(lines: List[str]) -> List[str]:
    urls: Set[str] = set()
    for line in lines:
        for match in URL_PATTERN.findall(line):
            cleaned = match.rstrip(".,);")
            urls.add(cleaned)
    return sorted(urls)


def normalize_phone(number: str) -> str:
    digits = re.sub(r"[^\d+]", "", number)
    if digits.startswith("00"):
        digits = "+" + digits.lstrip("0")
    return digits


def extract_phones(lines: List[str]) -> List[Dict[str, object]]:
    phones: List[Dict[str, object]] = []
    for idx, line in enumerate(lines):
        for match in PHONE_PATTERN.findall(line):
            normalized = normalize_phone(match)
            digits = re.sub(r"\D", "", normalized)
            if 9 <= len(digits) <= 15:
                phones.append({"value": normalized, "line_index": idx, "line": line})
    return phones


def extract_postal_code(lines: List[str]) -> str | None:
    for line in lines:
        match = POSTAL_PATTERN.search(line)
        if match:
            code = match.group(0).replace("〒", "")
            if "-" not in code and len(code) == 7:
                code = code[:3] + "-" + code[3:]
            return code
    return None


def extract_address(lines: List[str]) -> str | None:
    for line in lines:
        if "〒" in line:
            return line.replace("〒", "").strip()
    for line in lines:
        if any(keyword in line for keyword in ADDRESS_KEYWORDS) and any(ch.isdigit() for ch in line):
            return line
    return None


def extract_company(lines: List[str]) -> str | None:
    for line in lines:
        if any(keyword in line for keyword in COMPANY_KEYWORDS):
            return line
    return None


def extract_name(lines: List[str]) -> str | None:
    for line in lines:
        candidate = line.replace("様", "").strip()
        if KANJI_PATTERN.fullmatch(candidate):
            return candidate
        if ROMAN_NAME_PATTERN.fullmatch(candidate):
            return candidate
        parts = candidate.split()
        if 1 < len(parts) <= 3 and all(part and part[0].isupper() for part in parts if part):
            return candidate
    return None


def extract_occupation(lines: List[str]) -> str | None:
    for line in lines:
        for keyword in OCCUPATION_KEYWORDS:
            if keyword in line:
                return line
    return None


def extract_summary_fields_heuristic(results: DocumentAnalyzerSchema) -> Dict[str, str]:
    lines = extract_lines(results)
    used: Set[int] = set()

    name = extract_name(lines)
    if name is not None and name in lines:
        used.add(lines.index(name))

    english_name = ""
    for idx, line in enumerate(lines):
        candidate = line.strip()
        if ROMAN_NAME_PATTERN.fullmatch(candidate):
            english_name = candidate
            used.add(idx)
            break
    if english_name and (not name or name == english_name):
        name = english_name

    occupation = extract_occupation(lines)
    if occupation is not None:
        used.add(lines.index(occupation))

    company = extract_company(lines)
    if company is not None:
        used.add(lines.index(company))

    address = extract_address(lines)
    postal_code = extract_postal_code(lines)
    if address is not None:
        address_index = None
        for idx, line in enumerate(lines):
            compact = line.replace("〒", "").strip()
            if compact == address or address in compact:
                address_index = idx
                break
        if address_index is not None:
            used.add(address_index)
    if postal_code:
        for idx, line in enumerate(lines):
            if postal_code in line.replace("〒", "").replace("-", ""):
                used.add(idx)

    emails = extract_emails(lines)
    for email in emails:
        for idx, line in enumerate(lines):
            if email in line:
                used.add(idx)
                break

    urls = extract_urls(lines)
    for url in urls:
        for idx, line in enumerate(lines):
            if url in line:
                used.add(idx)
                break

    phone_entries = extract_phones(lines)
    personal_phone = ""
    company_phone = ""
    for entry in phone_entries:
        idx = entry["line_index"]
        line_lower = entry["line"].lower()
        value = entry["value"]
        if personal_phone and company_phone:
            break
        if any(keyword in line_lower for keyword in ["tel", "電話", "company", "office", "代表"]):
            if not company_phone:
                company_phone = value
                used.add(idx)
                continue
        if any(keyword in line_lower for keyword in ["携帯", "mobile", "cell"]):
            if not personal_phone:
                personal_phone = value
                used.add(idx)
                continue
        if not personal_phone:
            personal_phone = value
            used.add(idx)
        elif not company_phone:
            company_phone = value
            used.add(idx)

    remaining_lines: List[str] = []
    for idx, line in enumerate(lines):
        if idx not in used:
            remaining_lines.append(line)

    other = " / ".join(remaining_lines[:10])

    if postal_code and address and postal_code not in address:
        address_value = f"〒{postal_code} {address}"
    elif postal_code and not address:
        address_value = f"〒{postal_code}"
    else:
        address_value = address or ""

    if english_name and not name:
        name = english_name
    if not english_name and name and ROMAN_NAME_PATTERN.fullmatch(name.strip()):
        english_name = name

    postal_field = postal_code or ""
    url_field = ";".join(urls)

    return {
        "名前": name or "",
        "名前（英語）": english_name or "",
        "職業": occupation or "",
        "Tel": personal_phone,
        "e-mail": ";".join(emails),
        "所属": company or "",
        "代表Tel": company_phone,
        "所属住所郵便番号": postal_field,
        "所属住所": address_value,
        "URL": url_field,
        "その他": other,
    }


def run_analysis(
    analyzer: DocumentAnalyzer,
    image_path: Path,
    output_root: Path,
    formats: Sequence[str],
    ignore_line_break: bool,
    export_figure: bool,
    export_figure_letter: bool,
    visualize: bool,
) -> Dict[str, object]:
    image_bgr = load_bgr_image(image_path)
    output_dir = output_root / image_path.stem
    need_dir = bool(formats) or visualize
    if need_dir:
        output_dir.mkdir(parents=True, exist_ok=True)

    start = time.perf_counter()
    results, ocr_vis, layout_vis = analyzer(image_bgr)
    elapsed = time.perf_counter() - start

    outputs = export_results(
        results,
        image_bgr,
        output_dir,
        formats,
        ignore_line_break,
        export_figure,
        export_figure_letter,
    )

    vis_paths: Dict[str, Path] = {}
    if visualize:
        if not output_dir.exists():
            output_dir.mkdir(parents=True, exist_ok=True)
        ocr_path = output_dir / f"{image_path.stem}_ocr.jpg"
        layout_path = output_dir / f"{image_path.stem}_layout.jpg"
        save_bgr_image(ocr_vis, ocr_path)
        save_bgr_image(layout_vis, layout_path)
        vis_paths["ocr"] = ocr_path
        vis_paths["layout"] = layout_path

    report = {
        "image": str(image_path),
        "outputs": {key: str(path) for key, path in outputs.items()},
        "paragraphs": len(results.paragraphs),
        "tables": len(results.tables),
        "figures": len(results.figures),
        "words": len(results.words),
        "elapsed_seconds": round(elapsed, 3),
    }

    if visualize and vis_paths:
        report["visualizations"] = {key: str(path) for key, path in vis_paths.items()}

    summary_fields = generate_summary_fields(results, GEMINI_MODEL_INSTANCE)
    report["summary"] = summary_fields

    return report


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
        description="Run YomiToku OCR on images and export multiple formats.",
    )
    parser.add_argument(
        "inputs",
        nargs="*",
        help="One or more image paths or directories. "
        "Omit when using --download-samples to fetch the official demo images.",
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=Path("yomitoku_results"),
        help="Directory to store analysis artifacts.",
    )
    parser.add_argument(
        "--formats",
        nargs="+",
        default=[],
        choices=["html", "json", "md", "csv"],
        help="Per-image file formats to export.",
    )
    parser.add_argument(
        "--device",
        default="auto",
        choices=["auto", "cuda", "cpu", "xpu"],
        help="Inference device to use for YomiToku models.",
    )
    parser.add_argument(
        "--ignore-line-break",
        action="store_true",
        help="Ignore original line breaks when exporting text.",
    )
    parser.add_argument(
        "--export-figures",
        action="store_true",
        help="Export detected figure crops alongside structured outputs.",
    )
    parser.add_argument(
        "--export-figure-letter",
        action="store_true",
        help="Include text contained within detected figures.",
    )
    parser.add_argument(
        "--visualize",
        action="store_true",
        help="Save visualization overlays for OCR and layout predictions.",
    )
    parser.add_argument(
        "--reading-order",
        default="auto",
        choices=["auto", "top2bottom", "right2left", "left2right"],
        help="Reading order override passed to DocumentAnalyzer.",
    )
    parser.add_argument(
        "--ignore-meta",
        action="store_true",
        help="Drop detected header/footer elements from the structured output.",
    )
    parser.add_argument(
        "--split-text-across-cells",
        action="store_true",
        help="Enable cell-wise text splitting heuristics for table recognition.",
    )
    parser.add_argument(
        "--download-samples",
        action="store_true",
        help="Download the demo images bundled with the official YomiToku repository.",
    )
    parser.add_argument(
        "--force-download",
        action="store_true",
        help="Re-download sample images even if they already exist locally.",
    )
    parser.add_argument(
        "--samples-dir",
        type=Path,
        default=Path("yomitoku_samples"),
        help="Destination directory when --download-samples is used.",
    )
    parser.add_argument(
        "--max-images",
        type=int,
        help="Limit the number of images processed (useful for quick smoke tests).",
    )
    parser.add_argument(
        "--gemini-model",
        default=GEMINI_DEFAULT_MODEL,
        help="Gemini model name to use for contact extraction (requires GEMINI_API_KEY).",
    )
    parser.add_argument(
        "--disable-gemini",
        action="store_true",
        help="Disable Gemini-assisted summarization and use heuristic extraction only.",
    )
    parser.add_argument(
        "--record-to-db",
        action="store_true",
        help="Insert structured results into Supabase.",
    )
    parser.add_argument(
        "--user-id",
        help="Supabase auth user UUID (required when --record-to-db is set).",
    )
    parser.add_argument(
        "--project-id",
        help="Project UUID for result storage (defaults to manifest project).",
    )
    parser.add_argument(
        "--manifest",
        type=Path,
        help="Manifest JSON produced by preprocess_images.py to resolve DB identifiers.",
    )

    return parser.parse_args()


def main() -> None:
    args = parse_args()
    global GEMINI_MODEL_INSTANCE

    if args.disable_gemini:
        GEMINI_MODEL_INSTANCE = None
    else:
        try:
            GEMINI_MODEL_INSTANCE = initialize_gemini(args.gemini_model)
            print(f"[INFO] Gemini model '{args.gemini_model}' initialized for summary extraction.")
        except RuntimeError as exc:
            print(f"[ERROR] {exc}", file=sys.stderr)
            sys.exit(1)

    input_paths: List[Path] = [Path(p) for p in args.inputs]

    if args.download_samples:
        sample_dir = args.samples_dir
        downloaded = download_samples(sample_dir, force=args.force_download)
        print(f"[INFO] Downloaded {len(downloaded)} sample images to {sample_dir}")
        input_paths.extend(downloaded)

    if not input_paths:
        print("Error: No input images were provided. Specify paths or use --download-samples.", file=sys.stderr)
        sys.exit(1)

    try:
        image_paths = collect_image_paths(input_paths)
    except FileNotFoundError as exc:
        print(f"Error: {exc}", file=sys.stderr)
        sys.exit(1)

    if args.max_images is not None:
        image_paths = image_paths[: args.max_images]

    device = resolve_device(args.device)
    print(f"[INFO] Using device: {device}")

    if device == "xpu":
        enable_xpu_support()
        if hasattr(torch, "xpu") and torch.xpu.is_available():  # type: ignore[attr-defined]
            try:
                torch.xpu.set_device(0)  # type: ignore[attr-defined]
            except Exception:
                pass

    analyzer = DocumentAnalyzer(
        device=device,
        visualize=args.visualize,
        ignore_meta=args.ignore_meta,
        reading_order=args.reading_order,
        split_text_across_cells=args.split_text_across_cells,
    )

    manifest_path: Optional[Path] = args.manifest
    if manifest_path is None:
        candidate = args.output_dir / "manifest.json"
        if candidate.exists():
            manifest_path = candidate

    manifest_data: Dict[str, Any] = {}
    manifest_index: Dict[str, Dict[str, Any]] = {}
    if manifest_path:
        try:
            manifest_data = load_manifest_data(manifest_path)
            entries = manifest_data.get("entries") or []
            if isinstance(entries, list):
                manifest_index = index_manifest_entries(entries, manifest_path.parent.resolve())
        except Exception as exc:
            print(f"[ERROR] Failed to load manifest file {manifest_path}: {exc}", file=sys.stderr)
            sys.exit(1)
    elif args.record_to_db:
        print("[ERROR] --record-to-db requires a manifest file (use --manifest).", file=sys.stderr)
        sys.exit(1)

    user_id = args.user_id or manifest_data.get("user_id")
    project_id = args.project_id or manifest_data.get("project_id")

    if args.record_to_db and not user_id:
        print("[ERROR] Supabase user ID is required (provide --user-id or include in manifest).", file=sys.stderr)
        sys.exit(1)
    if args.record_to_db and not project_id:
        print("[ERROR] Project ID is required to record results (provide --project-id or ensure manifest contains it).", file=sys.stderr)
        sys.exit(1)

    repo: Optional[SupabaseRepository] = None
    if args.record_to_db:
        try:
            repo = SupabaseRepository()
        except SupabaseConfigError as exc:
            print(f"[ERROR] {exc}", file=sys.stderr)
            sys.exit(1)
        except Exception as exc:
            print(f"[ERROR] Failed to initialise Supabase client: {exc}", file=sys.stderr)
            sys.exit(1)
        print(f"[INFO] Recording YomiToku results to Supabase project {project_id}")
    project_id_str = str(project_id) if project_id else None
    user_id_str = str(user_id) if user_id else None

    args.output_dir.mkdir(parents=True, exist_ok=True)
    summary_csv_path = args.output_dir / "summary.csv"
    with summary_csv_path.open("w", encoding="utf-8", newline="") as csvfile:
        writer = csv.DictWriter(csvfile, fieldnames=SUMMARY_HEADERS)
        writer.writeheader()

        for image_path in image_paths:
            print(f"[INFO] Processing {image_path}")
            report = run_analysis(
                analyzer,
                image_path,
                args.output_dir,
                args.formats,
                args.ignore_line_break,
                args.export_figures,
                args.export_figure_letter,
                args.visualize,
            )
            summary_fields = report.get("summary", {}) or {}
            summary_row = {header: summary_fields.get(header, "") for header in SUMMARY_HEADERS}
            writer.writerow(summary_row)
            csvfile.flush()
            if repo and project_id_str and user_id_str:
                manifest_entry = manifest_index.get(str(image_path))
                if manifest_entry is None:
                    print(
                        f"[WARN] Manifest entry not found for {image_path}; skipping Supabase insert.",
                        file=sys.stderr,
                    )
                else:
                    source_image_id = manifest_entry.get("source_image_id")
                    if not isinstance(source_image_id, str):
                        print(
                            f"[WARN] Manifest entry missing source_image_id for {image_path}; skipping.",
                            file=sys.stderr,
                        )
                    else:
                        processed_image_id = manifest_entry.get("processed_image_id")
                        result_payload = build_result_payload(summary_fields)
                        result_payload["source"] = {
                            "path": str(image_path),
                            "filename": image_path.name,
                        }
                        storage_block: Dict[str, Any] = {}
                        if isinstance(manifest_entry.get("source_storage_path"), str):
                            storage_block["original"] = manifest_entry["source_storage_path"]
                        if isinstance(manifest_entry.get("processed_storage_path"), str):
                            storage_block["processed"] = manifest_entry["processed_storage_path"]
                        if storage_block:
                            result_payload["storage"] = storage_block
                        artifacts: Dict[str, Any] = {
                            "outputs": report.get("outputs", {}),
                        }
                        if "visualizations" in report:
                            artifacts["visualizations"] = report["visualizations"]
                        result_payload["artifacts"] = artifacts
                        result_payload["metrics"] = {
                            "paragraphs": report.get("paragraphs"),
                            "tables": report.get("tables"),
                            "figures": report.get("figures"),
                            "words": report.get("words"),
                            "elapsed_seconds": report.get("elapsed_seconds"),
                        }

                        summary_text = json.dumps(summary_fields, ensure_ascii=False)

                        try:
                            result_record = repo.insert_yomitoku_result(
                                project_id=project_id_str,
                                user_id=user_id_str,
                                source_image_id=source_image_id,
                                processed_image_id=processed_image_id if isinstance(processed_image_id, str) else None,
                                summary_text=summary_text,
                                result_payload=result_payload,
                                confidence=None,
                            )
                            repo.insert_result_fields(
                                result_id=result_record["id"],
                                project_id=project_id_str,
                                user_id=user_id_str,
                                payload=result_payload,
                            )
                            print(f"[INFO] Stored YomiToku result {result_record['id']} for {image_path}")
                        except Exception as exc:
                            print(f"[ERROR] Failed to store YomiToku result for {image_path}: {exc}", file=sys.stderr)
                            sys.exit(1)
            print(
                json.dumps(
                    {
                        "image": report["image"],
                        "paragraphs": report["paragraphs"],
                        "tables": report["tables"],
                        "figures": report["figures"],
                        "words": report["words"],
                        "elapsed_seconds": report["elapsed_seconds"],
                    },
                    ensure_ascii=False,
                )
            )
    print(f"[INFO] Saved summary CSV to {summary_csv_path}")


if __name__ == "__main__":
    main()
