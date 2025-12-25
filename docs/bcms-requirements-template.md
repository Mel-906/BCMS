# BCMS 要件定義書（ひな型）

> **バージョン**: 0.1  
> **作成日**: YYYY/MM/DD  
> **作成者**: （担当者名）

---

## 1. プロジェクト概要
- **システム名**: Business Card Management Suite (BCMS)
- **目的**: 紙の名刺をデジタル化し、連絡先情報を一元管理／検索できるようにする。
- **提供価値**:
  - 展示会など短期イベントでも迅速に名刺を記録。
  - OCR + AI 要約による自動情報整理。
  - クラウド連携によりマルチデバイスから参照可能。
- **ステークホルダー**:
  - 展示会スタッフ／営業担当
  - システム運用者（バックオフィス／IT）
  - 来場者（名刺提供者）

---

## 2. システム構成
| レイヤー | 技術 | 役割 |
| --- | --- | --- |
| フロントエンド | Next.js 16, React 19, Supabase JS | ダッシュボード UI、アップロードフォーム、検索 |
| バックエンド | Next.js API Routes | アップロード受付、Python ジョブ起動 |
| 画像処理 & OCR | Python (`preprocess_images.py`, `yomitoku.py`), YomiToku, Gemini | 前処理、OCR、項目抽出 |
| データベース | Supabase Postgres, Storage | 原本／加工画像、OCR 結果、プロジェクト管理 |

---

## 3. 機能要件

### 3.1 名刺アップロード
- Web UI から JPEG/PNG/HEIC を複数選択してアップロードできる。
- デバイスカメラから直接撮影し、縦向き補正／明るさ調整を自動適用。
- 各画像は Supabase Storage に保存し、メタデータを DB に記録。

### 3.2 OCR & AI 要約
- `preprocess_images.py` による EXIF 補正、ノイズ除去、解像度調整。
- `yomitoku.py` による文字認識とテーブル検出。
- Gemini API を用いて以下の項目を JSON 化:
  - 名前（日本語／英語）、職業、Tel、メール、所属、住所、URL、メモ 等。
- API 利用不可時はヒューリスティック抽出へフォールバック。

### 3.3 名刺管理ダッシュボード
- 名刺一覧（カード形式）を表示し、検索・並び替え・ページネーションが可能。
- カードをクリックすると詳細ページへ遷移し、原本／前処理画像・抽出フィールドを閲覧できる。
- プロジェクト単位で名刺をグルーピングし、管理画面で追加／削除ができる。

### 3.4 プロジェクト管理
- プロジェクト一覧表示、新規作成、削除（確認ダイアログ付き）。
- プロジェクト詳細ページで配下の名刺カードをダッシュボード同様に表示。

### 3.5 権限・認証
- デモ環境: Supabase Service Role Key を使用（限定公開）。
- 本番想定: Supabase Auth でログインユーザーごとに `user_id` を払い出し、RLS と組み合わせてアクセス制御。

---

## 4. 非機能要件
| 項目 | 要件例 |
| --- | --- |
| パフォーマンス | 1ページあたり 30 件の名刺カード表示。アップロード後 5 分以内に OCR 結果を反映。 |
| 可用性 | 重要度中。展示期間中はローカル PC で稼働するため、ネットワーク断時は一時的にオフライン運用。 |
| セキュリティ | Supabase Storage の公開設定をレビュー。API キー管理、Gemini キー漏洩時のフォールバック実装済み。 |
| 操作性 | カメラ撮影の即時プレビュー、ファイル削除ボタン、検索フォームの補助説明。 |
| 保守性 | Python/Next.js ともに README にセットアップ手順を記載。`uv` と `npm` による依存管理。 |

---

## 5. データ要件
### 5.1 主なテーブル
1. `projects`  
   - id (UUID), title, description, user_id, status, timestamps
2. `source_images`  
   - id, project_id, user_id, storage_path, original_filename, width, height, format, created_at
3. `processed_images`  
   - id, source_image_id, storage_path, variant, params, created_at
4. `yomitoku_results`  
   - id, source_image_id, processed_image_id, summary(JSON), confidence, created_at
5. `yomitoku_result_fields`  
   - id, result_id, field_key, value（name, email などの正規化キー）

### 5.2 ストレージ
- `source-images` バケット: 原本ファイルを保存。
- `processed-images` バケット: 前処理済み画像を保存。
- Manifest (`manifest.json`) にアップロードログを記録。

---

## 6. 外部インターフェース
| 区分 | 内容 |
| --- | --- |
| API | `POST /api/cards/scan`：名刺画像を受け取り、非同期で Python ジョブを起動。 |
| Gemini API | Model: `gemini-2.0-flash`（例）。429/403 のエラー処理（リトライ／フォールバック）実装済み。 |
| Supabase | REST, Storage, Auth を利用。環境変数: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`。 |

---

## 7. 運用・監視
- ローカル実行ログ（Next.js / Python）をターミナルで監視。
- Supabase Storage/DB の容量・RLS 設定を定期確認。
- Gemini API キーは漏洩検出時に再発行し、システムを再起動する。

---

## 8. リスクと対策
| リスク | 影響 | 対策 |
| --- | --- | --- |
| Gemini API キーの制限・漏洩 | OCR 結果の精度低下 | ヒューリスティック抽出へ自動切替、キーのローテーション手順を整備 |
| ネットワーク不調 | Supabase 連携不可 | ローカル保存＋後から再送できるようアップロード履歴を保持 |
| ストレージ容量不足 | 画像保存不可 | 定期的に古いデータをアーカイブ、プラン上限を確認 |
| DB,

---

## 9. スケジュール（例）
| フェーズ | 期間 | 内容 |
| --- | --- | --- |
| 設計 | 2 週間 | 要件定義レビュー、DB スキーマ確定 |
| 実装 | 4 週間 | Python パイプライン、Next.js UI、Supabase 連携 |
| テスト | 1 週間 | OCR 精度検証、アップロード耐久テスト |
| 展示準備 | 1 週間 | `.env` 設定、本番データ投入、ドキュメント印刷 |

---

## 10. 承認
| 役割 | 氏名 | 日付 | 備考 |
| --- | --- | --- | --- |
| プロダクトオーナー |  |  |  |
| 技術責任者 |  |  |  |
| 運用責任者 |  |  |  |

