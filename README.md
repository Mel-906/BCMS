# YomiToku OCR Pipeline

名刺画像を YomiToku で解析し、Gemini API を用いて連絡先情報を CSV にまとめるツールです。

## セットアップ

```bash
uv sync
```

必要な主要パッケージ：
- yomitoku
- google-generativeai
- opencv-python-headless
- easyocr

### API キーの設定

`env.local` （リポジトリ同梱のテンプレート）をコピーし、Gemini API キーを設定してください。

```
GEMINI_API_KEY=your_api_key_here
```

## 画像前処理（推奨）

```bash
uv run python preprocess_images.py photo --output-dir photo_preprocessed
```

- EXIF 向き補正、短辺 720px 以上へのリサイズ
- カラーノイズ除去、CLAHE、アンシャープマスク、ガンマ補正

## OCR & サマリ生成

```bash
uv run python yomitoku.py photo_preprocessed \
  --output-dir yomitoku_results \
  --device auto
```

- per-image ファイルはデフォルトで出力しません（必要なら `--formats html json md csv` 等を指定）。
- `yomitoku_results/summary.csv` に各画像 1 行で「名前／職業／電話番号／e-mail／所属／所属Tel／所属住所／その他」を出力します。
- Gemini API が利用できない場合はエラーで停止します。`--disable-gemini` を指定するとヒューリスティック抽出に切り替え可能です。

## 簡易 EasyOCR

線画用のシンプルな検証には `ocr_local.py` を利用できます。

```bash
uv run ocr-local photo/IMG_4530.jpg --output-dir ocr_outputs
```

- 複数ファイル／ディレクトリに対応し、注釈付き PNG を出力します。
