import Link from "next/link";

import { createSupabaseServerClient } from "@/lib/supabaseServer";
import { DeleteCardButton } from "@/components/DeleteCardButton";
import type {
  ProcessedImageRow,
  ProjectRow,
  SourceImageRow,
  YomitokuResultRow,
} from "@/lib/database.types";

type CardSummary = {
  project: ProjectRow;
  sourceImage: SourceImageRow;
  processedImage: ProcessedImageRow | null;
  latestResult: Pick<YomitokuResultRow, "id" | "created_at" | "summary" | "confidence"> | null;
  summaryFields: Record<string, string> | null;
};

type CardQueryRow = {
  id: string;
  project_id: string;
  user_id: string;
  storage_path: string;
  original_filename: string | null;
  width: number | null;
  height: number | null;
  format: string | null;
  captured_at: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
  projects: ProjectRow;
  processed_images: ProcessedImageRow[] | null;
  yomitoku_results: YomitokuResultRow[] | null;
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

function buildFilters(params: URLSearchParams) {
  const keyword = params.get("q")?.trim() ?? "";
  const order = params.get("order") ?? "updated";
  const pageParam = params.get("page") ?? "1";
  const page = Number.parseInt(pageParam, 10);
  return {
    keyword,
    order,
    page: Number.isFinite(page) && page > 0 ? page : 1,
  };
}

const MAX_DASHBOARD_CARDS = 30;

async function loadCards(
  searchParams: URLSearchParams,
): Promise<{ cards: CardSummary[]; total: number; projectTotal: number; page: number; error?: string }> {
  const supabase = createSupabaseServerClient();
  const { keyword, order, page } = buildFilters(searchParams);

  const query = supabase
    .from("source_images")
    .select(
      `
        *,
        projects (*),
        processed_images:processed_images!source_image_id (
          id,
          project_id,
          user_id,
          source_image_id,
          storage_path,
          variant,
          params,
          created_at,
          updated_at
        ),
        yomitoku_results:yomitoku_results!source_image_id (
          id,
          source_image_id,
          project_id,
          user_id,
          processed_image_id,
          summary,
          confidence,
          result,
          created_at,
          updated_at
        )
      `,
    )
    .order("created_at", { ascending: false })
    .order("created_at", { referencedTable: "processed_images", ascending: false })
    .limit(1, { referencedTable: "processed_images" })
    .order("created_at", { referencedTable: "yomitoku_results", ascending: false })
    .limit(1, { referencedTable: "yomitoku_results" });

  let data: CardQueryRow[] | null = null;
  let errorMsg: string | null = null;

  try {
    const response = await query;
    data = response.data as CardQueryRow[];
    if (response.error) {
      errorMsg = response.error.message;
    }
  } catch (err) {
    errorMsg = err instanceof Error ? err.message : "Unknown connection error";
    console.error("[ERROR] loadCards fetch failed:", err);
  }

  if (errorMsg) {
    console.warn(`[WARN] Supabase error: ${errorMsg}`);
    // Instead of throwing, we return an empty state with the error info
    return { cards: [], total: 0, projectTotal: 0, page: 1, error: errorMsg };
  }

  const rows: CardQueryRow[] = (data ?? []) as CardQueryRow[];
  const cards = rows.map((row) => {
    const processedImage = Array.isArray(row.processed_images)
      ? row.processed_images[0] ?? null
      : null;
    const latestResultFull = Array.isArray(row.yomitoku_results)
      ? row.yomitoku_results[0] ?? null
      : null;
    const summaryFields = parseSummary(latestResultFull?.summary ?? null);

    return {
      project: row.projects,
      sourceImage: {
        id: row.id,
        project_id: row.project_id,
        user_id: row.user_id,
        storage_path: row.storage_path,
        original_filename: row.original_filename,
        width: row.width,
        height: row.height,
        format: row.format,
        captured_at: row.captured_at,
        metadata: row.metadata,
        created_at: row.created_at,
        updated_at: row.updated_at,
      },
      processedImage,
      latestResult: latestResultFull
        ? {
          id: latestResultFull.id,
          created_at: latestResultFull.created_at,
          summary: latestResultFull.summary,
          confidence: latestResultFull.confidence,
        }
        : null,
      summaryFields,
    };
  });

  let filtered = cards;
  if (keyword) {
    const normalized = keyword.toLowerCase();
    filtered = cards.filter((card) => {
      const summaryValues = card.summaryFields ? Object.values(card.summaryFields) : [];
      const haystack = [
        card.sourceImage.original_filename ?? "",
        card.project.title ?? "",
        card.project.description ?? "",
        ...summaryValues,
      ]
        .filter(Boolean)
        .map((value) => value.toLowerCase());
      return haystack.some((value) => value.includes(normalized));
    });
  }

  filtered.sort((a, b) => {
    if (order === "created") {
      return (
        new Date(b.sourceImage.created_at).getTime() -
        new Date(a.sourceImage.created_at).getTime()
      );
    }
    const aTime = new Date(a.sourceImage.updated_at ?? a.sourceImage.created_at).getTime();
    const bTime = new Date(b.sourceImage.updated_at ?? b.sourceImage.created_at).getTime();
    return bTime - aTime;
  });

  const total = filtered.length;
  const projectTotal = new Set(filtered.map((item) => item.project.id)).size;
  const start = (page - 1) * MAX_DASHBOARD_CARDS;
  const limited = filtered.slice(start, start + MAX_DASHBOARD_CARDS);
  return { cards: limited, total, projectTotal, page };
}

function SearchPanel({ searchParams }: { searchParams: URLSearchParams }) {
  const { keyword, order } = buildFilters(searchParams);
  const orderOptions = [
    { value: "updated", label: "最近更新された順" },
    { value: "created", label: "アップロード順" },
  ];

  return (
    <div className="card">
      <h2 className="card__title">名刺を検索</h2>
      <p className="muted-text">氏名・会社・メールアドレス・メモを横断検索できます。</p>

      <form className="search-panel">
        <div className="search-panel__row">
          <label className="input-control">
            <span>キーワード</span>
            <input name="q" defaultValue={keyword} placeholder="例: 山田 / SaaS / 投資家" />
          </label>
          <label className="input-control">
            <span>並び順</span>
            <select name="order" defaultValue={order}>
              {orderOptions.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <button type="submit" className="primary-button">
            検索する
          </button>
        </div>
      </form>
    </div>
  );
}

function UploadPanel({ projectsCount }: { projectsCount: number }) {
  return (
    <div className="card">
      <h2 className="card__title">名刺をアップロード</h2>
      <p className="muted-text">
        表面の画像を登録すると OCR が文字を抽出し、Supabase に保存した解析結果がダッシュボードに反映されます。
      </p>

      <div className="upload-steps">
        <div className="upload-step">
          <strong>表面（必須）</strong>
          <span>画像をクリックして選択、またはドラッグ＆ドロップしてください。</span>
          <span>対応形式: JPEG / PNG / HEIC ・ 最大 10MB</span>
        </div>
        <div className="upload-step">
          <strong>裏面（任意）</strong>
          <span>裏面にメモや英語版がある場合は追加してください。</span>
          <span>対応形式: JPEG / PNG / HEIC ・ 最大 10MB</span>
        </div>
      </div>

      <Link href="/scan" className="primary-button" style={{ textDecoration: "none" }}>
        新規キューに送信
      </Link>

      <p className="scan-note">
        プロジェクト数: {projectsCount} 件。アップロード後は `/projects/ID/manage` から内容を編集できます。
      </p>
    </div>
  );
}

function SummaryPanel({
  projects,
  cards,
  recentUpdated,
}: {
  projects: number;
  cards: number;
  recentUpdated: string | null;
}) {
  return (
    <div className="card card--compact">
      <h2 className="card__title">活動状況サマリー</h2>
      <div className="stats-grid">
        <div className="stats-item">
          <span className="stats-item__label">プロジェクト数</span>
          <span className="stats-item__value">{projects}</span>
        </div>
        <div className="stats-item">
          <span className="stats-item__label">名刺枚数</span>
          <span className="stats-item__value">{cards}</span>
        </div>
        <div className="stats-item">
          <span className="stats-item__label">最終更新</span>
          <span className="stats-item__value">
            {recentUpdated ? recentUpdated : "—"}
          </span>
        </div>
      </div>
      <p className="muted-text">
        DatabaseAgent が統計情報を算出し、フォローアップが必要な名刺をピックアップします。
      </p>
    </div>
  );
}

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const resolved = await searchParams;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(resolved)) {
    if (Array.isArray(value)) {
      value.forEach((v) => params.append(key, v));
    } else if (value !== undefined) {
      params.set(key, value);
    }
  }

  const { cards, total, projectTotal, page, error: loadError } = await loadCards(params);
  const totalCards = total;
  const projectCount = projectTotal;
  const recentUpdated =
    cards
      .map((item) => item.sourceImage.updated_at ?? item.sourceImage.created_at)
      .filter(Boolean)
      .map((date) => new Date(date).getTime())
      .sort((a, b) => b - a)[0] ?? null;

  const recentUpdatedLabel = recentUpdated
    ? new Date(recentUpdated).toLocaleString()
    : null;
  const showingStart = totalCards === 0 ? 0 : (page - 1) * MAX_DASHBOARD_CARDS + 1;
  const showingEnd = showingStart === 0 ? 0 : showingStart + cards.length - 1;
  const hasNext = page * MAX_DASHBOARD_CARDS < totalCards;
  const hasPrev = page > 1;

  const createPageLink = (targetPage: number) => {
    const nextParams = new URLSearchParams(params);
    if (targetPage <= 1) {
      nextParams.delete("page");
    } else {
      nextParams.set("page", String(targetPage));
    }
    const query = nextParams.toString();
    return query ? `/?${query}` : "/";
  };

  return (
    <main className="dashboard">
      <h1 className="dashboard__title">名刺管理ダッシュボード</h1>

      {loadError && (
        <div style={{
          backgroundColor: "#fee2e2",
          border: "1px solid #ef4444",
          color: "#991b1b",
          padding: "1rem",
          borderRadius: "0.5rem",
          marginBottom: "1.5rem",
          fontSize: "0.95rem"
        }}>
          <strong>⚠️ 接続エラー:</strong> Supabase への接続に失敗しました。{loadError}<br />
          DNS 設定、または Supabase プロジェクトの状態をご確認ください。
        </div>
      )}

      <div className="dashboard__grid">
        <section className="dashboard__main">
          <SearchPanel searchParams={params} />

          <div className="card">
            <h2 className="card__title">
              名刺一覧{" "}
              <span style={{ fontSize: "0.9rem", color: "rgba(15,23,42,0.55)" }}>
                ({cards.length} 件 / 全 {totalCards} 件)
              </span>
            </h2>

            {cards.length === 0 ? (
              totalCards > 0 ? (
                <p className="muted-text">
                  このページには表示できる名刺がありません。検索条件を変更するか前のページをご確認ください。
                </p>
              ) : (
                <p className="muted-text">
                  解析済みの名刺がまだありません。`preprocess_images.py` と `yomitoku.py` を Supabase 連携で実行すると、ここに一覧が表示されます。
                </p>
              )
            ) : (
              <div className="project-list">
                <p className="muted-text">
                  全 {totalCards} 件中 {showingStart}〜{showingEnd} 件を表示しています。
                </p>
                {cards.map((card) => {
                  const latestSummary = card.summaryFields;
                  const name =
                    latestSummary?.["名前"] ||
                    latestSummary?.["名前（英語）"] ||
                    card.sourceImage.original_filename ||
                    "名称未設定";
                  const organization = latestSummary?.["所属"] ?? "";
                  const email = latestSummary?.["e-mail"] ?? "";
                  const phone = latestSummary?.["Tel"] ?? "";
                  const memo = latestSummary?.["その他"] ?? "";
                  const projectTimestamp = new Date(
                    card.project.updated_at ?? card.project.created_at,
                  ).toLocaleString();

                  return (
                    <div key={card.sourceImage.id} className="project-card">
                      <Link
                        href={`/cards/${card.sourceImage.id}`}
                        className="project-card__link"
                        style={{ textDecoration: "none" }}
                      >
                        <div className="project-card__top">
                          <div>
                            <h3 className="project-card__title">{name}</h3>
                            <p className="muted-text project-card__subtitle">
                              {organization || "所属情報なし"}
                            </p>
                            <p className="muted-text" style={{ fontSize: "0.85rem", marginTop: "0.25rem" }}>
                              プロジェクト: {card.project.title}
                            </p>
                          </div>
                          <div className="project-card__badges">
                            <span className="badge badge--primary">
                              Project {projectTimestamp}
                            </span>
                            <span className="badge badge--secondary">
                              {card.processedImage ? "前処理済み" : "原本のみ"}
                            </span>
                          </div>
                        </div>

                        <div className="project-card__meta">
                          <span>
                            アップロード {new Date(card.sourceImage.created_at).toLocaleDateString()}
                          </span>
                          <span>
                            最新解析{" "}
                            {card.latestResult
                              ? new Date(card.latestResult.created_at).toLocaleDateString()
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

                        {memo && (
                          <p className="project-card__memo">
                            メモ: {memo}
                          </p>
                        )}
                      </Link>
                      <div style={{ marginTop: "0.75rem", display: "flex", justifyContent: "flex-end" }}>
                        <DeleteCardButton cardId={card.sourceImage.id} projectId={card.project.id} />
                      </div>
                    </div>
                  );
                })}
                <div className="pagination">
                  <span className="pagination__info">
                    ページ {page} / {Math.max(1, Math.ceil(totalCards / MAX_DASHBOARD_CARDS))}
                  </span>
                  <div className="pagination__controls">
                    <Link
                      href={createPageLink(page - 1)}
                      className={`pagination__link${hasPrev ? "" : " pagination__link--disabled"}`}
                    >
                      前へ
                    </Link>
                    <Link
                      href={createPageLink(page + 1)}
                      className={`pagination__link${hasNext ? "" : " pagination__link--disabled"}`}
                    >
                      次へ
                    </Link>
                  </div>
                </div>
              </div>
            )}
          </div>
        </section>

        <aside className="dashboard__side">
          <UploadPanel projectsCount={projectCount} />
          <SummaryPanel projects={projectCount} cards={totalCards} recentUpdated={recentUpdatedLabel} />
        </aside>
      </div>
    </main>
  );
}
