# BCMS OCR Pipeline

Intel Arc (XPU) / CPU 両対応の OCR ツールです。画像からテキストを TrOCR で読み取り、名刺に記載された情報を一貫した JSONL 形式に整形して出力します。

## セットアップ（uv 利用）

```bash
uv sync
```

Intel Arc を利用する場合は、以下のように Intel 提供のホイールを追加インデックスから取得してください。

```bash
uv pip install \
  --index-url https://pytorch-extension.intel.com/release-whl/stable/xpu/us/ \
  torch intel-extension-for-pytorch
```

## 使い方

```bash
uv run ocr-local path/to/images --device auto --jsonl-output results.jsonl
```

`--model-name` オプションで手書き向けモデル（例: `microsoft/trocr-base-handwritten`）に切り替えられます。抽出結果は `company`/`person`/`title`/`phone_numbers`/`email_addresses` など名刺で頻出するフィールドに整理されます。

## DeepSeek OCR Runner

```bash
uv run python deep_seak.py photo/d.jpg --device auto --work-dir outputs_deepseek
```

- `--recognizer-model` に `microsoft/trocr-large-printed`（既定値）などを指定すると EasyOCR の予測を高精度モデルで補正し、句読点を含むテキストを強化できます。不要な場合は `--recognizer-model none` を指定してください。
- `--base-size`/`--image-size`/`--disable-crop` と `--no-auto-resolution` で DeepSeek-OCR の解像度や分割挙動を調整できます。
