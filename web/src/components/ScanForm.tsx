"use client";

import { useEffect, useRef, useState } from "react";

type ProjectOption = {
  id: string;
  title: string;
  user_id: string;
};

type SelectedItem = {
  id: string;
  file: File;
  previewUrl?: string;
  source: "camera" | "upload";
};

interface ScanFormProps {
  projects: ProjectOption[];
}

export function ScanForm({ projects }: ScanFormProps) {
  const [status, setStatus] = useState<"idle" | "uploading" | "success" | "error">("idle");
  const [message, setMessage] = useState<string>("");
  const [selectedProjectId, setSelectedProjectId] = useState<string>(() => projects[0]?.id ?? "");
  const [selectedItems, setSelectedItems] = useState<SelectedItem[]>([]);
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

  function preprocessCapturedImage(sourceCanvas: HTMLCanvasElement) {
    let working = sourceCanvas;

    if (working.width > working.height) {
      const rotated = document.createElement("canvas");
      rotated.width = working.height;
      rotated.height = working.width;
      const ctx = rotated.getContext("2d");
      if (!ctx) {
        throw new Error("画像の回転に失敗しました。");
      }
      ctx.translate(rotated.width / 2, rotated.height / 2);
      ctx.rotate(Math.PI / 2);
      ctx.drawImage(working, -working.width / 2, -working.height / 2);
      working = rotated;
    }

    const maxDimension = 1600;
    const maxSide = Math.max(working.width, working.height);
    if (maxSide > maxDimension) {
      const scale = maxDimension / maxSide;
      const resized = document.createElement("canvas");
      resized.width = Math.round(working.width * scale);
      resized.height = Math.round(working.height * scale);
      const ctx = resized.getContext("2d");
      if (!ctx) {
        throw new Error("画像のリサイズに失敗しました。");
      }
      ctx.drawImage(working, 0, 0, resized.width, resized.height);
      working = resized;
    }

    const enhanced = document.createElement("canvas");
    enhanced.width = working.width;
    enhanced.height = working.height;
    const ctx = enhanced.getContext("2d");
    if (!ctx) {
      throw new Error("画像の補正に失敗しました。");
    }
    ctx.filter = "brightness(1.05) contrast(1.08) saturate(1.02)";
    ctx.drawImage(working, 0, 0, enhanced.width, enhanced.height);

    return enhanced;
  }

  async function canvasToBlob(canvas: HTMLCanvasElement) {
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (blob) => {
          if (blob) {
            resolve(blob);
          } else {
            reject(new Error("Blob の生成に失敗しました。"));
          }
        },
        "image/jpeg",
        0.9,
      );
    });
  }

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

    const rawCanvas = document.createElement("canvas");
    rawCanvas.width = video.videoWidth;
    rawCanvas.height = video.videoHeight;
    const rawContext = rawCanvas.getContext("2d");
    if (!rawContext) {
      setCameraError("画像の描画に失敗しました。");
      return;
    }

    rawContext.drawImage(video, 0, 0, rawCanvas.width, rawCanvas.height);

    let processedCanvas: HTMLCanvasElement;
    try {
      processedCanvas = preprocessCapturedImage(rawCanvas);
    } catch (error) {
      const err = error instanceof Error ? error.message : "画像の補正に失敗しました。";
      setCameraError(err);
      return;
    }

    const blob = await canvasToBlob(processedCanvas).catch((error) => {
      const err = error instanceof Error ? error.message : "画像の保存に失敗しました。";
      setCameraError(err);
      return null;
    });

    if (!blob) {
      return;
    }

    const timestamp = new Date()
      .toISOString()
      .replace(/[-:T.]/g, "")
      .slice(0, 14);
    const fileName = `camera-${timestamp}.jpg`;
    const file = new File([blob], fileName, {
      type: "image/jpeg",
      lastModified: Date.now(),
    });
    const previewUrl = processedCanvas.toDataURL("image/jpeg", 0.85);
    setSelectedItems((prev) => [
      ...prev,
      {
        id: `${fileName}-${file.lastModified}`,
        file,
        previewUrl,
        source: "camera",
      },
    ]);
    setStatus("success");
    setMessage("カメラで撮影した画像を自動補正して追加しました。");
    stopCamera();
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const projectId = selectedProjectId;
    const items = selectedItems;

    if (items.length === 0 || !projectId) {
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
      for (const item of items) {
        const payload = new FormData();
        payload.set("projectId", projectId);
        payload.append("userId", project.user_id);
        payload.append("card", item.file);

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
      setSelectedItems([]);
      setSelectedProjectId(projectId);
      setStatus("success");
      const uploadedCount = items.length;
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
              setSelectedItems((prev) => prev.filter((item) => item.source === "camera"));
              return;
            }
            const uploads = Array.from(files).map((file) => ({
              id: `${file.name}-${file.lastModified}`,
              file,
              source: "upload" as const,
            }));
            setSelectedItems((prev) => {
              const seen = new Set(prev.map((item) => item.id));
              const merged = uploads.filter((item) => !seen.has(item.id));
              return [...prev, ...merged];
            });
            event.currentTarget.value = "";
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
        <p className="scan-note" style={{ marginTop: "0.5rem" }}>
          カメラ撮影した画像は自動で縦向き補正と明るさ調整を行い、下部にプレビューを表示します。
        </p>
        {cameraError && (
          <p className="form-error" role="alert">
            {cameraError}
          </p>
        )}
        {selectedItems.length > 0 && (
          <div className="selected-files">
            <strong className="selected-files__title">選択中 ({selectedItems.length} 件)</strong>
            <div className="selected-files__grid">
              {selectedItems.map((item) => (
                <div key={item.id} className="selected-files__item">
                  {item.previewUrl ? (
                    <img
                      src={item.previewUrl}
                      alt={`${item.file.name} のプレビュー`}
                      className="selected-files__thumb"
                    />
                  ) : (
                    <div className="selected-files__placeholder">
                      <span>{item.file.name}</span>
                    </div>
                  )}
                  <div className="selected-files__meta">
                    <span className="selected-files__name">{item.file.name}</span>
                    <span className="selected-files__badge">
                      {item.source === "camera" ? "カメラ補正済み" : "ファイル"}
                    </span>
                    <button
                      type="button"
                      className="selected-files__remove"
                      onClick={() => {
                        setSelectedItems((prev) => prev.filter((entry) => entry.id !== item.id));
                      }}
                    >
                      削除
                    </button>
                  </div>
                </div>
              ))}
            </div>
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
