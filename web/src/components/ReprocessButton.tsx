"use client";

import { useState } from "react";

type ReprocessButtonProps = {
  cardId: string;
  hasResult: boolean;
};

type StatusState = "idle" | "pending" | "success" | "error";

export function ReprocessButton({ cardId, hasResult }: ReprocessButtonProps) {
  const [status, setStatus] = useState<StatusState>("idle");
  const [message, setMessage] = useState<string>("");

  async function triggerReprocess() {
    if (!cardId) {
      return;
    }

    setStatus("pending");
    setMessage("再解析ジョブを開始しています…");

    try {
      const response = await fetch(`/api/cards/${cardId}/reprocess`, {
        method: "POST",
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data.message ?? "再解析に失敗しました。");
      }

      setStatus("success");
      setMessage(data.message ?? "再解析ジョブを開始しました。数分後に結果を確認してください。");
    } catch (error) {
      const err = error instanceof Error ? error.message : "再解析に失敗しました。";
      setStatus("error");
      setMessage(err);
    }
  }

  const buttonLabel =
    status === "pending" ? "再解析中…" : hasResult ? "再解析を実行" : "解析を実行";

  return (
    <div style={{ display: "grid", gap: "0.5rem", maxWidth: "420px" }}>
      <button
        type="button"
        className="secondary-button"
        onClick={triggerReprocess}
        disabled={status === "pending"}
      >
        {buttonLabel}
      </button>

      {status === "pending" ? (
        <p className="muted-text">{message}</p>
      ) : null}

      {status === "success" ? (
        <div className="alert alert--success">{message}</div>
      ) : null}

      {status === "error" ? (
        <div className="alert alert--error">{message}</div>
      ) : null}
    </div>
  );
}
