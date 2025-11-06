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
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);

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
    const projectId = selectedProjectId;
    const files = selectedFiles;

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
      const responses = [];
      for (const file of files) {
        const payload = new FormData();
        payload.set("projectId", projectId);
        payload.append("userId", project.user_id);
        payload.append("card", file);

        const response = await fetch("/api/cards/scan", {
          method: "POST",
          body: payload,
        });

        if (!response.ok) {
          const data = await response.json().catch(() => ({}));
          throw new Error(data.message ?? "アップロードに失敗しました。");
        }

        responses.push(await response.json());
      }

      form.reset();
      setSelectedFiles([]);
      setSelectedProjectId(projectId);
      setStatus("success");
      const uploadedCount = files.length;
      setMessage(`アップロードが完了しました（${uploadedCount}件）。解析結果が反映されるまでしばらくお待ちください。`);
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
          onChange={(event) => {
            const files = event.currentTarget.files;
            if (!files) {
              setSelectedFiles([]);
              return;
            }
            setSelectedFiles(Array.from(files));
          }}
        />
        <p className="scan-note">対応形式: JPEG / PNG / HEIC ・ 最大 10MB / 枚 ・ 複数選択可</p>
        {selectedFiles.length > 0 && (
          <div
            style={{
              border: "1px solid rgba(15,23,42,0.1)",
              borderRadius: "12px",
              padding: "0.6rem 0.8rem",
              background: "rgba(59,130,246,0.05)",
              marginTop: "0.5rem",
              display: "grid",
              gap: "0.3rem",
              fontSize: "0.85rem",
            }}
          >
            <strong>選択中 ({selectedFiles.length} 件)</strong>
            <ul style={{ margin: 0, paddingLeft: "1.1rem", display: "grid", gap: "0.15rem" }}>
              {selectedFiles.map((file) => (
                <li key={file.name}>{file.name}</li>
              ))}
            </ul>
          </div>
        )}
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
