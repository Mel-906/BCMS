from pathlib import Path

import easyocr
from PIL import Image, ImageDraw, ImageFont

# 日本語と英語の文字認識モデルを読み込む
reader = easyocr.Reader(["en", "ja"])


def analyze_picture(target_path: Path, output_path: Path | None = None) -> None:
    """指定した画像に対して OCR を実行し、検出結果を描画して保存する。"""
    results = reader.readtext(str(target_path))
    image = Image.open(target_path).convert("RGB")
    draw = ImageDraw.Draw(image)

    try:
        font = ImageFont.truetype("DejaVuSans-Bold.ttf", size=24)
    except OSError:
        font = ImageFont.load_default()

    for bbox, text, confidence in results:
        # bbox: [[x1, y1], [x2, y2], [x3, y3], [x4, y4]]
        points = [(int(x), int(y)) for x, y in bbox]
        draw.line(points + [points[0]], fill=(255, 0, 0), width=2)

        label = f"{text} ({confidence:.2f})"
        text_position = (points[0][0], max(points[0][1] - 25, 0))
        draw.rectangle(
            [
                text_position,
                (text_position[0] + draw.textlength(label, font=font) + 8, text_position[1] + 24),
            ],
            fill=(255, 255, 0, 128),
        )
        draw.text((text_position[0] + 4, text_position[1]), label, fill=(0, 0, 0), font=font)

        print({"bbox": points, "text": text, "confidence": confidence})

    if output_path is None:
        output_path_path = target_path.with_name(f"{target_path.stem}_annotated.png")
    else:
        output_path_path = output_path
    output_path_path.parent.mkdir(parents=True, exist_ok=True)
    image.save(output_path_path)
    print(f"[INFO] Saved annotated image to {output_path_path}")


def collect_images(inputs: list[str]) -> list[Path]:
    image_paths: list[Path] = []
    seen: set[Path] = set()
    supported = {".png", ".jpg", ".jpeg", ".bmp", ".tif", ".tiff", ".webp"}

    for raw in inputs:
        path = Path(raw).expanduser()
        if path.is_file() and path.suffix.lower() in supported:
            resolved = path.resolve()
            if resolved not in seen:
                seen.add(resolved)
                image_paths.append(resolved)
            continue

        if path.is_dir():
            for candidate in sorted(path.rglob("*")):
                if candidate.is_file() and candidate.suffix.lower() in supported:
                    resolved = candidate.resolve()
                    if resolved not in seen:
                        seen.add(resolved)
                        image_paths.append(resolved)
            continue

        raise FileNotFoundError(f"Input path not found or unsupported: {path}")

    if not image_paths:
        raise FileNotFoundError("No supported images were found in the provided inputs.")

    return image_paths


def main(argv: list[str] | None = None) -> None:
    import argparse

    parser = argparse.ArgumentParser(description="Run EasyOCR on images and save annotated copies.")
    parser.add_argument("inputs", nargs="+", help="Image files or directories to process.")
    parser.add_argument(
        "--output-dir",
        type=Path,
        help="Destination directory for annotated output files.",
    )

    args = parser.parse_args(argv)

    output_root: Path | None = args.output_dir
    if output_root is not None:
        output_root = output_root.expanduser().resolve()
        output_root.mkdir(parents=True, exist_ok=True)

    for image_path in collect_images(args.inputs):
        if output_root is not None:
            output_path = output_root / f"{image_path.stem}_annotated.png"
        else:
            output_path = image_path.with_name(f"{image_path.stem}_annotated.png")
        analyze_picture(image_path, output_path)


if __name__ == "__main__":
    main()
