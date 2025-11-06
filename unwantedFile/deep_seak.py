#!/usr/bin/env python3
"""
DeepSeek-OCR validation runner tuned for Intel Arc (XPU) and CPU fallback.

Loads the official DeepSeek-OCR model from Hugging Face and performs inference
on one or more images using the evaluation pipeline provided by the model's
custom `infer` method. CUDA is not required; CUDA-only code paths are patched
so they execute on the requested device.
"""

from __future__ import annotations

import argparse
import contextlib
import json
import os
from functools import lru_cache
from pathlib import Path
from typing import Iterable, Iterator, List, Tuple

import easyocr
import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont, ImageOps
import torch
from transformers import (
    AutoModel,
    AutoTokenizer,
    AutoProcessor,
    VisionEncoderDecoderModel,
    TrOCRProcessor,
)


SUPPORTED_EXTENSIONS = {".png", ".jpg", ".jpeg", ".bmp", ".tif", ".tiff", ".webp"}


def choose_device(preferred: str) -> torch.device:
    preferred = preferred.lower()
    if preferred == "cpu":
        return torch.device("cpu")
    if preferred == "xpu":
        if hasattr(torch, "xpu") and torch.xpu.is_available():
            return torch.device("xpu")
        print("[WARN] XPU requested but unavailable; falling back to CPU.")
        return torch.device("cpu")
    if preferred == "cuda":
        if torch.cuda.is_available():
            return torch.device("cuda")
        raise RuntimeError("Requested CUDA, but no CUDA device is available.")

    # auto
    if hasattr(torch, "xpu") and torch.xpu.is_available():
        return torch.device("xpu")
    if torch.cuda.is_available():
        return torch.device("cuda")
    return torch.device("cpu")


@contextlib.contextmanager
def redirect_cuda_calls(target_device: torch.device):
    """
    DeepSeek-OCR's reference implementation hardcodes CUDA-specific calls.
    This context temporarily redirects `.cuda()` invocations and CUDA autocast
    to the requested device so we can run on Intel Arc or CPU.
    """
    if target_device.type == "cuda":
        yield
        return

    tensor_cuda = torch.Tensor.cuda
    module_cuda = torch.nn.Module.cuda
    original_autocast = torch.autocast
    cuda_is_available = torch.cuda.is_available
    tensor_to = torch.Tensor.to
    module_to = torch.nn.Module.to

    def tensor_cuda_patch(self, device=None, non_blocking=False, **kwargs):
        return self.to(target_device, non_blocking=non_blocking)

    def module_cuda_patch(self, device=None):
        return self.to(target_device)

    def autocast_patch(device_type, *args, **kwargs):
        if device_type == "cuda":
            return contextlib.nullcontext()
        return original_autocast(device_type, *args, **kwargs)

    def tensor_to_patch(self, *args, **kwargs):
        dtype_index = None
        dtype_value = None
        if args:
            if isinstance(args[0], torch.dtype):
                dtype_index = 0
                dtype_value = args[0]
            elif len(args) >= 2 and isinstance(args[1], torch.dtype):
                dtype_index = 1
                dtype_value = args[1]
        if dtype_index is None and "dtype" in kwargs:
            dtype_index = -1  # use kwargs
            dtype_value = kwargs.get("dtype")

        if target_device.type != "cuda" and dtype_value is torch.bfloat16:
            if dtype_index == 0:
                args = (torch.float32,) + args[1:]
            elif dtype_index == 1:
                args = args[:1] + (torch.float32,) + args[2:]
            elif dtype_index == -1:
                kwargs["dtype"] = torch.float32

        return tensor_to(self, *args, **kwargs)

    def module_to_patch(self, *args, **kwargs):
        dtype_index = None
        dtype_value = None
        if args:
            if isinstance(args[0], torch.dtype):
                dtype_index = 0
                dtype_value = args[0]
            elif len(args) >= 2 and isinstance(args[1], torch.dtype):
                dtype_index = 1
                dtype_value = args[1]
        if dtype_index is None and "dtype" in kwargs:
            dtype_index = -1
            dtype_value = kwargs.get("dtype")

        if target_device.type != "cuda" and dtype_value is torch.bfloat16:
            if dtype_index == 0:
                args = (torch.float32,) + args[1:]
            elif dtype_index == 1:
                args = args[:1] + (torch.float32,) + args[2:]
            elif dtype_index == -1:
                kwargs["dtype"] = torch.float32

        return module_to(self, *args, **kwargs)

    torch.Tensor.cuda = tensor_cuda_patch  # type: ignore[assignment]
    torch.nn.Module.cuda = module_cuda_patch  # type: ignore[assignment]
    torch.Tensor.to = tensor_to_patch  # type: ignore[assignment]
    torch.nn.Module.to = module_to_patch  # type: ignore[assignment]
    torch.autocast = autocast_patch  # type: ignore[assignment]
    torch.cuda.is_available = lambda: target_device.type == "cuda"  # type: ignore[assignment]

    try:
        yield
    finally:
        torch.Tensor.cuda = tensor_cuda  # type: ignore[assignment]
        torch.nn.Module.cuda = module_cuda  # type: ignore[assignment]
        torch.Tensor.to = tensor_to  # type: ignore[assignment]
        torch.nn.Module.to = module_to  # type: ignore[assignment]
        torch.autocast = original_autocast  # type: ignore[assignment]
        torch.cuda.is_available = cuda_is_available  # type: ignore[assignment]


