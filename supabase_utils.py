#!/usr/bin/env python3
"""Shared Supabase helper utilities for the BCMS OCR pipeline."""

from __future__ import annotations

import json
import os
import pathlib
from datetime import datetime
from typing import Any, Dict, Iterable, List, Optional, Tuple

from supabase import Client, create_client


class SupabaseConfigError(RuntimeError):
    """Raised when Supabase credentials are missing."""


class SupabaseRepository:
    """Thin repository wrapper around Supabase REST and Storage APIs."""

    def __init__(
        self,
        url: Optional[str] = None,
        service_role_key: Optional[str] = None,
        source_bucket: Optional[str] = None,
        processed_bucket: Optional[str] = None,
    ) -> None:
        self.url = url or os.getenv("SUPABASE_URL")
        self.service_role_key = service_role_key or os.getenv("SUPABASE_SERVICE_ROLE_KEY")

        if not self.url or not self.service_role_key:
            raise SupabaseConfigError(
                "Supabase configuration missing. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY."
            )

        self.client: Client = create_client(self.url, self.service_role_key)
        self.source_bucket = source_bucket or os.getenv("SUPABASE_SOURCE_BUCKET", "source-images")
        self.processed_bucket = processed_bucket or os.getenv(
            "SUPABASE_PROCESSED_BUCKET", "processed-images"
        )

    # --------------------------------------------------------------------- #
    # Storage helpers
    # --------------------------------------------------------------------- #
    def upload_bytes(
        self,
        *,
        bucket: str,
        path: str,
        content: bytes,
        content_type: str,
        upsert: bool = True,
    ) -> str:
        storage = self.client.storage.from_(bucket)
        storage.upload(path, content, {"content-type": content_type, "upsert": upsert})
        return f"{bucket}/{path}"

    def upload_source_file(self, *, path: str, content: bytes, content_type: str) -> str:
        return self.upload_bytes(
            bucket=self.source_bucket,
            path=path,
            content=content,
            content_type=content_type,
        )

    def upload_processed_file(self, *, path: str, content: bytes, content_type: str) -> str:
        return self.upload_bytes(
            bucket=self.processed_bucket,
            path=path,
            content=content,
            content_type=content_type,
        )

    # --------------------------------------------------------------------- #
    # Table helpers
    # --------------------------------------------------------------------- #
    def ensure_project(
        self,
        *,
        project_id: Optional[str],
        user_id: str,
        title: str,
        description: Optional[str] = None,
        status: str = "active",
    ) -> str:
        if project_id:
            # Validate existence
            response = (
                self.client.table("projects")
                .select("id")
                .eq("id", project_id)
                .eq("user_id", user_id)
                .limit(1)
                .execute()
            )
            data = response.data or []
            if not data:
                raise RuntimeError(f"Project {project_id} not found for user {user_id}.")
            return project_id

        payload = {
            "user_id": user_id,
            "title": title,
            "description": description,
            "status": status,
        }
        response = self.client.table("projects").insert(payload).execute()
        data = response.data or []
        if not data:
            raise RuntimeError("Failed to create project.")
        return data[0]["id"]

    def upsert_source_image(
        self,
        *,
        project_id: str,
        user_id: str,
        storage_path: str,
        original_filename: str,
        width: Optional[int],
        height: Optional[int],
        fmt: Optional[str],
        captured_at: Optional[datetime],
        metadata: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        payload = {
            "project_id": project_id,
            "user_id": user_id,
            "storage_path": storage_path,
            "original_filename": original_filename,
            "width": width,
            "height": height,
            "format": fmt,
            "captured_at": captured_at.isoformat() if captured_at else None,
            "metadata": metadata,
        }
        response = (
            self.client.table("source_images")
            .upsert(payload, on_conflict="storage_path")
            .select("*")
            .eq("storage_path", storage_path)
            .limit(1)
            .execute()
        )
        data = response.data or []
        if not data:
            raise RuntimeError(f"Failed to upsert source image for path {storage_path}")
        return data[0]

    def upsert_processed_image(
        self,
        *,
        project_id: str,
        user_id: str,
        source_image_id: str,
        storage_path: str,
        variant: str,
        params: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        payload = {
            "project_id": project_id,
            "user_id": user_id,
            "source_image_id": source_image_id,
            "storage_path": storage_path,
            "variant": variant,
            "params": params,
        }
        response = (
            self.client.table("processed_images")
            .upsert(payload, on_conflict="storage_path")
            .select("*")
            .eq("storage_path", storage_path)
            .limit(1)
            .execute()
        )
        data = response.data or []
        if not data:
            raise RuntimeError(f"Failed to upsert processed image for path {storage_path}")
        return data[0]

    def insert_yomitoku_result(
        self,
        *,
        project_id: str,
        user_id: str,
        source_image_id: str,
        processed_image_id: Optional[str],
        summary_text: Optional[str],
        result_payload: Dict[str, Any],
        confidence: Optional[float] = None,
    ) -> Dict[str, Any]:
        payload = {
            "project_id": project_id,
            "user_id": user_id,
            "source_image_id": source_image_id,
            "processed_image_id": processed_image_id,
            "summary": summary_text,
            "result": result_payload,
            "confidence": confidence,
        }
        response = (
            self.client.table("yomitoku_results")
            .insert(payload)
            .select("*")
            .order("created_at", desc=True)
            .limit(1)
            .execute()
        )
        data = response.data or []
        if not data:
            raise RuntimeError("Failed to insert YomiToku result.")
        return data[0]

    def insert_result_fields(
        self,
        *,
        result_id: str,
        project_id: str,
        user_id: str,
        payload: Dict[str, Any],
    ) -> None:
        flattened = flatten_payload(payload)
        if not flattened:
            return

        rows = [
            {
                "result_id": result_id,
                "project_id": project_id,
                "user_id": user_id,
                "key_path": key,
                **values,
            }
            for key, values in flattened
        ]
        # Supabase caps payload size; chunk inserts defensively.
        chunk_size = 500
        for start in range(0, len(rows), chunk_size):
            chunk = rows[start : start + chunk_size]
            self.client.table("yomitoku_result_fields").insert(chunk).execute()


# ------------------------------------------------------------------------- #
# Payload flattening utilities
# ------------------------------------------------------------------------- #
Primitive = Optional[bool | int | float | str]


def _coerce_value(value: Any) -> Tuple[Primitive, Optional[float], Optional[bool], Optional[str]]:
    if value is None:
        return None, None, None, None
    if isinstance(value, bool):
        return None, None, value, None
    if isinstance(value, (int, float)):
        return None, float(value), None, None
    if isinstance(value, str):
        return value, None, None, None
    return None, None, None, json.dumps(value, ensure_ascii=False)


def flatten_payload(payload: Dict[str, Any]) -> List[Tuple[str, Dict[str, Any]]]:
    """Flatten nested payload into (key_path, value_dict) tuples."""

    def _walk(prefix: str, value: Any, acc: List[Tuple[str, Dict[str, Any]]]) -> None:
        if isinstance(value, dict):
            for key, child in value.items():
                new_prefix = f"{prefix}.{key}" if prefix else key
                _walk(new_prefix, child, acc)
            return

        if isinstance(value, list):
            # Store the full list as JSON.
            list_json = json.dumps(value, ensure_ascii=False)
            acc.append(
                (
                    prefix,
                    {
                        "value_text": None,
                        "value_numeric": None,
                        "value_boolean": None,
                        "value_json": list_json,
                    },
                )
            )
            for idx, child in enumerate(value):
                child_prefix = f"{prefix}[{idx}]"
                _walk(child_prefix, child, acc)
            return

        text_value, numeric_value, bool_value, json_value = _coerce_value(value)
        acc.append(
            (
                prefix,
                {
                    "value_text": text_value,
                    "value_numeric": numeric_value,
                    "value_boolean": bool_value,
                    "value_json": json_value,
                },
            )
        )

    flattened: List[Tuple[str, Dict[str, Any]]] = []
    _walk("", payload, flattened)
    return flattened


def build_result_payload(summary: Dict[str, str]) -> Dict[str, Any]:
    """Normalise summary fields into a structured payload."""

    def split_field(value: Optional[str]) -> List[str]:
        if not value:
            return []
        return [item.strip() for item in value.split(";") if item.strip()]

    name_jp = summary.get("名前", "") if summary else ""
    name_en = summary.get("名前（英語）", "") if summary else ""
    occupation = summary.get("職業", "") if summary else ""

    tel_list = split_field(summary.get("Tel"))
    email_list = split_field(summary.get("e-mail"))
    urls = split_field(summary.get("URL"))

    postal_code = summary.get("所属住所郵便番号", "") if summary else ""
    address = summary.get("所属住所", "") if summary else ""

    organization = summary.get("所属", "") if summary else ""
    representative = summary.get("代表Tel", "") if summary else ""
    notes = summary.get("その他", "") if summary else ""

    payload: Dict[str, Any] = {
        "name": {"jp": name_jp, "en": name_en},
        "occupation": occupation,
        "contact": {"tel": tel_list, "email": email_list, "url": urls},
        "organization": {
            "name": organization,
            "representative_tel": representative,
            "address": {"zip": postal_code, "full": address},
        },
        "notes": notes,
        "raw_summary": summary,
    }
    return payload


def guess_content_type(path: pathlib.Path) -> str:
    suffix = path.suffix.lower()
    if suffix in {".jpg", ".jpeg"}:
        return "image/jpeg"
    if suffix == ".png":
        return "image/png"
    if suffix == ".webp":
        return "image/webp"
    if suffix == ".bmp":
        return "image/bmp"
    if suffix in {".tif", ".tiff"}:
        return "image/tiff"
    return "application/octet-stream"

