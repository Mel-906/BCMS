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
      <div className="card card--compact muted-text">
        アップロード可能なプロジェクトがありません。先にプロジェクトを作成してください。
      </div>
    );
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const formData = new FormData(form);
    const files = formData.getAll("card").filter((item): item is File => item instanceof File);
    const projectId = formData.get("projectId")?.toString() || selectedProjectId;

    if (files.length === 0 || !projectId) {
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
      const payload = new FormData();
      payload.set("projectId", projectId);
      payload.append("userId", project.user_id);
      files.forEach((file) => payload.append("card", file));

      const response = await fetch("/api/cards/scan", {
        method: "POST",
        body: payload,
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
    <form onSubmit={handleSubmit} className="card scan-form">
      <div className="input-control">
        <span style={{ fontWeight: 600 }}>プロジェクト</span>
        <select
          id="projectId"
          name="projectId"
          required
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

      <div className="input-control">
        <span style={{ fontWeight: 600 }}>名刺画像（JPEG/PNG）</span>
        <input
          id="card"
          name="card"
          type="file"
          accept="image/*"
          required
          multiple
        />
        <p className="scan-note">対応形式: JPEG / PNG / HEIC ・ 最大 10MB</p>
      </div>

      <button type="submit" disabled={status === "uploading"} className="primary-button">
        {status === "uploading" ? "アップロード中..." : "解析キューに送信"}
      </button>

      {status !== "idle" && (
        <div className={`alert ${status === "success" ? "alert--success" : "alert--error"}`}>
          {message}
        </div>
      )}
    </form>
  );
}
