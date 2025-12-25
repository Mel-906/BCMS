"use client";

import { useTransition } from "react";

import { deleteCard } from "@/app/projects/actions";

interface DeleteCardButtonProps {
  cardId: string;
  projectId: string;
}

export function DeleteCardButton({ cardId, projectId }: DeleteCardButtonProps) {
  const [isPending, startTransition] = useTransition();

  return (
    <button
      type="button"
      onClick={() => {
        const confirmed = window.confirm(
          "この名刺を削除します。解析結果も含めて削除されます。よろしいですか？",
        );
        if (!confirmed) {
          return;
        }
        startTransition(async () => {
          try {
            await deleteCard(cardId, projectId);
          } catch (error) {
            alert(error instanceof Error ? error.message : "削除に失敗しました。");
          }
        });
      }}
      style={{
        background: "rgba(248, 113, 113, 0.15)",
        color: "#b91c1c",
        border: "none",
        borderRadius: "12px",
        padding: "0.45rem 0.85rem",
        fontWeight: 600,
        cursor: isPending ? "wait" : "pointer",
        opacity: isPending ? 0.65 : 1,
      }}
      disabled={isPending}
    >
      名刺を削除
    </button>
  );
}
