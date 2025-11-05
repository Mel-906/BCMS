from pathlib import Path

import easyocr
from PIL import Image, ImageDraw, ImageFont

# 日本語と英語の文字認識モデルを読み込む
reader = easyocr.Reader(["en", "ja"])


def analyze_picture(target_path: str, output_path: str | None = None) -> None:
    """指定した画像に対して OCR を実行し、検出結果を描画して保存する。"""
    results = reader.readtext(target_path)
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

    target = Path(target_path)
    if output_path is None:
        output_path_path = target.with_name(f"{target.stem}_annotated.png")
    else:
        output_path_path = Path(output_path)
    output_path_path.parent.mkdir(parents=True, exist_ok=True)
    image.save(output_path_path)
    print(f"[INFO] Saved annotated image to {output_path_path}")


if __name__ == "__main__":
    analyze_picture("photo/IMG_4530.jpg")
    analyze_picture("photo/a.jpg")
    analyze_picture("photo/b.jpg")
    analyze_picture("photo/c.jpg")
    analyze_picture("photo/d.jpg")
    analyze_picture("photo/e.jpg")
    analyze_picture("photo/f.jpg")
