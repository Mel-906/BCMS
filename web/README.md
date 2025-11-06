## BCMS OCR Dashboard (Next.js)

`app/` 配下のサーバーコンポーネントから Supabase を参照し、以下を表示する最小構成の Web ダッシュボードです。

- トップページ: Supabase 上の `projects` 一覧と最新のサマリ (`yomitoku_results.summary`)。
- `/projects/[id]`: 登録済みカード (`source_images`)、解析結果、正規化フィールド (`yomitoku_result_fields`) とフル JSON。

### 環境変数

`.env.local` に Supabase の URL とキーを設定してください。テンプレートは `.env.local.example` を参照します。

```
NEXT_PUBLIC_SUPABASE_URL=https://xxxx.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=anon-key
SUPABASE_SERVICE_ROLE_KEY=service-role-key
```

`SUPABASE_SERVICE_ROLE_KEY` はサーバーコンポーネントのみで利用します。公開環境では RLS と認証を設定し、必要に応じて API 経由でデータを取得してください。

### 開発サーバー

```bash
npm install
npm run dev
```

`http://localhost:3000` を開くとダッシュボードを確認できます。
