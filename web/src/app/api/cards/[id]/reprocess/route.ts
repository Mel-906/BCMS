"use server";

import { NextRequest, NextResponse } from "next/server";
import os from "os";
import path from "path";
import { execFile, spawn } from "child_process";
import { promises as fs } from "fs";
import { promisify } from "util";

import { createSupabaseServerClient } from "@/lib/supabaseServer";

const PYTHON_BIN = process.env.PYTHON_BIN;
const execFileAsync = promisify(execFile);

async function resolveCandidate(candidate: string): Promise<string | null> {
  try {
    if (candidate.includes(path.sep) || candidate.startsWith(".")) {
      await fs.access(candidate);
      return candidate;
    }

    const resolver = process.platform === "win32" ? "where" : "which";
    const { stdout } = await execFileAsync(resolver, [candidate]);
    const resolved = stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0);

    if (resolved) {
      return resolved;
    }
  } catch {
    // try next candidate
  }

  return null;
}

async function resolvePythonExecutable(projectRoot: string): Promise<string> {
  const candidates = [
    PYTHON_BIN,
    path.join(projectRoot, ".venv", "bin", "python"),
    path.join(projectRoot, ".venv", "Scripts", "python.exe"),
    "python3",
    "python",
  ].filter(Boolean) as string[];

  for (const candidate of candidates) {
    const resolved = await resolveCandidate(candidate);
    if (resolved) {
      return resolved;
    }
  }

  throw new Error("Python executable not found. Set PYTHON_BIN or ensure .venv exists.");
}

function runCommand(command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }) {
  return new Promise<void>((resolve, reject) => {
    const proc = spawn(command, args, options);
    let stderr = "";
    proc.stdout.on("data", (chunk) => process.stdout.write(chunk));
    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
      process.stderr.write(chunk);
    });
    proc.on("error", (err) => reject(err));
    proc.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Command failed: ${command} ${args.join(" ")}\n${stderr}`));
      }
    });
  });
}

async function downloadSourceFile(cardId: string) {
  const supabase = createSupabaseServerClient();

  const { data, error } = await supabase
    .from("source_images")
    .select("id, project_id, user_id, storage_path, original_filename")
    .eq("id", cardId)
    .maybeSingle();

  if (error) {
    throw new Error(error.message);
  }

  if (!data) {
    throw new Error("カードが見つかりません。");
  }

  if (!data.project_id) {
    throw new Error("カードに関連付けられたプロジェクトが存在しません。");
  }

  if (!data.user_id) {
    throw new Error("カードにユーザー ID が設定されていません。/projects の管理画面から設定してください。");
  }

  const storagePath = data.storage_path;
  if (!storagePath) {
    throw new Error("元画像のストレージパスが空です。");
  }

  const [bucket, ...objectParts] = storagePath.split("/");
  const objectPath = objectParts.join("/");
  if (!bucket || !objectPath) {
    throw new Error(`無効なストレージパスです: ${storagePath}`);
  }

  const download = await supabase.storage.from(bucket).download(objectPath);
  if (download.error) {
    throw new Error(download.error.message);
  }
  const blob = download.data;
  if (!blob) {
    throw new Error("元画像のダウンロードに失敗しました。");
  }
  const arrayBuffer = await blob.arrayBuffer();

  return {
    record: data,
    buffer: Buffer.from(arrayBuffer),
  };
}

export async function POST(
  _request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id: cardId } = await context.params;
    if (!cardId) {
      return NextResponse.json({ message: "カード ID が指定されていません。" }, { status: 400 });
    }

    const { record, buffer } = await downloadSourceFile(cardId);
    const projectRoot = path.resolve(process.cwd(), "..");
    const pythonExecutable = await resolvePythonExecutable(projectRoot);

    let tmpDir: string | null = null;
    try {
      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "bcms-reprocess-"));
      const safeName = record.original_filename?.replace(/\s+/g, "_") || `${record.id}.jpg`;
      const originalPath = path.join(tmpDir, safeName);
      const outputDir = path.join(tmpDir, `${safeName}-processed`);

      await fs.mkdir(outputDir, { recursive: true });
      await fs.writeFile(originalPath, buffer);

      const preprocessArgs = [
        path.join(projectRoot, "preprocess_images.py"),
        originalPath,
        "--output-dir",
        outputDir,
        "--record-to-db",
        "--user-id",
        record.user_id,
        "--project-id",
        record.project_id,
      ];

      await runCommand(pythonExecutable, preprocessArgs, {
        cwd: projectRoot,
        env: { ...process.env },
      });

      const manifestPath = path.join(outputDir, "manifest.json");
      const manifestRaw = await fs.readFile(manifestPath, "utf-8");
      const manifest = JSON.parse(manifestRaw) as {
        entries: Array<{ processed_image_id?: string }>;
      };

      const yomitokuArgs = [
        path.join(projectRoot, "yomitoku.py"),
        outputDir,
        "--record-to-db",
        "--manifest",
        manifestPath,
        "--user-id",
        record.user_id,
        "--project-id",
        record.project_id,
      ];

      await runCommand(pythonExecutable, yomitokuArgs, {
        cwd: projectRoot,
        env: { ...process.env },
      });

      console.log(
        `[INFO] Reprocessed card ${record.id}. Records: ${manifest.entries?.length ?? 0}`,
      );
    } finally {
      if (tmpDir) {
        fs.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
      }
    }

    return NextResponse.json(
      { message: "再解析ジョブを開始しました。数分後に結果を確認してください。" },
      { status: 202 },
    );
  } catch (error) {
    const err = error instanceof Error ? error.message : "Unexpected error";
    return NextResponse.json({ message: err }, { status: 500 });
  }
}
