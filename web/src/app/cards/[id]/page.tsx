import Link from "next/link";
import Image from "next/image";
import { notFound } from "next/navigation";

import {
  SUMMARY_HEADERS,
  parseSummary,
} from "@/lib/resultUtils";
import { createSupabaseServerClient } from "@/lib/supabaseServer";
import type { ProcessedImageRow, ProjectRow, SourceImageRow, YomitokuResultRow } from "@/lib/database.types";

type CardDetailRow = SourceImageRow & {
  projects: ProjectRow;
  processed_images: ProcessedImageRow[] | null;
  yomitoku_results: YomitokuResultRow[] | null;
};

async function loadCard(cardId: string) {
  const supabase = createSupabaseServerClient();

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

  return {
    project: data.projects,
    sourceImage: data,
    processedImage,
    latestResult,
    summaryFields: parseSummary(latestResult?.summary ?? null),
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

  const imagePath = card.processedImage?.storage_path ?? card.sourceImage.storage_path;
  const filename = card.sourceImage.original_filename ?? "名刺";

  const imageUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
    ? `${process.env.NEXT_PUBLIC_SUPABASE_URL}/storage/v1/object/public/${imagePath}`
    : null;

  return (
    <main className="scan-page">
      <Link href="/" style={{ color: "#2563eb", fontWeight: 600, fontSize: "0.95rem" }}>
        ← 名刺一覧へ戻る
      </Link>

      <header style={{ display: "grid", gap: "0.6rem" }}>
        <h1 className="dashboard__title" style={{ margin: 0 }}>
          {filename}
        </h1>
        <p className="muted-text">
          アップロード: {new Date(card.sourceImage.created_at).toLocaleString()} / 最新更新:{" "}
          {new Date(card.sourceImage.updated_at).toLocaleString()}
        </p>
      </header>

      <div className="scan-layout">
        <div className="card" style={{ alignItems: "center", justifyContent: "center" }}>
          <h2 className="card__title" style={{ alignSelf: "flex-start" }}>
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
