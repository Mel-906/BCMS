import Link from "next/link";
import { notFound } from "next/navigation";

import { SourceImageRow, type ProjectRow } from "@/lib/database.types";
import { createSupabaseServerClient } from "@/lib/supabaseServer";

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
    .select("*")
    .match({ project_id: projectRecord.id })
    .order("created_at", { ascending: true });

  if (sourcesError) {
    throw new Error(sourcesError.message);
  }

  const sources = ensureArray<SourceImageRow>(sourceData);

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
          <div
            style={{
              border: "1px solid rgba(0,0,0,0.1)",
              borderRadius: "12px",
              overflow: "hidden",
            }}
          >
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.9rem" }}>
              <thead style={{ background: "rgba(59,130,246,0.08)" }}>
                <tr>
                  <th style={{ textAlign: "left", padding: "0.75rem" }}>ファイル名</th>
                  <th style={{ textAlign: "left", padding: "0.75rem" }}>Storage Path</th>
                  <th style={{ textAlign: "left", padding: "0.75rem" }}>解像度</th>
                  <th style={{ textAlign: "left", padding: "0.75rem" }}>形式</th>
                </tr>
              </thead>
              <tbody>
                {sources.map((source: SourceImageRow) => (
                  <tr key={source.id} style={{ borderTop: "1px solid rgba(0,0,0,0.08)" }}>
                    <td style={{ padding: "0.75rem" }}>{source.original_filename ?? "—"}</td>
                    <td style={{ padding: "0.75rem", fontFamily: "monospace" }}>
                      {source.storage_path}
                    </td>
                    <td style={{ padding: "0.75rem" }}>
                      {source.width && source.height
                        ? `${source.width} x ${source.height}`
                        : "—"}
                    </td>
                    <td style={{ padding: "0.75rem" }}>{source.format ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p style={{ color: "rgba(0,0,0,0.6)", fontSize: "0.9rem" }}>登録済みカードはありません。</p>
        )}
      </section>

    </main>
  );
}
