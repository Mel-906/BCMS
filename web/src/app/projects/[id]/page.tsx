import Link from "next/link";
import { notFound } from "next/navigation";

import {
  ResultFieldRow,
  SourceImageRow,
  YomitokuResultRow,
  type ProjectRow,
} from "@/lib/database.types";
import { createSupabaseServerClient } from "@/lib/supabaseServer";

interface ProjectPageProps {
  params: {
    id: string;
  };
}

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

function groupFieldsByResult(rows: ResultFieldRow[] | null | undefined) {
  const map = new Map<string, ResultFieldRow[]>();
  if (!rows) {
    return map;
  }
  for (const row of rows) {
    if (!map.has(row.result_id)) {
      map.set(row.result_id, []);
    }
    map.get(row.result_id)!.push(row);
  }
  return map;
}

function renderFieldValue(row: ResultFieldRow): string {
  if (row.value_text) return row.value_text;
  if (typeof row.value_numeric === "number") return String(row.value_numeric);
  if (typeof row.value_boolean === "boolean") return row.value_boolean ? "true" : "false";
  if (row.value_json) return JSON.stringify(row.value_json);
  return "—";
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
  const supabase = createSupabaseServerClient();

  const projectId = params.id as ProjectRow["id"];

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

  const [sourcesRes, resultsRes, fieldsRes] = await Promise.all([
    supabase
      .from("source_images")
      .select("*")
      .match({ project_id: projectRecord.id })
      .order("created_at", { ascending: true }),
    supabase
      .from("yomitoku_results")
      .select("*")
      .match({ project_id: projectRecord.id })
      .order("created_at", { ascending: false }),
    supabase
      .from("yomitoku_result_fields")
      .select("*")
      .match({ project_id: projectRecord.id })
      .order("result_id", { ascending: true }),
  ]);

  if (sourcesRes.error) {
    throw new Error(sourcesRes.error.message);
  }
  if (resultsRes.error) {
    throw new Error(resultsRes.error.message);
  }
  if (fieldsRes.error) {
    throw new Error(fieldsRes.error.message);
  }

  const sources = ensureArray<SourceImageRow>(sourcesRes.data);
  const results = ensureArray<YomitokuResultRow>(resultsRes.data);
  const fields = ensureArray<ResultFieldRow>(fieldsRes.data);

  const fieldsByResult = groupFieldsByResult(fields);

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
          <span>解析件数: {results.length}</span>
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

      <section style={{ display: "flex", flexDirection: "column", gap: "1.25rem" }}>
        <h2 style={{ fontSize: "1.4rem", fontWeight: 600 }}>解析結果</h2>
        {results.length > 0 ? (
          results.map((result: YomitokuResultRow) => {
            const summary = parseSummary(result.summary);
            const fields = fieldsByResult.get(result.id) ?? [];

            return (
              <article
                key={result.id}
                style={{
                  border: "1px solid rgba(0,0,0,0.12)",
                  borderRadius: "12px",
                  padding: "1.25rem",
                  display: "flex",
                  flexDirection: "column",
                  gap: "0.75rem",
                }}
              >
                <header style={{ display: "flex", justifyContent: "space-between" }}>
                  <div style={{ display: "flex", flexDirection: "column", gap: "0.3rem" }}>
                    <strong>結果ID: {result.id}</strong>
                    <span style={{ color: "rgba(0,0,0,0.6)" }}>
                      解析日時: {new Date(result.created_at).toLocaleString()}
                    </span>
                  </div>
                  <div style={{ textAlign: "right", color: "rgba(0,0,0,0.6)" }}>
                    <div>Confidence: {result.confidence ?? "—"}</div>
                  </div>
                </header>

                {summary ? (
                  <div
                    style={{
                      border: "1px solid rgba(59,130,246,0.2)",
                      background: "rgba(59,130,246,0.06)",
                      borderRadius: "10px",
                      padding: "0.9rem",
                      display: "grid",
                      gap: "0.35rem",
                    }}
                  >
                    <strong style={{ fontSize: "0.95rem" }}>サマリ</strong>
                    {Object.entries(summary).map(([key, value]) => (
                      <div key={key} style={{ display: "flex", gap: "0.5rem" }}>
                        <span style={{ minWidth: "6rem", fontWeight: 600 }}>{key}</span>
                        <span>{value || "—"}</span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p style={{ color: "rgba(0,0,0,0.55)", fontSize: "0.9rem" }}>
                    サマリ JSON を解釈できませんでした。
                  </p>
                )}

                <details>
                  <summary style={{ cursor: "pointer", color: "#2563eb", fontWeight: 600 }}>
                    正規化フィールド ({fields.length})
                  </summary>
                  <div style={{ marginTop: "0.75rem", display: "grid", gap: "0.4rem" }}>
                    {fields.length === 0 ? (
                      <p style={{ color: "rgba(0,0,0,0.6)", fontSize: "0.9rem" }}>
                        正規化フィールドは登録されていません。
                      </p>
                    ) : (
                      fields.map((field) => (
                        <div
                          key={`${field.result_id}-${field.key_path}-${field.id}`}
                          style={{
                            display: "flex",
                            gap: "0.75rem",
                            fontSize: "0.9rem",
                            borderBottom: "1px solid rgba(0,0,0,0.08)",
                            paddingBottom: "0.4rem",
                          }}
                        >
                          <span style={{ minWidth: "10rem", fontWeight: 600 }}>
                            {field.key_path}
                          </span>
                          <span>{renderFieldValue(field)}</span>
                        </div>
                      ))
                    )}
                  </div>
                </details>

                <details>
                  <summary style={{ cursor: "pointer", color: "#2563eb", fontWeight: 600 }}>
                    フル JSON を確認
                  </summary>
                  <pre
                    style={{
                      marginTop: "0.75rem",
                      background: "rgba(0,0,0,0.05)",
                      borderRadius: "10px",
                      padding: "0.75rem",
                      overflowX: "auto",
                      fontSize: "0.85rem",
                      lineHeight: 1.5,
                    }}
                  >
                    {JSON.stringify(result.result, null, 2)}
                  </pre>
                </details>
              </article>
            );
          })
        ) : (
          <p style={{ color: "rgba(0,0,0,0.6)", fontSize: "0.9rem" }}>解析結果はまだありません。</p>
        )}
      </section>
    </main>
  );
}