@lru_cache(maxsize=1)
def get_easyocr_reader() -> easyocr.Reader:
    # GPU is not used on this environment; fallback to CPU.
    return easyocr.Reader(["en", "ja"], gpu=False)


_recognizer_cache: dict[Tuple[str, str], Tuple[object, object, VisionEncoderDecoderModel]] = {}


def get_stronger_recognizer(
    model_name: str, device: torch.device
) -> Tuple[object, object, VisionEncoderDecoderModel]:
    key = (model_name, device.type)
    if key not in _recognizer_cache:
        with redirect_cuda_calls(device):
            processor = None
            tokenizer = None
            image_processor = None

            try:
                processor = AutoProcessor.from_pretrained(model_name)
                image_processor = getattr(processor, "image_processor", None)
                tokenizer = getattr(processor, "tokenizer", None)
            except Exception:
                processor = None

            if image_processor is None or tokenizer is None:
                try:
                    trocr_processor = TrOCRProcessor.from_pretrained(model_name)
                    image_processor = getattr(
                        trocr_processor, "image_processor", getattr(trocr_processor, "feature_extractor", None)
                    )
                    tokenizer = getattr(trocr_processor, "tokenizer", None)
                except Exception:
                    pass

            if image_processor is None or tokenizer is None:
                raise ValueError(f"Recognizer {model_name} does not provide compatible image processor/tokenizer.")

            model = VisionEncoderDecoderModel.from_pretrained(model_name)
            model = model.to(device)
            model.eval()
        _recognizer_cache[key] = (image_processor, tokenizer, model)
    return _recognizer_cache[key]


