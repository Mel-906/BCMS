# BCMS – Business Card Management Suite

名刺画像を自動で前処理し、YomiToku + Gemini を用いた OCR／要約結果を Supabase に保存、Next.js ダッシュボードで閲覧できる統合ワークフローです。ローカル PC での展示運用を想定しつつ、クラウド連携もサポートしています。

---

## 構成概要

| レイヤー | 技術 | 主な役割 |
| --- | --- | --- |
| フロントエンド | Next.js 16 (App Router) + Supabase JS | 名刺一覧・検索・詳細表示、プロジェクト管理、スキャン UI（ファイル選択／カメラ撮影／HEIC 対応） |
| バックエンド | Next.js API Route (`/api/cards/scan`) | アップロード受付、Python スクリプトによる前処理／OCR のワーカージョブ実行 |
| データパイプライン | Python (`preprocess_images.py`, `yomitoku.py`) | 画像補正・フォーマット変換、YomiToku OCR、Gemini によるフィールド抽出、Supabase 永続化 |
| ストレージ／DB | Supabase Storage + Postgres | 原本・前処理済み画像、OCR 結果、プロジェクト・カード情報 |

---

## セットアップ手順

### 1. Python 環境

1. 依存インストール（`uv` 推奨）:
   ```bash
   uv sync
   ```
2. 主要ライブラリ: `yomitoku`, `google-generativeai`, `opencv-python-headless`, `pillow-heif`, `easyocr`, ほか。
3. 初回のみ Gemini API キーを設定:
   ```bash
   cp .env.local .env.local.sample  # 既存テンプレートを確認
   # .env.local に GEMINI_API_KEY および Supabase キーを設定
   ```

### 2. Web アプリ

```bash
cd web
cp .env.local.example .env.local  # Supabase URL/Anon/SERVICE_ROLE/PYTHON_BIN などを設定
npm install
npm run dev
```

- `PYTHON_BIN` を指定すると `/api/cards/scan` から Python 仮想環境を確実に呼び出せます（未設定の場合は `.venv/bin/python` → `python3` 順で探索）。
- Next.js 実行中はローカルで `http://localhost:3000` にアクセスします。

---

## Supabase 設定

`.env.local`（Python 側）・`web/.env.local`（Next.js 側）に以下を揃えてください。

```env
SUPABASE_URL=https://xxxx.supabase.co
SUPABASE_SERVICE_ROLE_KEY=service-role-key
SUPABASE_SOURCE_BUCKET=source-images
SUPABASE_PROCESSED_BUCKET=processed-images
```

- SERVICE ROLE KEY はサーバーサイド専用です。クライアントからは `NEXT_PUBLIC_SUPABASE_URL` と `NEXT_PUBLIC_SUPABASE_ANON_KEY` のみを公開します。
- 架空ユーザーでのテストには Supabase Auth の UUID を `--user-id` やアップロード時に付与してください。

---

## Python ツールの使い方

### 1. 画像前処理（HEIC / HEIF を含む）

```bash
uv run python preprocess_images.py photo \
  --output-dir photo_preprocessed \
  --record-to-db \
  --user-id <Supabase User UUID> \
  --project-id <既存プロジェクトID>
```

- `pillow-heif` により `.heic / .heif` を自動で読み込み可能。
- 処理内容: EXIF 向き補正、短辺 720px 以上へのアップスケール、ノイズ除去、CLAHE、アンシャープマスク、ガンマ補正。
- `--record-to-db` オプションで原本／補正画像やメタデータを Supabase に保存。Manifest (`manifest.json`) も出力されます。

### 2. OCR & 要約

```bash
uv run python yomitoku.py photo_preprocessed \
  --record-to-db \
  --manifest photo_preprocessed/manifest.json \
  --user-id <Supabase User UUID> \
  --project-id <既存プロジェクトID>
```

- YomiToku の解析結果を Gemini API で整形し、`yomitoku_results/summary.csv` を作成。
- Supabase には `yomitoku_results` と `yomitoku_result_fields` が保存され、Web ダッシュボードから閲覧可能。
- `--disable-gemini` で Gemini 不使用モードに切り替え可能。

### 3. 簡易 EasyOCR（検証用）

```bash
uv run ocr-local photo/IMG_0001.jpg --output-dir ocr_outputs
```

---

## Web ダッシュボード機能 (Next.js)

| 画面 | 機能概要 |
| --- | --- |
| `/` Dashboard | 名刺一覧（検索/並び替え/ページネーション）、各カードのプロジェクト・解析状況を表示。カードをクリックで詳細へ遷移。 |
| `/cards/[id]` | 原本・前処理済み画像、抽出された連絡先フィールド、Gemini 生テキストを確認。 |
| `/scan` | 複数ファイル一括アップロード、削除、カメラ撮影対応。撮影画像は縦向き補正＋明るさ調整後にプレビュー表示されます。HEIC もブラウザ内で JPEG に変換して取り込めます。 |
| `/projects` | プロジェクトの新規作成／削除（確認ダイアログ付き）、右カラムで詳細・カード一覧を表示。 |

### スキャンフロー

1. ファイル選択または「カメラで撮影」から名刺を追加（HEIC も可）。
2. 画面下部にプレビューカードが表示され、不要なものは「削除」で除去。
3. 「解析キューに送信」で `/api/cards/scan` に POST → Python スクリプトがバックグラウンド実行。
4. Supabase への書き込みが完了次第、Dashboard に反映されます（リロードまたは検索し直すと確認可能）。

---

## `/api/cards/scan` の動作

1. 受信したファイルを一時ディレクトリに保存。
2. `preprocess_images.py` → `yomitoku.py` を順番に呼び出し、Supabase へ原本・前処理済み画像・OCR 結果を登録。
3. 処理は非同期で進むため、API レスポンスは 202 Accepted を返します。ログは Next.js 側に出力されるので、問題発生時はターミナルを確認してください。

---

## 開発メモ

- Python: `uv run` / `uv pip` を利用すると依存を隔離したまま動作確認できます。
- Web: Turbopack のキャッシュ不整合が起きた場合は `npm run dev -- --turbo` ではなく `next dev --no-turbo` で切り替えると安定することがあります。
- カメラ撮影が「デバイスが見つかりません」となる場合はブラウザの権限や外付けカメラの接続を確認し、再読み込みしてください。
- Supabase 側で RLS を有効化する場合は JWT のクレームや Policy を別途構成してください（本プロジェクトはローカル展示用のため SERVICE_ROLE を直接使用しています）。

---

## ライセンス

プロジェクト固有のライセンスが未定義の場合は、利用するサービス・ライブラリの規約に従ってください。

---

## コントリビューション

PR 時は `uv format` や `npm run lint` を実行し、Python/Next.js の依存ロックファイルを更新した場合は一緒にコミットしてください。開発中はタスクごとに Conventional Commit (`feat:`, `fix:` など) を守る運用としています。
