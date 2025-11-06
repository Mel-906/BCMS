import Link from "next/link";

import { createSupabaseServerClient } from "@/lib/supabaseServer";
import type { ProjectRow, SourceImageRow, YomitokuResultRow } from "@/lib/database.types";

type ProjectStats = {
  project: ProjectRow;
  cardCount: number;
  lastCard: SourceImageRow | null;
  lastAnalysis: YomitokuResultRow | null;
};

async function loadProjects(): Promise<ProjectStats[]> {
  const supabase = createSupabaseServerClient();

  const { data, error } = await supabase
    .from("projects")
    .select(
      `
        *,
        source_images (
          id,
          project_id,
          user_id,
          storage_path,
          original_filename,
          created_at,
          updated_at
        ),
        yomitoku_results (
          id,
          project_id,
          created_at,
          updated_at
        )
      `,
    )
    .order("created_at", { ascending: false });

  if (error) {
    throw new Error(`Failed to load projects: ${error.message}`);
  }

  return (data ?? []).map((row) => {
    const images = (row.source_images ?? []) as SourceImageRow[];
    const results = (row.yomitoku_results ?? []) as YomitokuResultRow[];

    const sortedImages = [...images].sort(
      (a, b) =>
        new Date(b.updated_at ?? b.created_at).getTime() -
        new Date(a.updated_at ?? a.created_at).getTime(),
    );
    const sortedResults = [...results].sort(
      (a, b) =>
        new Date(b.updated_at ?? b.created_at).getTime() -
        new Date(a.updated_at ?? a.created_at).getTime(),
    );

    return {
      project: row as unknown as ProjectRow,
      cardCount: images.length,
      lastCard: sortedImages[0] ?? null,
      lastAnalysis: sortedResults[0] ?? null,
    };
  });
}

export default async function ProjectsPage() {
  const projects = await loadProjects();

  return (
    <main className="dashboard">
      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div style={{ display: "grid", gap: "0.6rem" }}>
          <h1 className="dashboard__title" style={{ margin: 0 }}>
            プロジェクト管理
          </h1>
          <p className="muted-text">
            OCR パイプラインが紐づくプロジェクトの状況を閲覧・編集できます。名刺単位の管理はダッシュボード画面で行ってください。
          </p>
        </div>
        <Link href="/scan" className="primary-button" style={{ textDecoration: "none" }}>
          名刺をアップロード
        </Link>
      </header>

      <div className="card">
        <h2 className="card__title">
          プロジェクト一覧{" "}
          <span style={{ fontSize: "0.9rem", color: "rgba(15,23,42,0.55)" }}>({projects.length} 件)</span>
        </h2>

        <div className="project-list">
          {projects.length === 0 ? (
            <p className="muted-text">プロジェクトが存在しません。名刺をアップロードすると自動で作成されます。</p>
          ) : (
            projects.map(({ project, cardCount, lastCard, lastAnalysis }) => (
              <Link
                key={project.id}
                href={`/projects/${project.id}`}
                className="project-card"
                style={{ textDecoration: "none" }}
              >
                <div className="project-card__top">
                  <div>
                    <h3 className="project-card__title">{project.title}</h3>
                    {project.description && (
                      <p className="project-card__subtitle">{project.description}</p>
                    )}
                  </div>
                  <div className="project-card__badges">
                    <span className="badge badge--primary">{project.status}</span>
                    <span className="badge badge--secondary">名刺 {cardCount} 枚</span>
                  </div>
                </div>

                <div className="project-card__meta">
                  <span>作成 {new Date(project.created_at).toLocaleDateString()}</span>
                  <span>更新 {new Date(project.updated_at).toLocaleDateString()}</span>
                </div>

                <div className="project-card__meta project-card__meta--contact">
                  <span className="chip">
                    最終アップロード:{" "}
                    <strong>
                      {lastCard ? new Date(lastCard.updated_at ?? lastCard.created_at).toLocaleString() : "—"}
                    </strong>
                  </span>
                  <span className="chip">
                    最新解析:{" "}
                    <strong>
                      {lastAnalysis
                        ? new Date(lastAnalysis.updated_at ?? lastAnalysis.created_at).toLocaleString()
                        : "未解析"}
                    </strong>
                  </span>
                </div>
              </Link>
            ))
          )}
        </div>
      </div>
    </main>
  );
}
