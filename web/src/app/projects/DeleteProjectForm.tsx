"use client";

import { useTransition } from "react";

import { deleteProject } from "./actions";

interface DeleteProjectFormProps {
  projectId: string;
}

export function DeleteProjectForm({ projectId }: DeleteProjectFormProps) {
  const [isPending, startTransition] = useTransition();

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        const ok = window.confirm(
          "このプロジェクトを削除します。関連する名刺データも削除されます。よろしいですか？",
        );
        if (!ok) {
          return;
        }
        startTransition(async () => {
          try {
            await deleteProject(projectId);
          } catch (error) {
            alert(error instanceof Error ? error.message : "削除に失敗しました。");
          }
        });
      }}
    >
      <button
        type="submit"
        style={{
          background: "rgba(248, 113, 113, 0.15)",
          color: "#b91c1c",
          border: "none",
          borderRadius: "12px",
          padding: "0.5rem 0.9rem",
          fontWeight: 600,
          cursor: isPending ? "wait" : "pointer",
          opacity: isPending ? 0.7 : 1,
        }}
        disabled={isPending}
      >
        プロジェクトを削除
      </button>
    </form>
  );
}
