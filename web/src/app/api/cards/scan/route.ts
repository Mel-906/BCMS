"use server";

import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import sharp from "sharp";

import { createSupabaseServerClient } from "@/lib/supabaseServer";

const SOURCE_BUCKET =
  process.env.SUPABASE_SOURCE_BUCKET ??
  process.env.NEXT_PUBLIC_SUPABASE_SOURCE_BUCKET ??
  "source-images";

export async function POST(request: NextRequest) {
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

    const buffer = Buffer.from(await file.arrayBuffer());
    const meta = await sharp(buffer).metadata();

    const ext = file.name.split(".").pop() ?? "jpg";
    const safeName = file.name.replace(/\s+/g, "_");
    const storageKey = `${projectId}/original/${Date.now()}-${randomUUID()}.${ext}`;

    const supabase = createSupabaseServerClient();

    const uploadResult = await supabase.storage.from(SOURCE_BUCKET).upload(storageKey, buffer, {
      contentType: file.type || "application/octet-stream",
    });

    if (uploadResult.error) {
      throw new Error(uploadResult.error.message);
    }

    const { data: sourceImage, error: insertError } = await supabase
      .from("source_images")
      .insert({
        project_id: projectId,
        user_id: userId,
        storage_path: `${SOURCE_BUCKET}/${storageKey}`,
        original_filename: safeName,
        width: meta.width ?? null,
        height: meta.height ?? null,
        format: meta.format ?? ext,
        captured_at: meta.exif ? null : null,
        metadata: {
          fileSize: buffer.length,
          fileType: file.type || null,
        },
      })
      .select("*")
      .single();

    if (insertError) {
      throw new Error(insertError.message);
    }

    return NextResponse.json(
      {
        message: "Upload completed.",
        source_image: sourceImage,
      },
      { status: 201 },
    );
  } catch (error) {
    const err = error instanceof Error ? error.message : "Unexpected error";
    return NextResponse.json({ message: err }, { status: 500 });
  }
}
