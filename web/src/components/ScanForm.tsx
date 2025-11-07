"use client";

import { ChangeEvent, FormEvent, useEffect, useRef, useState } from "react";

type ProjectOption = {
  id: string;
  title: string;
  user_id: string;
};

type SelectedItem = {
  id: string;
  key: string;
  file: File;
  previewUrl?: string;
  rotation: number;
  source: "camera" | "upload";
  revokePreview?: boolean;
};

interface ScanFormProps {
  projects: ProjectOption[];
}

export function ScanForm({ projects }: ScanFormProps) {
  const [status, setStatus] = useState<"idle" | "uploading" | "success" | "error">("idle");
  const [message, setMessage] = useState<string>("");
  const [selectedProjectId, setSelectedProjectId] = useState<string>(() => projects[0]?.id ?? "");
  const [selectedItems, setSelectedItems] = useState<SelectedItem[]>([]);
  const [rotatingId, setRotatingId] = useState<string | null>(null);
  const [isCameraOpen, setIsCameraOpen] = useState(false);
  const [isCameraReady, setIsCameraReady] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const selectedItemsRef = useRef<SelectedItem[]>([]);

  useEffect(() => {
    return () => {
      stopCamera();
    };
  }, []);

  useEffect(() => {
    selectedItemsRef.current = selectedItems;
  }, [selectedItems]);

  useEffect(() => {
    return () => {
      selectedItemsRef.current.forEach((item) => cleanupPreview(item));
    };
  }, []);

  function cleanupPreview(item: SelectedItem) {
    if (item.revokePreview && item.previewUrl) {
      URL.revokeObjectURL(item.previewUrl);
    }
  }

  function isHeicFile(file: File) {
    const lower = file.name.toLowerCase();
    return (
      file.type === "image/heic" ||
      file.type === "image/heif" ||
      lower.endsWith(".heic") ||
      lower.endsWith(".heif")
    );
  }

  async function convertHeicToJpeg(file: Blob): Promise<Blob | null> {
    try {
      const heic2any = (await import("heic2any")).default as unknown as (
        options: Record<string, unknown>,
      ) => Promise<Blob | Blob[]>;
      const converted = await heic2any({
        blob: file,
        toType: "image/jpeg",
        quality: 0.9,
      });
      const blob = Array.isArray(converted) ? converted[0] : converted;
      return blob instanceof Blob ? blob : null;
    } catch (error) {
      console.error("[scan] Failed to convert HEIC image", error);
      return null;
    }
  }

  function selectOutputType(type: string | undefined): "image/jpeg" | "image/png" | "image/webp" {
    if (type === "image/png") {
      return "image/png";
    }
    if (type === "image/webp") {
      return "image/webp";
    }
    return "image/jpeg";
  }

  function ensureFileExtension(fileName: string, mime: string) {
    const map: Record<string, string> = {
      "image/jpeg": ".jpg",
      "image/png": ".png",
      "image/webp": ".webp",
    };
    const desired = map[mime] ?? ".jpg";
    const lower = fileName.toLowerCase();
    if (lower.endsWith(desired)) {
      return fileName;
    }
    const dotIndex = lower.lastIndexOf(".");
    if (dotIndex === -1) {
      return `${fileName}${desired}`;
    }
    return `${fileName.slice(0, dotIndex)}${desired}`;
  }

  async function rotateFileClockwise(
    file: File,
  ): Promise<{ file: File; previewUrl: string; revokePreview: boolean }> {
    const baseBlob = isHeicFile(file) ? await convertHeicToJpeg(file) : file;
    if (!baseBlob) {
      throw new Error("HEIC 画像の回転処理に失敗しました。");
    }

    let bitmap: ImageBitmap;
    try {
      bitmap = await createImageBitmap(baseBlob);
    } catch (error) {
      console.error("[scan] Failed to decode image for rotation", error);
      throw new Error("画像の読み込みに失敗しました。別のブラウザでお試しください。");
    }

    const canvas = document.createElement("canvas");
    canvas.width = bitmap.height;
    canvas.height = bitmap.width;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      bitmap.close();
      throw new Error("画像の回転に失敗しました。");
    }

    ctx.translate(canvas.width / 2, canvas.height / 2);
    ctx.rotate(Math.PI / 2);
    ctx.drawImage(bitmap, -bitmap.width / 2, -bitmap.height / 2);
    bitmap.close();

    const preferredType = selectOutputType(baseBlob.type || file.type);
    let rotatedBlob: Blob;
    try {
      rotatedBlob = await canvasToBlob(canvas, {
        type: preferredType,
        quality: preferredType === "image/jpeg" ? 0.9 : undefined,
      });
    } catch (error) {
      if (preferredType !== "image/jpeg") {
        rotatedBlob = await canvasToBlob(canvas, { type: "image/jpeg", quality: 0.9 });
      } else {
        throw error;
      }
    }

    const mime = rotatedBlob.type || "image/jpeg";
    const rotatedFile = new File([rotatedBlob], ensureFileExtension(file.name, mime), {
      type: mime,
      lastModified: Date.now(),
    });
    const previewUrl = URL.createObjectURL(rotatedBlob);

    return {
      file: rotatedFile,
      previewUrl,
      revokePreview: true,
    };
  }

  function updateSelectedItems(updater: (prev: SelectedItem[]) => SelectedItem[]) {
    setSelectedItems((prev) => {
      const next = updater(prev);
      const nextIds = new Set(next.map((item) => item.id));
      prev.forEach((item) => {
        if (!nextIds.has(item.id)) {
          cleanupPreview(item);
        }
      });
      return next;
    });
  }

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
  }, [isCameraOpen]);

  async function generatePreview(file: File): Promise<{ url?: string; revoke: boolean }> {
    if (isHeicFile(file)) {
      const blob = await convertHeicToJpeg(file);
      if (blob) {
        const url = URL.createObjectURL(blob);
        return { url, revoke: true };
      }
      return { url: undefined, revoke: false };
    }

    return { url: URL.createObjectURL(file), revoke: true };
  }

  async function createUploadItem(file: File): Promise<SelectedItem> {
    const key = `${file.name}-${file.size}-${file.lastModified}`;
    const preview = await generatePreview(file);
    return {
      id: `${key}-upload`,
      key,
      file,
      previewUrl: preview.url,
      rotation: 0,
      source: "upload",
      revokePreview: preview.revoke,
    };
  }

  function createCameraItem(file: File, previewUrl: string): SelectedItem {
    const key = `${file.name}-${file.size}-${file.lastModified}`;
    return {
      id: `${key}-camera`,
      key,
      file,
      previewUrl,
      rotation: 0,
      source: "camera",
      revokePreview: false,
    };
  }

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

  async function canvasToBlob(
    canvas: HTMLCanvasElement,
    options: { type?: string; quality?: number } = {},
  ) {
    const { type = "image/jpeg", quality } = options;
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (blob) => {
          if (blob) {
            resolve(blob);
          } else {
            reject(new Error("Blob の生成に失敗しました。"));
          }
        },
        type,
        quality,
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

    const blob = await canvasToBlob(processedCanvas, { type: "image/jpeg", quality: 0.9 }).catch((error) => {
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
    const item = createCameraItem(file, previewUrl);
    updateSelectedItems((prev) => {
      const withoutDup = prev.filter((entry) => entry.key !== item.key);
      return [...withoutDup, item];
    });
    setStatus("success");
    setMessage("カメラで撮影した画像を自動補正して追加しました。");
    stopCamera();
  }

  function handleRemoveItem(itemId: string) {
    updateSelectedItems((prev) => prev.filter((item) => item.id !== itemId));
  }

  async function handleRotateItem(itemId: string) {
    const target = selectedItemsRef.current.find((item) => item.id === itemId);
    if (!target) {
      return;
    }

    setRotatingId(itemId);
    try {
      const rotated = await rotateFileClockwise(target.file);
      let previousPreview: string | undefined;
      const shouldRevokePrevious = target.revokePreview && target.previewUrl;

      updateSelectedItems((prev) =>
        prev.map((item) => {
          if (item.id !== itemId) {
            return item;
          }
          if (shouldRevokePrevious && item.previewUrl) {
            previousPreview = item.previewUrl;
          }
          return {
            ...item,
            file: rotated.file,
            previewUrl: rotated.previewUrl,
            rotation: (item.rotation + 1) % 4,
            revokePreview: rotated.revokePreview,
          };
        }),
      );

      if (previousPreview) {
        URL.revokeObjectURL(previousPreview);
      }
    } catch (error) {
      const err = error instanceof Error ? error.message : "画像の回転に失敗しました。";
      setStatus("error");
      setMessage(err);
    } finally {
      setRotatingId(null);
    }
  }

  async function handleFileInput(event: ChangeEvent<HTMLInputElement>) {
    const { files } = event.currentTarget;

    if (!files || files.length === 0) {
      updateSelectedItems((prev) => prev.filter((item) => item.source === "camera"));
      return;
    }

    const newItems = await Promise.all(Array.from(files).map((file) => createUploadItem(file)));
    updateSelectedItems((prev) => {
      const existingKeys = new Set(prev.map((item) => item.key));
      const deduped = newItems.filter((item) => !existingKeys.has(item.key));
      return [...prev, ...deduped];
    });
    event.currentTarget.value = "";
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const projectId = selectedProjectId;
    const items = selectedItemsRef.current;

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

    if (!project.user_id) {
      setStatus("error");
      setMessage("選択したプロジェクトにユーザーIDが設定されていません。/projects の管理画面で編集してください。");
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
      updateSelectedItems(() => []);
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

  if (projects.length === 0) {
    return (
      <div className="card card--compact muted-text">
        アップロード可能なプロジェクトがありません。先にプロジェクトを作成してください。
      </div>
    );
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
          accept="image/*,.heic,.heif"
          multiple
          onChange={handleFileInput}
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
          プレビューの「回転」ボタンで向きを調整できます。カメラ撮影画像には明るさ補正を自動適用します。
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
                    // eslint-disable-next-line @next/next/no-img-element
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
                    <div className="selected-files__actions">
                      <button
                        type="button"
                        className="selected-files__rotate"
                        onClick={() => handleRotateItem(item.id)}
                        disabled={rotatingId === item.id}
                        title="時計回りに90°回転"
                      >
                        回転
                      </button>
                      <button
                        type="button"
                        className="selected-files__remove"
                        onClick={() => handleRemoveItem(item.id)}
                      >
                        削除
                      </button>
                    </div>
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
