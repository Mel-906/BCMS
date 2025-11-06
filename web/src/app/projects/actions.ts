"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { randomUUID } from "crypto";

import { createSupabaseServerClient } from "@/lib/supabaseServer";

function splitStoragePath(storagePath?: string | null) {
  if (!storagePath) return null;
  const [bucket, ...rest] = storagePath.split("/");
  if (!bucket || rest.length === 0) return null;
  return { bucket, path: rest.join("/") };
}

export async function createProject(formData: FormData) {
  const supabase = createSupabaseServerClient();

  const title = String(formData.get("title") ?? "").trim();
  const description = String(formData.get("description") ?? "").trim();
  const status = String(formData.get("status") ?? "active").trim();
  const userId = String(formData.get("userId") ?? "").trim();

  if (!title) {
    throw new Error("プロジェクト名を入力してください。");
  }

  if (!userId) {
    throw new Error("userId が必要です。");
  }

  const id = formData.get("id") ? String(formData.get("id")) : randomUUID();

  const { error } = await supabase
    .from("projects")
    .insert({
      id,
      title,
      description: description || null,
      status: status || "active",
      user_id: userId,
    });

  if (error) {
    throw new Error(error.message);
  }

  revalidatePath("/projects");
  redirect(`/projects/${id}`);
}

export async function deleteProject(projectId: string) {
  const supabase = createSupabaseServerClient();

  if (!projectId) {
    throw new Error("projectId が必要です。");
  }

  const { error } = await supabase.from("projects").delete().eq("id", projectId);
  if (error) {
    throw new Error(error.message);
  }

  revalidatePath("/projects");
  redirect("/projects");
}

export async function deleteCard(cardId: string, projectId: string) {
  const supabase = createSupabaseServerClient();

  if (!cardId) {
    throw new Error("cardId が必要です。");
  }

  const { data: sourceRecord, error: sourceError } = await supabase
    .from("source_images")
    .select("storage_path, processed_images(storage_path)")
    .eq("id", cardId)
    .maybeSingle();

  if (sourceError) {
    throw new Error(sourceError.message);
  }
  if (!sourceRecord) {
    throw new Error("対象の名刺が見つかりません。");
  }

  const { data: results, error: resultsError } = await supabase
    .from("yomitoku_results")
    .select("id")
    .eq("source_image_id", cardId);

  if (resultsError) {
    throw new Error(resultsError.message);
  }

  const resultIds = (results ?? []).map((item) => item.id);
  if (resultIds.length > 0) {
    await supabase.from("yomitoku_result_fields").delete().in("result_id", resultIds);
  }

  await supabase.from("processed_images").delete().eq("source_image_id", cardId);
  await supabase.from("yomitoku_results").delete().eq("source_image_id", cardId);
  const { error: deleteSourceError } = await supabase.from("source_images").delete().eq("id", cardId);
  if (deleteSourceError) {
    throw new Error(deleteSourceError.message);
  }

  const storageRemovals: Record<string, string[]> = {};
  const primaryPath = splitStoragePath(sourceRecord.storage_path);
  if (primaryPath) {
    storageRemovals[primaryPath.bucket] = storageRemovals[primaryPath.bucket] || [];
    storageRemovals[primaryPath.bucket].push(primaryPath.path);
  }
  const processedArray = Array.isArray(sourceRecord.processed_images)
    ? sourceRecord.processed_images
    : [];
  processedArray.forEach((item) => {
    const info = splitStoragePath(item.storage_path);
    if (info) {
      storageRemovals[info.bucket] = storageRemovals[info.bucket] || [];
      storageRemovals[info.bucket].push(info.path);
    }
  });
  await Promise.all(
    Object.entries(storageRemovals).map(([bucket, paths]) =>
      supabase.storage
        .from(bucket)
        .remove(paths)
        .catch(() => undefined),
    ),
  );

  revalidatePath("/");
  revalidatePath("/projects");
  if (projectId) {
    revalidatePath(`/projects/${projectId}`);
  }
}
