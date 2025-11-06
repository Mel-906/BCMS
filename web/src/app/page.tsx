import Link from "next/link";

import { createSupabaseServerClient } from "@/lib/supabaseServer";
import type { ProjectRow, YomitokuResultRow } from "@/lib/database.types";

type ResultPreview = Pick<
  YomitokuResultRow,
  "id" | "created_at" | "summary" | "confidence"
>;

interface ProjectSummary {
  project: ProjectRow;
  sourceImageCount: number;
  latestResult: ResultPreview | null;
  latestSummary: Record<string, string> | null;
}

type ProjectQueryRow = ProjectRow & {
  source_images: { count: number | null }[] | null;
  yomitoku_results: ResultPreview[] | null;
};

function parseSummary(summary: string | null): Record<string, string> | null {
  if (!summary) {
    return null;
  }
  try {
    const parsed = JSON.parse(summary);
    if (parsed && typeof parsed === "object") {
      return parsed as Record<string, string>;
    }
  } catch {
    return null;
  }
  return null;
}

async function loadProjects(): Promise<ProjectSummary[]> {
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase
    .from("projects")
    .select(
      `
        id,
        title,
        description,
        status,
        user_id,
        created_at,
        updated_at,
        source_images ( count ),
        yomitoku_results (
          id,
          created_at,
          summary,
          confidence
        )
      `,
    )
    .order("created_at", { ascending: false });

  if (error) {
    throw new Error(`Failed to load projects: ${error.message}`);
  }

  const rows: ProjectQueryRow[] = (data ?? []) as ProjectQueryRow[];

  return rows.map((row) => {
    const projectRecord: ProjectRow = {
      id: row.id,
      title: row.title,
      description: row.description,
      status: row.status,
      created_at: row.created_at,
      updated_at: row.updated_at,
      user_id: row.user_id,
    };
    const latestResult: ResultPreview | null =
      (row.yomitoku_results && row.yomitoku_results.length > 0
        ? [...row.yomitoku_results].sort(
            (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
          )[0]
        : null) ?? null;

    const sourceImageCount = row.source_images?.[0]?.count ?? 0;

    return {
      project: projectRecord,
      sourceImageCount,
      latestResult,
      latestSummary: parseSummary(latestResult?.summary ?? null),
    };
  });
}

function SearchPanel() {
  return (
    <div className="card">
      <h2 className="card__title">名刺を検索</h2>
      <p className="muted-text">氏名・会社・メールアドレス・メモを横断検索できます。</p>

      <form className="search-panel" onSubmit={(event) => event.preventDefault()}>
        <div className="search-panel__row">
          <label className="input-control">
            <span>キーワード</span>
            <input placeholder="例: 山田 / SaaS / 投資家" />
          </label>
          <label className="input-control">
            <span>タグ</span>
            <select defaultValue="all">
              <option value="all">すべて</option>
              <option value="recent">最近追加</option>
              <option value="lead">リード</option>
            </select>
          </label>
          <label className="input-control">
            <span>並び順</span>
            <select defaultValue="updated">
              <option value="updated">最近更新された順</option>
              <option value="created">追加順</option>
            </select>
          </label>
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <button type="submit" className="primary-button">
            検索する
          </button>
        </div>
      </form>
    </div>
  );
}

function UploadPanel({ projectsCount }: { projectsCount: number }) {
  return (
    <div className="card">
      <h2 className="card__title">名刺をアップロード</h2>
      <p className="muted-text">
        表面の画像を登録すると OCR が文字を抽出し、Supabase に保存した解析結果がダッシュボードに反映されます。
      </p>

      <div className="upload-steps">
        <div className="upload-step">
          <strong>表面（必須）</strong>
          <span>画像をクリックして選択、またはドラッグ＆ドロップしてください。</span>
          <span>対応形式: JPEG / PNG / HEIC ・ 最大 10MB</span>
        </div>
        <div className="upload-step">
          <strong>裏面（任意）</strong>
          <span>裏面にメモや英語版がある場合は追加してください。</span>
          <span>対応形式: JPEG / PNG / HEIC ・ 最大 10MB</span>
        </div>
      </div>

      <Link href="/scan" className="primary-button" style={{ textDecoration: "none" }}>
        新規キューに送信
      </Link>

      <p className="scan-note">
        プロジェクト数: {projectsCount} 件。アップロード後は `/projects/ID/manage` から内容を編集できます。
      </p>
    </div>
  );
}

function SummaryPanel({
  projects,
  cards,
  recentUpdated,
}: {
  projects: number;
  cards: number;
  recentUpdated: string | null;
}) {
  return (
    <div className="card card--compact">
      <h2 className="card__title">活動状況サマリー</h2>
      <div className="stats-grid">
        <div className="stats-item">
          <span className="stats-item__label">プロジェクト数</span>
          <span className="stats-item__value">{projects}</span>
        </div>
        <div className="stats-item">
          <span className="stats-item__label">名刺枚数</span>
          <span className="stats-item__value">{cards}</span>
        </div>
        <div className="stats-item">
          <span className="stats-item__label">最終更新</span>
          <span className="stats-item__value">
            {recentUpdated ? recentUpdated : "—"}
          </span>
        </div>
      </div>
      <p className="muted-text">
        DatabaseAgent が統計情報を算出し、フォローアップが必要な名刺をピックアップします。
      </p>
    </div>
  );
}

export default async function Home() {
  const projects = await loadProjects();
  const totalCards = projects.reduce((acc, item) => acc + item.sourceImageCount, 0);
  const recentUpdated =
    projects
      .map((item) => item.project.updated_at ?? item.project.created_at)
      .filter(Boolean)
      .map((date) => new Date(date).getTime())
      .sort((a, b) => b - a)[0] ?? null;

  const recentUpdatedLabel = recentUpdated
    ? new Date(recentUpdated).toLocaleString()
    : null;

  return (
    <main className="dashboard">
      <h1 className="dashboard__title">名刺管理ダッシュボード</h1>
      <div className="dashboard__grid">
        <section className="dashboard__main">
          <SearchPanel />

          <div className="card">
            <h2 className="card__title">
              名刺一覧 <span style={{ fontSize: "0.9rem", color: "rgba(15,23,42,0.55)" }}>({projects.length} 件)</span>
            </h2>

            {projects.length === 0 ? (
              <p className="muted-text">
                解析済みの名刺がまだありません。`preprocess_images.py` と `yomitoku.py` を Supabase 連携で実行すると、ここに一覧が表示されます。
              </p>
            ) : (
              <div className="project-list">
                {projects.map(({ project, sourceImageCount, latestResult, latestSummary }) => (
                  <article key={project.id} className="project-card">
                    <div className="project-card__header">
                      <div>
                        <h3 className="project-card__title">{project.title}</h3>
                        {project.description && (
                          <p className="muted-text" style={{ marginTop: "0.35rem" }}>
                            {project.description}
                          </p>
                        )}
                      </div>
                      <span className="tag" style={{ background: "rgba(59,130,246,0.12)", color: "#2563eb" }}>
                        {project.status}
                      </span>
                    </div>

                    <div className="project-card__meta">
                      <span>カード {sourceImageCount} 枚</span>
                      <span>
                        更新 {new Date(project.updated_at ?? project.created_at).toLocaleDateString()}
                      </span>
                      <span>
                        最新解析{" "}
                        {latestResult ? new Date(latestResult.created_at).toLocaleDateString() : "未解析"}
                      </span>
                    </div>

                    {latestSummary ? (
                      <div className="project-card__meta" style={{ flexDirection: "column", gap: "0.4rem" }}>
                        <div style={{ fontWeight: 600, color: "rgba(15,23,42,0.7)" }}>最新サマリ</div>
                        <div className="tags">
                          {["名前", "職業", "所属", "Tel"].map((key) => (
                            <span key={key} className="tag" style={{ background: "rgba(16,185,129,0.12)", color: "#047857" }}>
                              {key}: {latestSummary[key] || "—"}
                            </span>
                          ))}
                        </div>
                      </div>
                    ) : (
                      <p className="muted-text">まだサマリは登録されていません。</p>
                    )}

                    <div className="project-card__links">
                      <Link href={`/projects/${project.id}`}>詳細ページへ →</Link>
                      <Link href={`/projects/${project.id}/manage`}>管理 →</Link>
                    </div>
                  </article>
                ))}
              </div>
            )}
          </div>
        </section>

        <aside className="dashboard__side" style={{ display: "grid", gap: "1.5rem" }}>
          <UploadPanel projectsCount={projects.length} />
          <SummaryPanel
            projects={projects.length}
            cards={totalCards}
            recentUpdated={recentUpdatedLabel}
          />
        </aside>
      </div>
    </main>
  );
}
