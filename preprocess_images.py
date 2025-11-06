#!/usr/bin/env python3
"""
Batch pre-processing utility for improving OCR input quality.

Applied steps:
 1. EXIF-aware orientation correction (via Pillow)
 2. Minimum resolution enforcement (short side >= 720 px)
 3. Color denoising (Fast Non-local Means)
 4. Local contrast enhancement (CLAHE on L channel)
 5. Unsharp masking
 6. Mild gamma correction

Usage:
    uv run python preprocess_images.py photo --output-dir photo_preprocessed
"""

from __future__ import annotations

import argparse
import json
import math
import sys
import uuid
from datetime import datetime
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Tuple

import cv2
import numpy as np
from PIL import Image, ImageOps
from pillow_heif import register_heif_opener

from supabase_utils import (
    SupabaseConfigError,
    SupabaseRepository,
    guess_content_type,
)

SUPPORTED_EXTENSIONS = {
    ".png",
    ".jpg",
    ".jpeg",
    ".bmp",
    ".tif",
    ".tiff",
    ".webp",
    ".heic",
    ".heif",
}

register_heif_opener()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
        description="Preprocess images (denoise, enhance contrast, upscale) for OCR.",
    )
    parser.add_argument(
        "inputs",
        nargs="+",
        help="Image files or directories to preprocess.",
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=Path("photo_preprocessed"),
        help="Destination directory for processed images.",
    )
    parser.add_argument(
        "--min-size",
        type=int,
        default=720,
        help="Minimum length (pixels) for the shorter side after resizing.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Do not write files; useful to verify which images would be processed.",
    )
    parser.add_argument(
        "--record-to-db",
        action="store_true",
        help="Upload original/processed images and metadata to Supabase.",
    )
    parser.add_argument(
        "--user-id",
        help="Supabase auth user UUID (required when --record-to-db is set).",
    )
    parser.add_argument(
        "--project-id",
        help="Existing project UUID to associate with this run.",
    )
    parser.add_argument(
        "--project-title",
        default=None,
        help="Project title when creating a new project.",
    )
    parser.add_argument(
        "--project-description",
        default=None,
        help="Optional description when creating a new project.",
    )
    parser.add_argument(
        "--manifest-path",
        type=Path,
        default=None,
        help="Path for the Supabase manifest JSON (defaults to <output-dir>/manifest.json).",
    )
    return parser.parse_args()


def collect_image_paths(inputs: Iterable[str]) -> List[Path]:
    collected = []
    seen = set()

    for target in inputs:
        path = Path(target).expanduser()
        if not path.exists():
            raise FileNotFoundError(f"Input path does not exist: {path}")

        if path.is_file():
            if path.suffix.lower() in SUPPORTED_EXTENSIONS:
                resolved = path.resolve()
                if resolved not in seen:
                    collected.append(resolved)
                    seen.add(resolved)
            continue

        for candidate in sorted(path.rglob("*")):
            if candidate.is_file() and candidate.suffix.lower() in SUPPORTED_EXTENSIONS:
                resolved = candidate.resolve()
                if resolved not in seen:
                    collected.append(resolved)
                    seen.add(resolved)

    if not collected:
        raise FileNotFoundError("No supported images were found.")
    return collected


def adjust_gamma(image: np.ndarray, gamma: float) -> np.ndarray:
    gamma = max(gamma, 1e-3)
    inv_gamma = 1.0 / gamma
    table = np.array([(i / 255.0) ** inv_gamma * 255 for i in np.arange(256)]).astype(
        "uint8"
    )
    return cv2.LUT(image, table)


def _order_points(pts: np.ndarray) -> np.ndarray:
    rect = np.zeros((4, 2), dtype="float32")
    s = pts.sum(axis=1)
    rect[0] = pts[np.argmin(s)]  # top-left
    rect[2] = pts[np.argmax(s)]  # bottom-right

    diff = np.diff(pts, axis=1)
    rect[1] = pts[np.argmin(diff)]  # top-right
    rect[3] = pts[np.argmax(diff)]  # bottom-left
    return rect