def annotate_with_easyocr(
    detection_image_path: Path,
    recognition_image_path: Path,
    output_dir: Path,
    recognizer_model: str | None,
    device: torch.device,
) -> Tuple[List[dict], Path]:
    reader = get_easyocr_reader()
    results = reader.readtext(str(detection_image_path))

    overlay_base = ImageOps.exif_transpose(Image.open(recognition_image_path)).convert("RGB")
    overlay = Image.new("RGBA", overlay_base.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay_base)
    overlay_draw = ImageDraw.Draw(overlay)

    try:
        font = ImageFont.truetype("DejaVuSans-Bold.ttf", size=24)
    except OSError:
        font = ImageFont.load_default()

    image_processor = None
    tokenizer = None
    recognizer: VisionEncoderDecoderModel | None = None
    if recognizer_model:
        image_processor, tokenizer, recognizer = get_stronger_recognizer(recognizer_model, device)

    detections: List[dict] = []
    for bbox, text, confidence in results:
        points = [(int(x), int(y)) for x, y in bbox]
        draw.line(points + [points[0]], fill=(255, 0, 0), width=2)

        alternate_text = None
        if image_processor and tokenizer and recognizer:
            x_coords = [p[0] for p in points]
            y_coords = [p[1] for p in points]
            margin = 4
            left = max(min(x_coords) - margin, 0)
            top = max(min(y_coords) - margin, 0)
            right = min(max(x_coords) + margin, overlay_base.width)
            bottom = min(max(y_coords) + margin, overlay_base.height)
            crop = overlay_base.crop((left, top, right, bottom))

            image_inputs = image_processor(crop, return_tensors="pt")
            if isinstance(image_inputs, dict):
                pixel_values = image_inputs["pixel_values"]
            else:
                pixel_values = image_inputs.pixel_values
            pixel_values = pixel_values.to(next(recognizer.parameters()).device)

            decoder_start = recognizer.config.decoder_start_token_id or recognizer.config.bos_token_id or 0
            decoder_input_ids = torch.tensor(
                [[decoder_start]],
                dtype=torch.long,
                device=pixel_values.device,
            )
            generated_ids = recognizer.generate(
                pixel_values=pixel_values,
                decoder_input_ids=decoder_input_ids,
                max_length=128,
            )
            alternate_text = tokenizer.batch_decode(generated_ids, skip_special_tokens=True)[0].strip()
            if not alternate_text:
                alternate_text = None

        display_text = alternate_text or text
        label = f"{display_text} ({confidence:.2f})"
        text_x = points[0][0]
        text_y = max(points[0][1] - 28, 0)

        text_bbox = overlay_draw.textbbox((text_x, text_y), label, font=font)
        expanded = (
            text_bbox[0] - 4,
            text_bbox[1] - 2,
            text_bbox[2] + 4,
            text_bbox[3] + 2,
        )
        overlay_draw.rectangle(expanded, fill=(0, 0, 0, 160))
        overlay_draw.text((text_x, text_y), label, font=font, fill=(255, 255, 255, 255))

        detections.append(
            {
                "bbox": points,
                "text": text,
                "confidence": float(confidence),
                "alternate_text": alternate_text,
            }
        )

    annotated = Image.alpha_composite(overlay_base.convert("RGBA"), overlay)

    output_dir.mkdir(parents=True, exist_ok=True)
    overlay_path = output_dir / "easyocr_overlay.png"
    annotated.convert("RGB").save(overlay_path)
    return detections, overlay_path


def otsu_threshold(gray: np.ndarray) -> int:
    hist, _ = np.histogram(gray, bins=256, range=(0, 256))
    total = gray.size
    sum_total = np.dot(hist, np.arange(256))
    sum_background = 0.0
    weight_background = 0.0
    max_variance = -1.0
    threshold = 0

    for t in range(256):
        weight_background += hist[t]
        if weight_background == 0:
            continue
        weight_foreground = total - weight_background
        if weight_foreground == 0:
            break
        sum_background += t * hist[t]
        mean_background = sum_background / weight_background
        mean_foreground = (sum_total - sum_background) / weight_foreground
        variance_between = weight_background * weight_foreground * (mean_background - mean_foreground) ** 2
        if variance_between > max_variance:
            max_variance = variance_between
            threshold = t
    return threshold


def binarize_image(image_path: Path, output_dir: Path, gray_image: Image.Image | None = None) -> Tuple[Path, int]:
    if gray_image is None:
        image = Image.open(image_path).convert("L")
        gray_image = ImageOps.autocontrast(image)
    gray = np.array(gray_image)
    threshold = otsu_threshold(gray)
    binary = (gray > threshold).astype(np.uint8) * 255
    binary_image = Image.fromarray(binary, mode="L").convert("RGB")

    output_dir.mkdir(parents=True, exist_ok=True)
    binarized_path = output_dir / f"{image_path.stem}_binarized.png"
    binary_image.save(binarized_path)
    return binarized_path, threshold


def preprocess_image(image_path: Path, output_dir: Path) -> Tuple[Path, Path]:
    image = Image.open(image_path)
    image = ImageOps.exif_transpose(image)
    image = image.convert("L")

    # Contrast enhancement
    image = ImageOps.autocontrast(image)

    # Noise reduction
    image = image.filter(ImageFilter.MedianFilter(size=3))
    image = image.filter(ImageFilter.GaussianBlur(radius=0.5))

    # Sharpen text edges
    image = image.filter(ImageFilter.UnsharpMask(radius=1.5, percent=175, threshold=3))

    preprocessed_gray = image
    preprocessed_rgb = Image.merge("RGB", [preprocessed_gray] * 3)

    output_dir.mkdir(parents=True, exist_ok=True)
    preprocessed_path = output_dir / f"{image_path.stem}_preprocessed.png"
    preprocessed_rgb.save(preprocessed_path)

    return preprocessed_path, preprocessed_gray


