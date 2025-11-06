import Link from "next/link";

import { createSupabaseServerClient } from "@/lib/supabaseServer";
import { ScanForm } from "@/components/ScanForm";

async function loadProjects() {
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase
    .from("projects")
    .select("id, title, user_id")
    .order("created_at", { ascending: false });

  if (error) {
    throw new Error(error.message);
  }

  return (data ?? []).map((project) => ({
    id: project.id,
    title: project.title,
    user_id: project.user_id,
  }));
}

export default async function ScanPage() {
  const projects = await loadProjects();

  return (
    <main
      style={{
        padding: "2rem 1.5rem 3rem",
        maxWidth: "720px",
        margin: "0 auto",
        display: "flex",
        flexDirection: "column",
        gap: "1.5rem",
      }}
    >
      <Link href="/" style={{ color: "#2563eb", fontWeight: 600, fontSize: "0.95rem" }}>
        ← ダッシュボードに戻る
      </Link>

      <section style={{ display: "grid", gap: "0.75rem" }}>
        <h1 style={{ fontSize: "2rem", fontWeight: 600 }}>名刺スキャン</h1>
        <p style={{ color: "rgba(0,0,0,0.65)", lineHeight: 1.6 }}>
          名刺画像をアップロードすると Supabase Storage に保存され、解析ジョブの対象として登録されます。
          アップロード後、解析結果がダッシュボードに反映されるまで数分かかる場合があります。
        </p>
      </section>

      <ScanForm projects={projects} />
    </main>
  );
}
