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
            (a, b) =>
              new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
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

export default async function Home() {
  const projects = await loadProjects();

  return (
    <main
      style={{
        padding: "2rem 1.5rem",
        maxWidth: "960px",
        margin: "0 auto",
        display: "flex",
        flexDirection: "column",
        gap: "1.5rem",
      }}
    >
      <header style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
        <h1 style={{ fontSize: "2rem", fontWeight: 600 }}>OCR Projects Dashboard</h1>
        <p style={{ color: "rgba(0,0,0,0.65)", lineHeight: 1.5 }}>
          Supabase 上に保存したカード解析の進捗を一覧で確認できます。各プロジェクトのカード枚数と最新の解析サマリを表示しています。
        </p>
      </header>

      <section style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
        {projects.length === 0 ? (
          <p style={{ color: "rgba(0,0,0,0.55)" }}>
            プロジェクトが検出されませんでした。`preprocess_images.py` と `yomitoku.py` を Supabase 連携で実行すると、
            ここに一覧が表示されます。
          </p>
        ) : (
          projects.map(({ project, sourceImageCount, latestResult, latestSummary }) => (
            <article
              key={project.id}
              style={{
                border: "1px solid rgba(0,0,0,0.12)",
                borderRadius: "12px",
                padding: "1.25rem",
                display: "flex",
                flexDirection: "column",
                gap: "0.75rem",
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", gap: "1rem" }}>
                <div style={{ flex: 1 }}>
                  <h2 style={{ fontSize: "1.4rem", fontWeight: 600 }}>{project.title}</h2>
                  {project.description && (
                    <p style={{ color: "rgba(0,0,0,0.6)", marginTop: "0.4rem", lineHeight: 1.5 }}>
                      {project.description}
                    </p>
                  )}
                </div>
                <div
                  style={{
                    alignSelf: "flex-start",
                    backgroundColor: "rgba(59, 130, 246, 0.1)",
                    color: "#2563eb",
                    padding: "0.25rem 0.75rem",
                    borderRadius: "999px",
                    fontSize: "0.85rem",
                    fontWeight: 600,
                  }}
                >
                  {project.status}
                </div>
              </div>

              <div
                style={{
                  display: "flex",
                  gap: "1.5rem",
                  flexWrap: "wrap",
                  fontSize: "0.95rem",
                  color: "rgba(0,0,0,0.7)",
                }}
              >
                <span>カード枚数: {sourceImageCount}</span>
                <span>
                  最終更新: {new Date(project.updated_at ?? project.created_at).toLocaleString()}
                </span>
                <span>
                  最新解析:{" "}
                  {latestResult
                    ? new Date(latestResult.created_at).toLocaleString()
                    : "未解析"}
                </span>
              </div>

              {latestSummary ? (
                <div
                  style={{
                    border: "1px solid rgba(0,0,0,0.08)",
                    borderRadius: "10px",
                    padding: "0.9rem",
                    background: "rgba(59, 130, 246, 0.05)",
                    display: "grid",
                    gap: "0.4rem",
                  }}
                >
                  <strong style={{ fontSize: "0.95rem", color: "rgba(0,0,0,0.75)" }}>
                    最新サマリ
                  </strong>
                  <div style={{ fontSize: "0.9rem", display: "grid", gap: "0.3rem" }}>
                    {Object.entries(latestSummary).map(([key, value]) => (
                      <div key={key} style={{ display: "flex", gap: "0.5rem" }}>
                        <span style={{ fontWeight: 600, minWidth: "6rem" }}>{key}</span>
                        <span>{value || "—"}</span>
                      </div>
                    ))}
                  </div>
                </div>
              ) : (
                <p style={{ color: "rgba(0,0,0,0.55)", fontSize: "0.9rem" }}>
                  まだサマリは登録されていません。
                </p>
              )}

              <div>
                <Link
                  href={`/projects/${project.id}`}
                  style={{
                    color: "#2563eb",
                    fontWeight: 600,
                    fontSize: "0.95rem",
                  }}
                >
                  詳細ページへ →
                </Link>
              </div>
            </article>
          ))
        )}
      </section>
    </main>
  );
}