def detect_card_region(image: np.ndarray) -> Tuple[np.ndarray, Dict[str, object]]:
    lab = cv2.cvtColor(image, cv2.COLOR_BGR2LAB)
    l_channel = lab[:, :, 0]
    blurred = cv2.GaussianBlur(l_channel, (5, 5), 0)

    thresh = cv2.adaptiveThreshold(
        blurred,
        255,
        cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
        cv2.THRESH_BINARY_INV,
        99,
        5,
    )
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (9, 9))
    mask = cv2.morphologyEx(thresh, cv2.MORPH_CLOSE, kernel, iterations=2)

    edges = cv2.Canny(mask, 30, 120)
    edges = cv2.dilate(edges, None, iterations=2)

    contours, _ = cv2.findContours(edges, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        return image, {"cropped": False, "crop_method": None}

    h, w = image.shape[:2]
    image_area = float(h * w)
    min_area = image_area * 0.05

    for contour in sorted(contours, key=cv2.contourArea, reverse=True):
        area = cv2.contourArea(contour)
        if area < min_area:
            continue

        peri = cv2.arcLength(contour, True)
        approx = cv2.approxPolyDP(contour, 0.02 * peri, True)
        if len(approx) == 4:
            pts = approx.reshape(4, 2)
        else:
            rect_box = cv2.minAreaRect(contour)
            pts = cv2.boxPoints(rect_box)

        rect = _order_points(pts)

        (tl, tr, br, bl) = rect
        width_top = np.linalg.norm(tr - tl)
        width_bottom = np.linalg.norm(br - bl)
        height_left = np.linalg.norm(bl - tl)
        height_right = np.linalg.norm(br - tr)

        width = int(max(width_top, width_bottom))
        height = int(max(height_left, height_right))

        if width < 200 or height < 200:
            continue

        aspect = width / height if height != 0 else 0
        if aspect < 1.0:
            aspect = height / width
        if aspect < 1.1 or aspect > 3.5:
            continue

        dst = np.array([
            [0, 0],
            [width - 1, 0],
            [width - 1, height - 1],
            [0, height - 1],
        ], dtype="float32")

        matrix = cv2.getPerspectiveTransform(rect, dst)
        warped = cv2.warpPerspective(image, matrix, (width, height))
        return warped, {
            "cropped": True,
            "crop_method": "perspective",
        }

    # Fallback: crop the largest contour bounding box if perspective transform fails
    best = max(contours, key=cv2.contourArea)
    area = cv2.contourArea(best)
    if area >= min_area:
        x, y, bw, bh = cv2.boundingRect(best)
        cropped = image[y : y + bh, x : x + bw]
        if cropped.size > 0:
            return cropped, {
                "cropped": True,
                "crop_method": "bounding_rect",
            }

    return image, {"cropped": False, "crop_method": None}


def preprocess_image(
    path: Path,
    min_size: int,
) -> Tuple[np.ndarray, Dict[str, object]]:
    pil_image = Image.open(path)
    pil_image = ImageOps.exif_transpose(pil_image)
    rgb = np.array(pil_image)
    image = cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR)

    image, crop_info = detect_card_region(image)
    cropped = crop_info.get("cropped", False)

    h, w = image.shape[:2]
    original_shape = (int(h), int(w))
    short_side = min(h, w)
    scale_factor = 1.0
    if short_side < min_size:
        scale = min_size / short_side
        new_w = math.ceil(w * scale)
        new_h = math.ceil(h * scale)
        image = cv2.resize(image, (new_w, new_h), interpolation=cv2.INTER_CUBIC)
        scale_factor = scale

    image = cv2.fastNlMeansDenoisingColored(image, None, h=3, hColor=3, templateWindowSize=7, searchWindowSize=21)

    lab = cv2.cvtColor(image, cv2.COLOR_BGR2LAB)
    l_channel, a_channel, b_channel = cv2.split(lab)
    clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
    l_enhanced = clahe.apply(l_channel)
    lab_enhanced = cv2.merge((l_enhanced, a_channel, b_channel))
    image = cv2.cvtColor(lab_enhanced, cv2.COLOR_LAB2BGR)

    blurred = cv2.GaussianBlur(image, (0, 0), sigmaX=1.2, sigmaY=1.2)
    image = cv2.addWeighted(image, 1.5, blurred, -0.5, 0)

    image = adjust_gamma(image, 1.1)

    metadata = {
        "cropped": bool(cropped),
        "scale_factor": round(float(scale_factor), 4),
        "original_shape": list(original_shape),
        "final_shape": [int(image.shape[0]), int(image.shape[1])],
        "min_size": min_size,
        "crop_method": crop_info.get("crop_method"),
    }

    return image, metadata