def iter_image_paths(inputs: Iterable[str]) -> Iterator[Path]:
    for input_path in inputs:
        path = Path(input_path).expanduser()
        if path.is_dir():
            for candidate in sorted(path.rglob("*")):
                if candidate.is_file() and candidate.suffix.lower() in SUPPORTED_EXTENSIONS:
                    yield candidate
        elif path.is_file() and path.suffix.lower() in SUPPORTED_EXTENSIONS:
            yield path
        else:
            raise FileNotFoundError(f"Unsupported path or file extension: {path}")


def load_model_and_tokenizer(
    model_name: str,
    device: torch.device,
    load_in_4bit: bool = False,
) -> tuple[torch.nn.Module, AutoTokenizer]:
    """
    Load the DeepSeek-OCR model with remote code enabled.
    """
    dtype = torch.bfloat16 if device.type in {"cuda", "xpu"} else torch.float32
    model_kwargs = {
        "trust_remote_code": True,
        "torch_dtype": dtype,
        "_attn_implementation": "eager",
    }
    if load_in_4bit:
        try:
            from transformers import BitsAndBytesConfig

            model_kwargs["quantization_config"] = BitsAndBytesConfig(load_in_4bit=True, bnb_4bit_use_double_quant=True)
            model_kwargs.pop("torch_dtype", None)
        except ImportError as exc:
            raise RuntimeError("4bit quantization requested but bitsandbytes is not installed.") from exc

    tokenizer = AutoTokenizer.from_pretrained(model_name, trust_remote_code=True)
    with redirect_cuda_calls(device):
        model = AutoModel.from_pretrained(model_name, **model_kwargs)
        model = model.to(device)
        model.eval()
        if device.type == "xpu":
            try:
                import intel_extension_for_pytorch as ipex  # type: ignore

                model = ipex.optimize(model, dtype=dtype, inplace=True)
            except ImportError:
                pass
    return model, tokenizer


def run_inference(
    model,
    tokenizer,
    image_path: Path,
    output_dir: Path,
    prompt: str,
    device: torch.device,
    base_size: int,
    image_size: int,
    crop_mode: bool,
    test_compress: bool,
    save_results: bool,
) -> str:
    """
    Execute DeepSeek-OCR's `infer` while routing CUDA calls to the specified device.
    """
    output_dir.mkdir(parents=True, exist_ok=True)
    with redirect_cuda_calls(device):
        result = model.infer(
            tokenizer,
            prompt=prompt,
            image_file=str(image_path),
            output_path=str(output_dir),
            base_size=base_size,
            image_size=image_size,
            crop_mode=crop_mode,
            test_compress=test_compress,
            save_results=save_results,
            eval_mode=True,
    )
    return result


