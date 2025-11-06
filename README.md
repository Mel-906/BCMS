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

## Supabase 連携によるデータ永続化

1. `.env.local` に Supabase プロジェクトの URL とキーを設定します。

   ```env
   SUPABASE_URL=https://xxxx.supabase.co
   SUPABASE_SERVICE_ROLE_KEY=...
   SUPABASE_SOURCE_BUCKET=source-images
   SUPABASE_PROCESSED_BUCKET=processed-images
   ```

2. 前処理から Supabase へアップロードします。

   ```bash
   uv run --env-file .env.local python preprocess_images.py photo \
     --output-dir photo_preprocessed \
     --record-to-db \
     --user-id <SUPABASE_USER_UUID>
   ```

   成功すると `photo_preprocessed/manifest.json` が生成され、Source / Processed テーブルにレコードが入ります。

3. OCR 解析結果も Supabase に書き込みます。

   ```bash
   uv run --env-file .env.local python yomitoku.py photo_preprocessed \
     --record-to-db \
     --manifest photo_preprocessed/manifest.json \
     --user-id <SUPABASE_USER_UUID>
   ```

   `yomitoku_results` と `yomitoku_result_fields` に JSON と正規化済みフィールドが保存されます。

## Web ダッシュボード (Next.js + Supabase)

`web/` ディレクトリには Supabase 上のデータを閲覧する最小構成の Next.js (App Router) アプリを格納しています。

```bash
cd web
cp .env.local.example .env.local  # Supabase の URL / キーを入力
npm install
npm run dev
```

- トップページ：プロジェクト一覧と最新サマリを表示。
- `/projects/[id]`：登録済みカード、解析結果、正規化フィールド、フル JSON を参照可能。

デモ環境では `SUPABASE_SERVICE_ROLE_KEY` をサーバーコンポーネントから使用しています。公開環境では RLS と認証ユーザーでのアクセス制御を構成してください。
