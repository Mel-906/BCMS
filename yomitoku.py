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
import importlib.util
import json
import os
import sys
import time
from pathlib import Path
from typing import Dict, List, Sequence

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

SUPPORTED_EXTENSIONS = {".png", ".jpg", ".jpeg", ".bmp", ".tif", ".tiff", ".webp"}

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
        default=["html", "json", "md", "csv"],
        choices=["html", "json", "md", "csv"],
        help="File formats to export.",
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

    return parser.parse_args()


def main() -> None:
    args = parse_args()

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

    args.output_dir.mkdir(parents=True, exist_ok=True)
    reports: List[Dict[str, object]] = []

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
        reports.append(report)

    summary_path = args.output_dir / "summary.json"
    summary_path.write_text(json.dumps(reports, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"[INFO] Saved summary report to {summary_path}")


if __name__ == "__main__":
    main()
