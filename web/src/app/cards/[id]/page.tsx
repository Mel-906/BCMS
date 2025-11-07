import Link from "next/link";
import Image from "next/image";
import { notFound } from "next/navigation";

import { SUMMARY_HEADERS, parseSummary } from "@/lib/resultUtils";
import { createSupabaseServerClient } from "@/lib/supabaseServer";
import type { ProcessedImageRow, ProjectRow, SourceImageRow, YomitokuResultRow } from "@/lib/database.types";
import { ReprocessButton } from "@/components/ReprocessButton";

type CardDetailRow = SourceImageRow & {
  projects: ProjectRow;
  processed_images: ProcessedImageRow[] | null;
  yomitoku_results: YomitokuResultRow[] | null;
};

async function loadCard(cardId: string) {
  const supabase = createSupabaseServerClient();

  async function createSignedUrl(storagePath: string | null, expiresIn = 3600): Promise<string | null> {
    if (!storagePath) {
      return null;
    }
    const [bucket, ...pathParts] = storagePath.split("/");
    const objectPath = pathParts.join("/");
    if (!bucket || !objectPath) {
      return null;
    }

    const { data, error } = await supabase.storage.from(bucket).createSignedUrl(objectPath, expiresIn);
    if (error) {
      console.warn("Failed to create signed URL:", error.message);
      return null;
    }
    return data?.signedUrl ?? null;
  }

  const { data, error } = await supabase
    .from("source_images")
    .select(
      `
        *,
        projects (*),
        processed_images:processed_images!source_image_id (
          *
        ),
        yomitoku_results:yomitoku_results!source_image_id (
          *
        )
      `,
    )
    .eq("id", cardId)
    .order("created_at", { referencedTable: "processed_images", ascending: false })
    .limit(1, { referencedTable: "processed_images" })
    .order("created_at", { referencedTable: "yomitoku_results", ascending: false })
    .limit(1, { referencedTable: "yomitoku_results" })
    .maybeSingle<CardDetailRow>();

  if (error) {
    throw new Error(error.message);
  }

  if (!data) {
    return null;
  }

  const processedImage = Array.isArray(data.processed_images) ? data.processed_images[0] ?? null : null;
  const latestResult = Array.isArray(data.yomitoku_results) ? data.yomitoku_results[0] ?? null : null;
  const signedProcessed = await createSignedUrl(processedImage?.storage_path ?? null);
  const signedSource = await createSignedUrl(data.storage_path);

  return {
    project: data.projects,
    sourceImage: data,
    processedImage,
    latestResult,
    summaryFields: parseSummary(latestResult?.summary ?? null),
    imageUrl: signedProcessed ?? signedSource,
  };
}

function renderSummary(summary: Record<string, string> | null) {
  if (!summary) {
    return <p className="muted-text">サマリ情報が登録されていません。</p>;
  }

  return (
    <div className="card">
      <h2 className="card__title">名刺データ</h2>
      <div style={{ display: "grid", gap: "0.75rem" }}>
        {SUMMARY_HEADERS.map((key) => (
          <div key={key} style={{ display: "grid", gap: "0.25rem" }}>
            <span style={{ fontWeight: 600, color: "rgba(15,23,42,0.75)" }}>{key}</span>
            <span style={{ color: "rgba(15,23,42,0.75)" }}>{summary[key] || "—"}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export default async function CardDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const card = await loadCard(id);

  if (!card) {
    notFound();
  }

  const filename = card.sourceImage.original_filename ?? "名刺";
  const primaryName =
    card.summaryFields?.["名前"]?.trim() ||
    card.summaryFields?.["名前（英語）"]?.trim() ||
    card.summaryFields?.["その他"]?.split(/\r?\n/).find((line) => line.trim())?.trim() ||
    null;
  const pageTitle = primaryName ?? filename;

  const imageUrl = card.imageUrl;

  return (
    <main className="scan-page">
      <Link href="/" style={{ color: "#2563eb", fontWeight: 600, fontSize: "0.95rem" }}>
        ← 名刺一覧へ戻る
      </Link>

      <header style={{ display: "grid", gap: "0.6rem" }}>
        <h1 className="dashboard__title" style={{ margin: 0 }}>
          {pageTitle}
        </h1>
        <p className="muted-text">
          アップロード: {new Date(card.sourceImage.created_at).toLocaleString()} / 最新更新:{" "}
          {new Date(card.sourceImage.updated_at).toLocaleString()}
        </p>
      </header>

      <section style={{ display: "grid", gap: "0.75rem", marginBottom: "1.5rem" }}>
        {!card.latestResult ? (
          <p className="form-error" role="status">
            まだ解析結果が登録されていません。元画像から再解析を実行できます。
          </p>
        ) : (
          <p className="muted-text" style={{ margin: 0 }}>
            解析内容を更新したい場合は再解析ボタンを使用してください。
          </p>
        )}
        <ReprocessButton cardId={card.sourceImage.id} hasResult={Boolean(card.latestResult)} />
      </section>

      <div className="scan-layout">
        <div className="card" style={{ alignItems: "flex-start", justifyContent: "flex-start" }}>
          <h2 className="card__title" style={{ marginBottom: "0.75rem" }}>
            名刺画像
          </h2>
          {imageUrl ? (
            <Image
              src={imageUrl}
              alt={filename}
              width={card.sourceImage.width ?? 600}
              height={card.sourceImage.height ?? 400}
              style={{ maxWidth: "100%", height: "auto", borderRadius: "12px", border: "1px solid rgba(15,23,42,0.1)" }}
            />
          ) : (
            <p className="muted-text">画像の URL を生成できませんでした。</p>
          )}
        </div>

        <div style={{ display: "grid", gap: "1.5rem" }}>
          <div className="card card--compact">
            <h2 className="card__title">詳細</h2>
            <div style={{ display: "grid", gap: "0.5rem" }}>
              <div>
                <span style={{ fontWeight: 600 }}>ファイル名</span>
                <p className="muted-text">{filename}</p>
              </div>
              <div>
                <span style={{ fontWeight: 600 }}>元画像パス</span>
                <p className="muted-text" style={{ fontFamily: "monospace" }}>
                  {card.sourceImage.storage_path}
                </p>
              </div>
              {card.processedImage && (
                <div>
                  <span style={{ fontWeight: 600 }}>前処理済みパス</span>
                  <p className="muted-text" style={{ fontFamily: "monospace" }}>
                    {card.processedImage.storage_path}
                  </p>
                </div>
              )}
            </div>
          </div>
          {renderSummary(card.summaryFields)}
        </div>
      </div>
    </main>
  );
}
