"use client";

import { useState } from "react";

type ProjectOption = {
  id: string;
  title: string;
  user_id: string;
};

interface ScanFormProps {
  projects: ProjectOption[];
}

export function ScanForm({ projects }: ScanFormProps) {
  const [status, setStatus] = useState<"idle" | "uploading" | "success" | "error">("idle");
  const [message, setMessage] = useState<string>("");
  const [selectedProjectId, setSelectedProjectId] = useState<string>(() => projects[0]?.id ?? "");

  if (projects.length === 0) {
    return (
      <div
        style={{
          padding: "1.5rem",
          border: "1px solid rgba(0,0,0,0.12)",
          borderRadius: "12px",
          background: "#fff",
          color: "rgba(0,0,0,0.65)",
        }}
      >
        アップロード可能なプロジェクトがありません。先にプロジェクトを作成してください。
      </div>
    );
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const formData = new FormData(form);
    const file = formData.get("card");
    const projectId = formData.get("projectId")?.toString() || selectedProjectId;

    if (!(file instanceof File) || !projectId) {
      setStatus("error");
      setMessage("ファイルとプロジェクトを選択してください。");
      return;
    }

    const project = projects.find((item) => item.id === projectId);
    if (!project) {
      setStatus("error");
      setMessage("プロジェクト選択が無効です。");
      return;
    }

    try {
      setStatus("uploading");
      setMessage("");
      formData.set("projectId", projectId);
      formData.append("userId", project.user_id);

      const response = await fetch("/api/cards/scan", {
        method: "POST",
        body: formData,
      });

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.message ?? "アップロードに失敗しました。");
      }

      form.reset();
      setSelectedProjectId(projects[0]?.id ?? "");
      setStatus("success");
      setMessage("アップロードが完了しました。解析結果が反映されるまでしばらくお待ちください。");
    } catch (error) {
      const err = error instanceof Error ? error.message : "アップロードに失敗しました。";
      setStatus("error");
      setMessage(err);
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      style={{
        display: "grid",
        gap: "1rem",
        padding: "1.5rem",
        border: "1px solid rgba(0,0,0,0.12)",
        borderRadius: "12px",
        maxWidth: "640px",
        background: "#fff",
      }}
    >
      <div style={{ display: "grid", gap: "0.5rem" }}>
        <label htmlFor="projectId" style={{ fontWeight: 600 }}>
          プロジェクト
        </label>
        <select
          id="projectId"
          name="projectId"
          required
          style={{
            border: "1px solid rgba(0,0,0,0.2)",
            borderRadius: "8px",
            padding: "0.6rem",
            fontSize: "0.95rem",
          }}
          value={selectedProjectId}
          onChange={(event) => {
            setSelectedProjectId(event.target.value);
          }}
        >
          <option value="" disabled>
            選択してください
          </option>
          {projects.map((project) => (
            <option key={project.id} value={project.id}>
              {project.title}
            </option>
          ))}
        </select>
      </div>

      <div style={{ display: "grid", gap: "0.5rem" }}>
        <label htmlFor="card" style={{ fontWeight: 600 }}>
          名刺画像（JPEG/PNG）
        </label>
        <input
          id="card"
          name="card"
          type="file"
          accept="image/*"
          required
          style={{
            border: "1px dashed rgba(0,0,0,0.2)",
            padding: "1rem",
            borderRadius: "8px",
          }}
        />
      </div>

      <button
        type="submit"
        disabled={status === "uploading"}
        style={{
          padding: "0.75rem 1rem",
          background: "#2563eb",
          color: "#fff",
          fontWeight: 600,
          borderRadius: "8px",
          border: "none",
          cursor: status === "uploading" ? "not-allowed" : "pointer",
        }}
      >
        {status === "uploading" ? "アップロード中..." : "アップロード"}
      </button>

      {status !== "idle" && (
        <p
          style={{
            color: status === "success" ? "#15803d" : "#b91c1c",
            fontSize: "0.95rem",
            lineHeight: 1.6,
          }}
        >
          {message}
        </p>
      )}
    </form>
  );
}