def select_resolution(
    image_path: Path,
    preferred_base: int,
    preferred_image: int,
    preferred_crop: bool,
    auto_resolution: bool,
) -> Tuple[int, int, bool]:
    if not auto_resolution:
        return preferred_base, preferred_image, preferred_crop

    with Image.open(image_path) as img:
        width, height = img.size
    max_dim = max(width, height)

    if max_dim <= 900:
        return 640, 512, False
    if max_dim <= 1600:
        return 1024, 640, True
    return 1280, 1024, True


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Run DeepSeek-OCR validation model on business or document images without CUDA."
    )
    parser.add_argument("inputs", nargs="+", help="Image files or directories to process.")
    parser.add_argument("--model-name", default="deepseek-ai/DeepSeek-OCR", help="Hugging Face model ID to load.")
    parser.add_argument(
        "--device", default="auto", choices=["auto", "cpu", "xpu", "cuda"], help="Device to run inference on."
    )
    parser.add_argument(
        "--prompt",
        default="<image>\nExtract all fields from this business card and return structured JSON.",
        help="Prompt passed to DeepSeek-OCR. Use '\\n' for newlines.",
    )
    parser.add_argument(
        "--base-size",
        type=int,
        default=1024,
        help="Base (global view) resolution. Refer to DeepSeek-OCR docs for alternatives.",
    )
    parser.add_argument(
        "--image-size",
        type=int,
        default=640,
        help="Local crop resolution. Refer to DeepSeek-OCR docs for optimal values.",
    )
    parser.add_argument(
        "--disable-crop",
        action="store_true",
        help="Disable cropping mode (set crop_mode=False) for faster but potentially less accurate inference.",
    )
    parser.add_argument(
        "--test-compress",
        action="store_true",
        help="Enable compression statistics output from DeepSeek-OCR.",
    )
    parser.add_argument(
        "--disable-deepseek-save",
        action="store_false",
        dest="save_results",
        help="Skip DeepSeek-OCR internal asset saving (result.mmd, result_with_boxes.jpg).",
    )
    parser.set_defaults(save_results=True)
    parser.add_argument(
        "--results-jsonl",
        type=Path,
        help="Optional path to save inference results as JSONL. Existing file will be overwritten.",
    )
    parser.add_argument(
        "--work-dir",
        type=Path,
        default=Path("deepseek_outputs"),
        help="Base directory where per-image outputs (and saved assets) will be written.",
    )
    parser.add_argument(
        "--load-in-4bit",
        action="store_true",
        help="Load model with 4-bit quantization (requires bitsandbytes). Useful for limited VRAM/RAM.",
    )
    parser.add_argument(
        "--recognizer-model",
        default="microsoft/trocr-large-printed",
        help="Optional secondary recognizer for refining EasyOCR text. Set to 'none' to disable.",
    )
    parser.add_argument(
        "--no-auto-resolution",
        dest="auto_resolution",
        action="store_false",
        help="Disable automatic base/image size heuristics based on image resolution.",
    )
    parser.set_defaults(auto_resolution=True)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")
    os.environ.setdefault("PYTORCH_ENABLE_XPU_FALLBACK", "1")

    device = choose_device(args.device)
    print(f"[INFO] Using device: {device}")

    model, tokenizer = load_model_and_tokenizer(args.model_name, device, load_in_4bit=args.load_in_4bit)

    recognizer_model = None
    if args.recognizer_model and args.recognizer_model.lower() != "none":
        recognizer_model = args.recognizer_model

    results: List[dict] = []
    for image_path in iter_image_paths(args.inputs):
        per_image_dir = args.work_dir / image_path.stem
        per_image_dir.mkdir(parents=True, exist_ok=True)

        preprocessed_path, preprocessed_gray = preprocess_image(image_path, per_image_dir)
        binarized_path, threshold = binarize_image(preprocessed_path, per_image_dir, preprocessed_gray)

        base_pref_crop = not args.disable_crop
        effective_base, effective_image, effective_crop = select_resolution(
            image_path, args.base_size, args.image_size, base_pref_crop, args.auto_resolution
        )
        print(
            "[INFO] Running DeepSeek-OCR on "
            f"{image_path} (preprocessed -> {preprocessed_path}, binarized -> {binarized_path}, "
            f"threshold={threshold}, base_size={effective_base}, image_size={effective_image}, crop_mode={effective_crop})"
        )
        text = run_inference(
            model=model,
            tokenizer=tokenizer,
            image_path=binarized_path,
            output_dir=per_image_dir,
            prompt=args.prompt,
            device=device,
            base_size=effective_base,
            image_size=effective_image,
            crop_mode=effective_crop,
            test_compress=args.test_compress,
            save_results=args.save_results,
        )
        text_path = per_image_dir / "deepseek_output.md"
        text_path.write_text(text, encoding="utf-8")

        detections, overlay_path = annotate_with_easyocr(
            binarized_path, image_path, per_image_dir, recognizer_model, device
        )
        detections_path = per_image_dir / "easyocr_detections.json"
        detections_path.write_text(json.dumps(detections, ensure_ascii=False, indent=2), encoding="utf-8")

        record = {
            "image": str(image_path),
            "preprocessed_image": str(preprocessed_path),
            "binarized_image": str(binarized_path),
            "binarization_threshold": threshold,
            "base_size": effective_base,
            "image_size": effective_image,
            "crop_mode": effective_crop,
            "output_dir": str(per_image_dir),
            "prompt": args.prompt,
            "result": text,
            "deepseek_output_path": str(text_path),
            "easyocr_overlay_path": str(overlay_path),
            "easyocr_detections_path": str(detections_path),
        }
        if recognizer_model:
            record["recognizer_model"] = recognizer_model
        record["easyocr_detections"] = detections
        results.append(record)
        print(json.dumps(record, ensure_ascii=False, indent=2))

    if args.results_jsonl:
        args.results_jsonl.parent.mkdir(parents=True, exist_ok=True)
        with args.results_jsonl.open("w", encoding="utf-8") as fp:
            for record in results:
                fp.write(json.dumps(record, ensure_ascii=False) + "\n")
        print(f"[INFO] Saved JSONL results to {args.results_jsonl}")


if __name__ == "__main__":
    main()
