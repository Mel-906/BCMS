import { revalidatePath } from "next/cache";
import Link from "next/link";

import {
  SUMMARY_HEADERS,
  buildResultPayload,
  flattenPayload,
  parseSummary,
  type SummaryFields,
} from "@/lib/resultUtils";
import { createSupabaseServerClient } from "@/lib/supabaseServer";
import type { ProjectRow, YomitokuResultRow } from "@/lib/database.types";

async function loadProjectData(projectId: string) {
  const supabase = createSupabaseServerClient();

  const { data: project, error: projectError } = await supabase
    .from("projects")
    .select("*")
    .eq("id", projectId)
    .maybeSingle();

  if (projectError) {
    throw new Error(projectError.message);
  }
  if (!project) {
    throw new Error("Project not found");
  }

  const { data: results, error: resultsError } = await supabase
    .from("yomitoku_results")
    .select("*")
    .eq("project_id", projectId)
    .order("created_at", { ascending: false });

  if (resultsError) {
    throw new Error(resultsError.message);
  }

  return {
    project: project as ProjectRow,
    results: (results ?? []) as YomitokuResultRow[],
  };
}

async function updateProjectAction(formData: FormData) {
  "use server";
  const id = String(formData.get("id") ?? "");
  const title = String(formData.get("title") ?? "");
  const description = String(formData.get("description") ?? "");
  const status = String(formData.get("status") ?? "");

  if (!id || !title) {
    throw new Error("Missing project id or title");
  }

  const supabase = createSupabaseServerClient();
  const { error } = await supabase
    .from("projects")
    .update({
      title,
      description: description || null,
      status: status || "active",
    })
    .eq("id", id);

  if (error) {
    throw new Error(error.message);
  }

  revalidatePath(`/projects/${id}`);
  revalidatePath(`/projects/${id}/manage`);
  revalidatePath("/");
}

async function updateSummaryAction(formData: FormData) {
  "use server";
  const resultId = String(formData.get("resultId") ?? "");

  if (!resultId) {
    throw new Error("resultId is required");
  }

  const supabase = createSupabaseServerClient();

  const { data: existing, error: fetchError } = await supabase
    .from("yomitoku_results")
    .select("project_id, user_id, result")
    .eq("id", resultId)
    .maybeSingle();

  if (fetchError) {
    throw new Error(fetchError.message);
  }
  if (!existing) {
    throw new Error("Result not found");
  }

  const summaryEntries = SUMMARY_HEADERS.reduce<Record<string, string>>((acc, key) => {
    const value = formData.get(key);
    acc[key] = value ? String(value) : "";
    return acc;
  }, {}) as SummaryFields;

  const payload = buildResultPayload(summaryEntries);
  const mergedResult = {
    ...(existing.result ?? {}),
    ...payload,
  };

  const { error: updateError } = await supabase
    .from("yomitoku_results")
    .update({
      summary: JSON.stringify(summaryEntries),
      result: mergedResult,
    })
    .eq("id", resultId);

  if (updateError) {
    throw new Error(updateError.message);
  }

  const normalized = flattenPayload(payload).map((entry) => ({
    result_id: resultId,
    project_id: existing.project_id,
    user_id: existing.user_id,
    ...entry,
  }));

  const { error: deleteError } = await supabase
    .from("yomitoku_result_fields")
    .delete()
    .eq("result_id", resultId);
  if (deleteError) {
    throw new Error(deleteError.message);
  }

  if (normalized.length > 0) {
    const { error: insertError } = await supabase
      .from("yomitoku_result_fields")
      .insert(normalized);
    if (insertError) {
      throw new Error(insertError.message);
    }
  }

  const projectId = existing.project_id;
  revalidatePath(`/projects/${projectId}`);
  revalidatePath(`/projects/${projectId}/manage`);
  revalidatePath("/");
}

