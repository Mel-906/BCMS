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
import math
from pathlib import Path
from typing import Iterable, List, Tuple

import cv2
import numpy as np
from PIL import Image, ImageOps

SUPPORTED_EXTENSIONS = {".png", ".jpg", ".jpeg", ".bmp", ".tif", ".tiff", ".webp"}


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


def detect_card_region(image: np.ndarray) -> Tuple[np.ndarray, bool]:
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    blurred = cv2.GaussianBlur(gray, (5, 5), 0)
    edges = cv2.Canny(blurred, 50, 150)
    edges = cv2.dilate(edges, None, iterations=2)
    edges = cv2.erode(edges, None, iterations=1)

    contours, _ = cv2.findContours(edges, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        return image, False

    h, w = image.shape[:2]
    image_area = float(h * w)

    for contour in sorted(contours, key=cv2.contourArea, reverse=True):
        area = cv2.contourArea(contour)
        if area < image_area * 0.2:
            continue

        peri = cv2.arcLength(contour, True)
        approx = cv2.approxPolyDP(contour, 0.02 * peri, True)
        if len(approx) != 4:
            continue

        pts = approx.reshape(4, 2)
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

        dst = np.array([
            [0, 0],
            [width - 1, 0],
            [width - 1, height - 1],
            [0, height - 1],
        ], dtype="float32")

        matrix = cv2.getPerspectiveTransform(rect, dst)
        warped = cv2.warpPerspective(image, matrix, (width, height))
        return warped, True

    return image, False


def preprocess_image(
    path: Path,
    min_size: int,
) -> np.ndarray:
    pil_image = Image.open(path)
    pil_image = ImageOps.exif_transpose(pil_image)
    rgb = np.array(pil_image)
    image = cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR)

    image, cropped = detect_card_region(image)

    h, w = image.shape[:2]
    short_side = min(h, w)
    if short_side < min_size:
        scale = min_size / short_side
        new_w = math.ceil(w * scale)
        new_h = math.ceil(h * scale)
        image = cv2.resize(image, (new_w, new_h), interpolation=cv2.INTER_CUBIC)

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

    return image


def main() -> None:
    args = parse_args()
    image_paths = collect_image_paths(args.inputs)
    output_dir = args.output_dir.expanduser()
    if not args.dry_run:
        output_dir.mkdir(parents=True, exist_ok=True)

    for idx, path in enumerate(image_paths, start=1):
        print(f"[INFO] ({idx}/{len(image_paths)}) Processing {path}")
        if args.dry_run:
            continue
        processed = preprocess_image(path, args.min_size)
        destination = output_dir / path.name
        success = cv2.imwrite(str(destination), processed)
        if not success:
            raise RuntimeError(f"Failed to write preprocessed image: {destination}")
    print(f"[INFO] Completed preprocessing of {len(image_paths)} image(s). Output: {output_dir}")


if __name__ == "__main__":
    main()
