"use server";

import { NextRequest, NextResponse } from "next/server";
import os from "os";
import path from "path";
import { spawn } from "child_process";
import { promises as fs } from "fs";

const PYTHON_BIN = process.env.PYTHON_BIN;

async function resolvePythonExecutable(projectRoot: string): Promise<string> {
  const candidates = [
    PYTHON_BIN,
    path.join(projectRoot, ".venv", "bin", "python"),
    path.join(projectRoot, ".venv", "Scripts", "python.exe"),
    "python3",
    "python",
  ].filter(Boolean) as string[];

  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // ignore and try next candidate
    }
  }

  throw new Error("Python executable not found. Set PYTHON_BIN or ensure .venv exists.");
}

function runCommand(command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }) {
  return new Promise<void>((resolve, reject) => {
    const proc = spawn(command, args, options);
    let stderr = "";
    proc.stdout.on("data", (chunk) => {
      process.stdout.write(chunk);
    });
    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
      process.stderr.write(chunk);
    });
    proc.on("error", (err) => {
      reject(err);
    });
    proc.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Command failed: ${command} ${args.join(" ")}\n${stderr}`));
      }
    });
  });
}

export async function POST(request: NextRequest) {
  let tmpDir: string | null = null;
  try {
    const formData = await request.formData();
    const file = formData.get("card");
    const projectId = formData.get("projectId");
    const userId = formData.get("userId") ?? request.headers.get("x-user-id");

    if (!(file instanceof File)) {
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

    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "bcms-upload-"));
    const safeName = file.name.replace(/\s+/g, "_") || `${Date.now()}.jpg`;
    const originalPath = path.join(tmpDir, safeName);
    const outputDir = path.join(tmpDir, "processed");

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

    return NextResponse.json(
      {
        message: "Upload and analysis completed.",
        processed: manifest.entries ?? [],
      },
      { status: 201 },
    );
  } catch (error) {
    const err = error instanceof Error ? error.message : "Unexpected error";
    return NextResponse.json({ message: err }, { status: 500 });
  } finally {
    if (tmpDir) {
      fs.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}