export default async function ManageProjectPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const { project, results } = await loadProjectData(id);

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
      <Link href={`/projects/${project.id}`} style={{ color: "#2563eb", fontWeight: 600 }}>
        ← プロジェクト詳細へ戻る
      </Link>

      <section
        style={{
          background: "#fff",
          borderRadius: "12px",
          border: "1px solid rgba(0,0,0,0.12)",
          padding: "1.5rem",
          display: "grid",
          gap: "1rem",
        }}
      >
        <h1 style={{ fontSize: "1.6rem", fontWeight: 600 }}>プロジェクト情報の編集</h1>

        <form action={updateProjectAction} style={{ display: "grid", gap: "1rem" }}>
          <input type="hidden" name="id" value={project.id} />

          <label style={{ display: "grid", gap: "0.35rem" }}>
            <span style={{ fontWeight: 600 }}>タイトル</span>
            <input
              name="title"
              defaultValue={project.title}
              required
              style={{
                border: "1px solid rgba(0,0,0,0.2)",
                borderRadius: "8px",
                padding: "0.65rem",
                fontSize: "0.95rem",
              }}
            />
          </label>

          <label style={{ display: "grid", gap: "0.35rem" }}>
            <span style={{ fontWeight: 600 }}>ステータス</span>
            <input
              name="status"
              defaultValue={project.status}
              style={{
                border: "1px solid rgba(0,0,0,0.2)",
                borderRadius: "8px",
                padding: "0.65rem",
                fontSize: "0.95rem",
              }}
            />
          </label>

          <label style={{ display: "grid", gap: "0.35rem" }}>
            <span style={{ fontWeight: 600 }}>説明</span>
            <textarea
              name="description"
              defaultValue={project.description ?? ""}
              rows={4}
              style={{
                border: "1px solid rgba(0,0,0,0.2)",
                borderRadius: "8px",
                padding: "0.65rem",
                fontSize: "0.95rem",
                resize: "vertical",
              }}
            />
          </label>

          <button
            type="submit"
            style={{
              alignSelf: "flex-start",
              padding: "0.75rem 1.25rem",
              borderRadius: "8px",
              background: "#2563eb",
              color: "#fff",
              fontWeight: 600,
              border: "none",
            }}
          >
            保存
          </button>
        </form>
      </section>

      <section
        style={{
          display: "grid",
          gap: "1.5rem",
        }}
      >
        <h2 style={{ fontSize: "1.4rem", fontWeight: 600 }}>解析結果の編集</h2>

        {results.length === 0 ? (
          <p style={{ color: "rgba(0,0,0,0.6)" }}>解析結果が登録されていません。</p>
        ) : (
          results.map((result) => {
            const summary = parseSummary(result.summary);

            return (
              <form
                key={result.id}
                action={updateSummaryAction}
                style={{
                  border: "1px solid rgba(0,0,0,0.12)",
                  borderRadius: "12px",
                  padding: "1.25rem",
                  background: "#fff",
                  display: "grid",
                  gap: "1rem",
                }}
              >
                <input type="hidden" name="resultId" value={result.id} />
                <header style={{ display: "flex", justifyContent: "space-between" }}>
                  <strong>結果ID: {result.id}</strong>
                  <span style={{ color: "rgba(0,0,0,0.6)" }}>
                    更新日時: {new Date(result.updated_at ?? result.created_at).toLocaleString()}
                  </span>
                </header>

                <div style={{ display: "grid", gap: "0.75rem" }}>
                  {SUMMARY_HEADERS.map((header) => (
                    <label key={header} style={{ display: "grid", gap: "0.35rem" }}>
                      <span style={{ fontWeight: 600 }}>{header}</span>
                      <input
                        name={header}
                        defaultValue={summary[header]}
                        style={{
                          border: "1px solid rgba(0,0,0,0.2)",
                          borderRadius: "8px",
                          padding: "0.65rem",
                          fontSize: "0.95rem",
                        }}
                      />
                    </label>
                  ))}
                </div>

                <button
                  type="submit"
                  style={{
                    alignSelf: "flex-start",
                    padding: "0.75rem 1.25rem",
                    borderRadius: "8px",
                    background: "#2563eb",
                    color: "#fff",
                    fontWeight: 600,
                    border: "none",
                  }}
                >
                  サマリを更新
                </button>
              </form>
            );
          })
        )}
      </section>
    </main>
  );
}
