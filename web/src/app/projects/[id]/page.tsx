import Link from "next/link";
import { notFound } from "next/navigation";

import {
  SourceImageRow,
  type ProcessedImageRow,
  type ProjectRow,
  type YomitokuResultRow,
} from "@/lib/database.types";
import { createSupabaseServerClient } from "@/lib/supabaseServer";
import { DeleteCardButton } from "@/components/DeleteCardButton";

interface ProjectPageProps {
  params: Promise<{
    id: string;
  }>;
}

function isProjectRow(value: unknown): value is ProjectRow {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<ProjectRow>;
  return typeof candidate.id === "string" && typeof candidate.title === "string";
}

function ensureArray<T>(input: unknown): T[] {
  return Array.isArray(input) ? (input as T[]) : [];
}

export default async function ProjectPage({ params }: ProjectPageProps) {
  const { id } = await params;
  const supabase = createSupabaseServerClient();

  const projectId = id as ProjectRow["id"];

  const { data: project, error: projectError } = await supabase
    .from("projects")
    .select("*")
    .match({ id: projectId })
    .maybeSingle();

  if (projectError) {
    throw new Error(projectError.message);
  }

  if (!isProjectRow(project)) {
    notFound();
  }

  const projectRecord: ProjectRow = project;

  const { data: sourceData, error: sourcesError } = await supabase
    .from("source_images")
    .select(
      `
        *,
        processed_images:processed_images!source_image_id (
          *
        ),
        yomitoku_results:yomitoku_results!source_image_id (
          *
        )
      `,
    )
    .match({ project_id: projectRecord.id })
    .order("created_at", { ascending: false })
    .order("created_at", { referencedTable: "yomitoku_results", ascending: false })
    .limit(1, { referencedTable: "yomitoku_results" });

  if (sourcesError) {
    throw new Error(sourcesError.message);
  }

  const sources = ensureArray<
    SourceImageRow & {
      processed_images: ProcessedImageRow[] | null;
      yomitoku_results: YomitokuResultRow[] | null;
    }
  >(sourceData);

  return (
    <main
      style={{
        padding: "2rem 1.5rem 3rem",
        maxWidth: "960px",
        margin: "0 auto",
        display: "flex",
        flexDirection: "column",
        gap: "2rem",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: "1rem" }}>
        <Link href="/" style={{ color: "#2563eb", fontWeight: 600, fontSize: "0.95rem" }}>
          ← ダッシュボードに戻る
        </Link>
        <Link
          href={`/projects/${projectRecord.id}/manage`}
          style={{ color: "#2563eb", fontWeight: 600, fontSize: "0.95rem" }}
        >
          管理ページへ →
        </Link>
      </div>

      <section style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
        <h1 style={{ fontSize: "2rem", fontWeight: 600 }}>{projectRecord.title}</h1>
        {projectRecord.description && (
          <p style={{ color: "rgba(0,0,0,0.65)", lineHeight: 1.6 }}>
            {projectRecord.description}
          </p>
        )}
        <div
          style={{
            display: "flex",
            gap: "1.5rem",
            flexWrap: "wrap",
            fontSize: "0.95rem",
            color: "rgba(0,0,0,0.7)",
          }}
        >
          <span>ステータス: {projectRecord.status}</span>
          <span>作成日: {new Date(projectRecord.created_at).toLocaleString()}</span>
          <span>更新日: {new Date(projectRecord.updated_at).toLocaleString()}</span>
          <span>カード枚数: {sources.length}</span>
        </div>
      </section>

      <section style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
        <h2 style={{ fontSize: "1.4rem", fontWeight: 600 }}>登録済みカード</h2>
        {sources.length > 0 ? (
          <div className="project-list">
            {sources.map((source) => {
              const latestResult = Array.isArray(source.yomitoku_results)
                ? source.yomitoku_results[0] ?? null
                : null;
              const summary = latestResult?.summary
                ? (JSON.parse(latestResult.summary) as Record<string, string>)
                : null;
              const name =
                summary?.["名前"] ||
                summary?.["名前（英語）"] ||
                source.original_filename ||
                "名称未設定";
              const organization = summary?.["所属"] ?? "";
              const email = summary?.["e-mail"] ?? "";
              const phone = summary?.["Tel"] ?? "";
              const memo = summary?.["その他"] ?? "";
              const processed = Array.isArray(source.processed_images)
                ? source.processed_images[0] ?? null
                : null;

              return (
                <div key={source.id} className="project-card">
                  <Link
                    href={`/cards/${source.id}`}
                    className="project-card__link"
                    style={{ textDecoration: "none" }}
                  >
                    <div className="project-card__top">
                      <div>
                        <h3 className="project-card__title">{name}</h3>
                        <p className="project-card__subtitle">
                          {organization || "所属情報なし"}
                        </p>
                        <p className="muted-text" style={{ fontSize: "0.85rem", marginTop: "0.25rem" }}>
                          プロジェクト: {projectRecord.title}
                        </p>
                      </div>
                    <div className="project-card__badges">
                      <span className="badge badge--primary">
                        アップロード {new Date(source.created_at).toLocaleDateString()}
                      </span>
                      <span className="badge badge--secondary">
                        {processed ? "前処理済み" : "原本のみ"}
                      </span>
                    </div>
                  </div>

                    <div className="project-card__meta">
                    <span>
                      最新更新 {new Date(source.updated_at ?? source.created_at).toLocaleDateString()}
                    </span>
                    <span>
                      最新解析{" "}
                      {latestResult
                        ? new Date(latestResult.created_at).toLocaleDateString()
                        : "未解析"}
                    </span>
                  </div>

                    <div className="project-card__meta project-card__meta--contact">
                    <span className="chip">
                      メール: <strong>{email || "―"}</strong>
                    </span>
                    <span className="chip">
                      電話: <strong>{phone || "―"}</strong>
                    </span>
                  </div>

                    {memo && <p className="project-card__memo">メモ: {memo}</p>}
                  </Link>
                  <div style={{ marginTop: "0.75rem", display: "flex", justifyContent: "flex-end" }}>
                    <DeleteCardButton cardId={source.id} projectId={projectRecord.id} />
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <p style={{ color: "rgba(0,0,0,0.6)", fontSize: "0.9rem" }}>登録済みカードはありません。</p>
        )}
      </section>

    </main>
  );
}
