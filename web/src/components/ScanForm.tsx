"use client";

import { useEffect, useRef, useState } from "react";

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
  const [isCameraOpen, setIsCameraOpen] = useState(false);
  const [isCameraReady, setIsCameraReady] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  if (projects.length === 0) {
    return (
      <div className="card card--compact muted-text">
        アップロード可能なプロジェクトがありません。先にプロジェクトを作成してください。
      </div>
    );
  }

  useEffect(() => {
    return () => {
      stopCamera();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function startCamera() {
    if (!navigator.mediaDevices?.getUserMedia) {
      setCameraError("ブラウザがカメラ撮影に対応していません。別のブラウザをご利用ください。");
      return;
    }

    try {
      stopCamera({ resetError: false });
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: "environment" },
        },
      });
      streamRef.current = stream;
      setCameraError(null);
      setIsCameraReady(false);
      setIsCameraOpen(true);
    } catch (error) {
      let friendly = "カメラを起動できませんでした。接続状況やブラウザ設定をご確認ください。";
      if (error instanceof DOMException) {
        if (error.name === "NotAllowedError") {
          friendly = "カメラの使用が許可されていません。ブラウザの権限設定を確認し、ページを再読み込みしてください。";
        } else if (error.name === "NotFoundError" || error.name === "OverconstrainedError") {
          friendly = "利用可能なカメラが見つかりません。外付けカメラの接続や他のアプリでの使用状況を確認してください。";
        }
      } else if (error instanceof Error) {
        friendly = error.message;
      }
      setCameraError(friendly);
      stopCamera({ resetError: false });
    }
  }

  function stopCamera({ resetError = true }: { resetError?: boolean } = {}) {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
    setIsCameraOpen(false);
    setIsCameraReady(false);
    if (resetError) {
      setCameraError(null);
    }
  }

  useEffect(() => {
    if (!isCameraOpen) {
      return;
    }

    const video = videoRef.current;
    const stream = streamRef.current;
    if (!video || !stream) {
      return;
    }

    video.srcObject = stream;
    const handleLoaded = () => {
      setIsCameraReady(true);
    };
    video.addEventListener("loadedmetadata", handleLoaded, { once: true });
    const playPromise = video.play();
    if (playPromise instanceof Promise) {
      playPromise.catch((error) => {
        const err = error instanceof Error ? error.message : "カメラ映像を表示できません。";
        setCameraError(err);
        stopCamera();
      });
    }

    return () => {
      video.pause();
      video.srcObject = null;
      video.removeEventListener("loadedmetadata", handleLoaded);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isCameraOpen]);

  async function capturePhoto() {
    if (!isCameraReady) {
      setCameraError("カメラの準備が完了していません。数秒お待ちください。");
      return;
    }

    const video = videoRef.current;
    if (!video || video.videoWidth === 0 || video.videoHeight === 0) {
      setCameraError("カメラの準備が完了していません。もう一度お試しください。");
      return;
    }

    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const context = canvas.getContext("2d");
    if (!context) {
      setCameraError("画像の描画に失敗しました。");
      return;
    }

    context.drawImage(video, 0, 0, canvas.width, canvas.height);

    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((result) => {
        if (result) {
          resolve(result);
        } else {
          reject(new Error("画像の保存に失敗しました。"));
        }
      }, "image/jpeg", 0.9);
    }).catch((error) => {
      const err = error instanceof Error ? error.message : "画像の保存に失敗しました。";
      setCameraError(err);
      return null;
    });

    if (!blob) {
      return;
    }

    const timestamp = new Date().toISOString().replace(/[-:T.]/g, "").slice(0, 14);
    const file = new File([blob], `camera-${timestamp}.jpg`, { type: "image/jpeg" });
    setSelectedFiles((prev) => [...prev, file]);
    setStatus("success");
    setMessage("カメラで撮影した画像を追加しました。");
    stopCamera();
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
        <div className="scan-actions">
          <button
            type="button"
            className="secondary-button"
            onClick={() => {
              setMessage("");
              setStatus("idle");
              startCamera();
            }}
          >
            カメラで撮影
          </button>
        </div>
        {cameraError && (
          <p className="form-error" role="alert">
            {cameraError}
          </p>
        )}
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

      {isCameraOpen && (
        <div className="camera-overlay" role="dialog" aria-modal="true">
          <div className="camera-modal">
            <video
              ref={videoRef}
              className="camera-modal__video"
              playsInline
              autoPlay
              muted
            />
            {!isCameraReady && !cameraError ? (
              <p className="muted-text" style={{ textAlign: "center" }}>
                カメラを初期化しています…
              </p>
            ) : null}
            <div className="camera-modal__actions">
              <button
                type="button"
                className="primary-button"
                onClick={capturePhoto}
                disabled={!isCameraReady}
              >
                {isCameraReady ? "撮影して追加" : "準備中"}
              </button>
              <button type="button" className="secondary-button" onClick={() => stopCamera()}>
                キャンセル
              </button>
            </div>
            {cameraError && (
              <p className="form-error" role="alert">
                {cameraError}
              </p>
            )}
          </div>
        </div>
      )}
    </form>
  );
}
