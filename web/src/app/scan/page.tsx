import Link from "next/link";

import { createSupabaseServerClient } from "@/lib/supabaseServer";
import { ScanForm } from "@/components/ScanForm";

async function loadProjects() {
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase
    .from("projects")
    .select("id, title, user_id, updated_at")
    .order("updated_at", { ascending: false });

  if (error) {
    throw new Error(error.message);
  }

  return (data ?? []).map((project) => {
    const userIdValue = typeof project.user_id === "string" ? project.user_id : "";
    return {
      id: project.id,
      title: project.title,
      user_id: userIdValue,
      updated_at: project.updated_at,
    };
  });
}

export default async function ScanPage() {
  const projects = await loadProjects();

  return (
    <main className="scan-page">
      <Link href="/" style={{ color: "#2563eb", fontWeight: 600, fontSize: "0.95rem" }}>
        ← ダッシュボードに戻る
      </Link>

      <header style={{ display: "grid", gap: "0.6rem" }}>
        <h1 className="dashboard__title" style={{ margin: 0 }}>
          名刺スキャン
        </h1>
        <p className="muted-text">
          名刺画像をアップロードすると Supabase Storage に保存され、解析ジョブの対象として登録されます。
          アップロード後、解析結果がダッシュボードに反映されるまで数分かかる場合があります。
        </p>
      </header>

      <div className="scan-layout">
        <ScanForm projects={projects} />

        <div className="card">
          <h2 className="card__title">アップロード前のチェック</h2>
          <div className="stats-grid">
            <div className="stats-item">
              <span className="stats-item__label">対応フォーマット</span>
              <span className="stats-item__value">JPEG / PNG / HEIC</span>
            </div>
            <div className="stats-item">
              <span className="stats-item__label">最大サイズ</span>
              <span className="stats-item__value">10MB / 1枚</span>
            </div>
            <div className="stats-item">
              <span className="stats-item__label">解析キュー</span>
              <span className="stats-item__value">
                {projects.length > 0
                  ? `${projects[0].title} など ${projects.length} 件`
                  : "未登録"}
              </span>
            </div>
          </div>
          <ul className="muted-text" style={{ marginTop: "0.75rem", display: "grid", gap: "0.45rem" }}>
            <li>影や傾きが目立つ場合は事前にトリミングや補正を行うと精度が向上します。</li>
            <li>裏面に追加メモがある場合は `/projects/ID/manage` から手動で追記できます。</li>
            <li>アップロード後に処理結果を確認したら、必ず内容をレビューしてください。</li>
          </ul>
        </div>
      </div>
    </main>
  );
}
