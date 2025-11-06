"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { randomUUID } from "crypto";

import { createSupabaseServerClient } from "@/lib/supabaseServer";

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