def main() -> None:
    args = parse_args()
    if args.record_to_db and args.dry_run:
        print("[ERROR] --record-to-db cannot be used with --dry-run.", file=sys.stderr)
        sys.exit(1)

    image_paths = collect_image_paths(args.inputs)
    output_dir = args.output_dir.expanduser()
    if not args.dry_run:
        output_dir.mkdir(parents=True, exist_ok=True)

    repo: Optional[SupabaseRepository] = None
    project_id: Optional[str] = args.project_id
    manifest_entries: List[Dict[str, object]] = []
    manifest_path = args.manifest_path
    if manifest_path is None:
        manifest_path = output_dir / "manifest.json"

    if args.record_to_db:
        if not args.user_id:
            print("[ERROR] --user-id is required when --record-to-db is set.", file=sys.stderr)
            sys.exit(1)
        try:
            repo = SupabaseRepository()
        except SupabaseConfigError as exc:
            print(f"[ERROR] {exc}", file=sys.stderr)
            sys.exit(1)
        except Exception as exc:
            print(f"[ERROR] Failed to initialise Supabase client: {exc}", file=sys.stderr)
            sys.exit(1)

        project_title = args.project_title or datetime.utcnow().strftime("Project %Y-%m-%d %H:%M:%S")
        try:
            project_id = repo.ensure_project(
                project_id=project_id,
                user_id=args.user_id,
                title=project_title,
                description=args.project_description,
            )
        except Exception as exc:
            print(f"[ERROR] Failed to ensure project: {exc}", file=sys.stderr)
            sys.exit(1)
        print(f"[INFO] Recording assets under project {project_id}")

    for idx, path in enumerate(image_paths, start=1):
        print(f"[INFO] ({idx}/{len(image_paths)}) Processing {path}")
        if args.dry_run:
            continue
        processed, process_info = preprocess_image(path, args.min_size)
        destination = output_dir / path.name
        success = cv2.imwrite(str(destination), processed)
        if not success:
            raise RuntimeError(f"Failed to write preprocessed image: {destination}")

        if repo and project_id:
            unique_token = uuid.uuid4().hex[:8]
            safe_suffix = path.suffix.lower() or ".jpg"
            safe_base = f"{path.stem}-{unique_token}{safe_suffix}"

            width: Optional[int] = None
            height: Optional[int] = None
            fmt: Optional[str] = None
            captured_at: Optional[datetime] = None
            try:
                with Image.open(path) as im:
                    fmt = im.format
                    width, height = im.size
                    exif = im.getexif()
                    if exif:
                        dt_raw = exif.get(36867) or exif.get(306)
                        if isinstance(dt_raw, str):
                            try:
                                captured_at = datetime.strptime(dt_raw, "%Y:%m:%d %H:%M:%S")
                            except ValueError:
                                captured_at = None
            except Exception as exc:
                print(f"[WARN] Failed to read EXIF metadata for {path}: {exc}", file=sys.stderr)

            try:
                original_bytes = path.read_bytes()
                source_key = f"{project_id}/original/{safe_base}"
                source_storage_path = repo.upload_source_file(
                    path=source_key,
                    content=original_bytes,
                    content_type=guess_content_type(path),
                )
            except Exception as exc:
                print(f"[ERROR] Failed to upload original image to Supabase: {exc}", file=sys.stderr)
                sys.exit(1)

            try:
                source_record = repo.upsert_source_image(
                    project_id=project_id,
                    user_id=args.user_id,
                    storage_path=source_storage_path,
                    original_filename=path.name,
                    width=width,
                    height=height,
                    fmt=fmt,
                    captured_at=captured_at,
                    metadata={"local_path": str(path)},
                )
            except Exception as exc:
                print(f"[ERROR] Failed to record source image metadata: {exc}", file=sys.stderr)
                sys.exit(1)

            try:
                processed_bytes = destination.read_bytes()
                processed_key = f"{project_id}/processed/{safe_base}"
                processed_storage_path = repo.upload_processed_file(
                    path=processed_key,
                    content=processed_bytes,
                    content_type=guess_content_type(destination),
                )
            except Exception as exc:
                print(f"[ERROR] Failed to upload processed image to Supabase: {exc}", file=sys.stderr)
                sys.exit(1)

            try:
                processed_record = repo.upsert_processed_image(
                    project_id=project_id,
                    user_id=args.user_id,
                    source_image_id=source_record["id"],
                    storage_path=processed_storage_path,
                    variant="preprocessed",
                    params=process_info,
                )
            except Exception as exc:
                print(f"[ERROR] Failed to record processed image metadata: {exc}", file=sys.stderr)
                sys.exit(1)

            manifest_entries.append(
                {
                    "source_path": str(path),
                    "processed_path": str(destination),
                    "source_storage_path": source_record["storage_path"],
                    "processed_storage_path": processed_record["storage_path"],
                    "source_image_id": source_record["id"],
                    "processed_image_id": processed_record["id"],
                }
            )

    print(f"[INFO] Completed preprocessing of {len(image_paths)} image(s). Output: {output_dir}")

    if repo and project_id and manifest_entries:
        manifest_payload = {
            "project_id": project_id,
            "user_id": args.user_id,
            "generated_at": datetime.utcnow().isoformat(),
            "entries": manifest_entries,
        }
        try:
            manifest_path.parent.mkdir(parents=True, exist_ok=True)
            manifest_path.write_text(json.dumps(manifest_payload, ensure_ascii=False, indent=2), encoding="utf-8")
            print(f"[INFO] Wrote Supabase manifest to {manifest_path}")
        except Exception as exc:
            print(f"[WARN] Failed to write manifest file {manifest_path}: {exc}", file=sys.stderr)


if __name__ == "__main__":
    main()
