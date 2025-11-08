"use server";

import { NextRequest, NextResponse } from "next/server";
import os from "os";
import path from "path";
import { execFile, spawn } from "child_process";
import { promises as fs } from "fs";
import { promisify } from "util";

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

async function processSingleFile({
  file,
  projectId,
  userId,
  projectRoot,
  pythonExecutable,
}: {
  file: File;
  projectId: string;
  userId: string;
  projectRoot: string;
  pythonExecutable: string;
}) {
  let tmpDir: string | null = null;
  try {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "bcms-upload-"));
    const safeName = file.name.replace(/\s+/g, "_") || `${Date.now()}.jpg`;
    const originalPath = path.join(tmpDir, safeName);
    const outputDir = path.join(tmpDir, `${safeName}-processed`);

    await fs.mkdir(outputDir, { recursive: true });
    await fs.writeFile(originalPath, Buffer.from(await file.arrayBuffer()));

    const preprocessArgs = [
      path.join(projectRoot, "preprocess_images.py"),
      originalPath,
      "--output-dir",
      outputDir,
      "--record-to-db",
      "--user-id",
      userId,
      "--project-id",
      projectId,
    ];

    await runCommand(pythonExecutable, preprocessArgs, {
      cwd: projectRoot,
      env: { ...process.env },
    });

    const manifestPath = path.join(outputDir, "manifest.json");
    const manifestRaw = await fs.readFile(manifestPath, "utf-8");
    const manifest = JSON.parse(manifestRaw) as {
      entries: Array<{
        source_image_id: string;
        source_storage_path: string;
        processed_image_id?: string;
      }>;
    };

    const yomitokuArgs = [
      path.join(projectRoot, "yomitoku.py"),
      outputDir,
      "--record-to-db",
      "--manifest",
      manifestPath,
      "--user-id",
      userId,
      "--project-id",
      projectId,
    ];

    await runCommand(pythonExecutable, yomitokuArgs, {
      cwd: projectRoot,
      env: { ...process.env },
    });

    console.log(
      `[INFO] Completed OCR pipeline for ${safeName}. Records: ${manifest.entries?.length ?? 0}`,
    );
  } catch (error) {
    console.error("[ERROR] Failed to process file:", file.name, error);
  } finally {
    if (tmpDir) {
      fs.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const files = formData.getAll("card").filter((item): item is File => item instanceof File);
    const projectId = formData.get("projectId");
    const userId = formData.get("userId") ?? request.headers.get("x-user-id");

    if (files.length === 0) {
      return NextResponse.json({ message: "ファイルが選択されていません。" }, { status: 400 });
    }

    if (!projectId || typeof projectId !== "string") {
      return NextResponse.json({ message: "プロジェクトを選択してください。" }, { status: 400 });
    }

    if (!userId || typeof userId !== "string") {
      return NextResponse.json(
        { message: "userId が見つかりません。フォームまたはヘッダーに付与してください。" },
        { status: 400 },
      );
    }

    const projectRoot = path.resolve(process.cwd(), "..");
    const pythonExecutable = await resolvePythonExecutable(projectRoot);

    const jobs = files.map((file) =>
      processSingleFile({
        file,
        projectId,
        userId,
        projectRoot,
        pythonExecutable,
      }),
    );

    jobs.forEach((job) => job.catch((error) => console.error("[ERROR] Background job failed:", error)));

    return NextResponse.json(
      {
        message: `アップロードを受け付けました（${files.length}件）。解析結果は順次反映されます。`,
      },
      { status: 202 },
    );
  } catch (error) {
    const err = error instanceof Error ? error.message : "Unexpected error";
    return NextResponse.json({ message: err }, { status: 500 });
  }
}
