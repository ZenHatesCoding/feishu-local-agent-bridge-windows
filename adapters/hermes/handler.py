"""Hermes gateway hook for the local Feishu collaboration Hub.

This adapter uses only the Python standard library and never changes Hermes
sessions, model configuration, credentials, or tools. The pilot gateway copy
allows this hook to enrich ``message_full`` and cancel unauthorized bot wakes.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import urllib.error
import urllib.parse
import urllib.request
from typing import Any


_TASK_BY_SESSION: dict[str, str] = {}

_FILE_PATTERNS = (
    re.compile(r"MEDIA:\s*([^\r\n]+)", re.IGNORECASE),
    re.compile(r"\[[^\]]*\]\((?:file://)?([^\)]+)\)"),
    re.compile(r"`((?:[A-Za-z]:\\|/)[^`]+)`"),
    re.compile(
        r"((?:[A-Za-z]:\\|/)[^\r\n\"<>|]+?\."
        r"(?:pptx?|docx?|xlsx?|pdf|zip|csv|tsv|md|txt|png|jpe?g|gif|webp))\b",
        re.IGNORECASE,
    ),
)


def _settings() -> tuple[str, str, str, str]:
    url = os.environ.get("LARK_COLLAB_HUB_URL", "").rstrip("/")
    token = os.environ.get("LARK_COLLAB_HUB_TOKEN", "")
    tenant = os.environ.get("LARK_COLLAB_TENANT_KEY", "")
    agent = os.environ.get("LARK_COLLAB_AGENT_ID", "fool")
    if not url or not token or not tenant:
        raise RuntimeError("collaboration Hub environment is incomplete")
    return url, token, tenant, agent


def _request(path: str, *, body: dict[str, Any] | None = None) -> dict[str, Any]:
    url, token, _, _ = _settings()
    payload = None if body is None else json.dumps(body, ensure_ascii=False).encode("utf-8")
    request = urllib.request.Request(
        f"{url}{path}",
        data=payload,
        method="GET" if body is None else "POST",
        headers={
            "Authorization": f"Bearer {token}",
            **({} if payload is None else {"Content-Type": "application/json"}),
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=5) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"Hub returned HTTP {exc.code}: {detail[:300]}") from exc


def _task_id(tenant: str, chat_id: str, thread_id: str) -> str:
    canonical = f"{tenant}\0{chat_id}\0{thread_id}".encode("utf-8")
    return f"task_{hashlib.sha256(canonical).hexdigest()[:24]}"


def _artifact_root() -> str:
    root = os.environ.get("LARK_COLLAB_ARTIFACT_ROOT", "").strip()
    if not root:
        raise RuntimeError("LARK_COLLAB_ARTIFACT_ROOT is required")
    return root


def _paths_in_text(text: str) -> list[str]:
    paths: list[str] = []
    seen: set[str] = set()
    for pattern in _FILE_PATTERNS:
        for match in pattern.finditer(text):
            candidate = match.group(1).strip().strip("'\" ").rstrip(".,;:)]}")
            if candidate.startswith("file:///"):
                candidate = candidate[8:]
            candidate = os.path.abspath(os.path.expanduser(candidate))
            key = os.path.normcase(candidate)
            if key not in seen and os.path.isfile(candidate):
                seen.add(key)
                paths.append(candidate)
    return paths


def _snapshot_artifact(task_id: str, path: str) -> dict[str, Any]:
    digest = hashlib.sha256()
    with open(path, "rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    sha256 = digest.hexdigest()
    name = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", os.path.basename(path)).strip()
    name = (name or "artifact.bin")[:180]
    artifact_dir = os.path.join(
        _artifact_root(),
        re.sub(r"[^A-Za-z0-9._-]", "_", task_id)[:120],
        sha256,
    )
    os.makedirs(artifact_dir, exist_ok=True)
    local_path = os.path.join(artifact_dir, name)
    if not os.path.isfile(local_path):
        temp_path = f"{local_path}.tmp-{os.getpid()}"
        try:
            shutil.copy2(path, temp_path)
            os.replace(temp_path, local_path)
        finally:
            if os.path.exists(temp_path):
                os.remove(temp_path)
    return {
        "id": f"artifact_{sha256[:24]}",
        "name": name,
        "kind": _kind_for_name(name),
        "localPath": local_path,
        "sha256": sha256,
        "size": os.path.getsize(local_path),
    }


def _kind_for_name(name: str) -> str:
    extension = os.path.splitext(name)[1].lower()
    if extension in {".ppt", ".pptx", ".key"}:
        return "presentation"
    if extension in {".doc", ".docx", ".md", ".txt"}:
        return "document"
    if extension in {".xls", ".xlsx", ".csv", ".tsv"}:
        return "spreadsheet"
    if extension in {".png", ".jpg", ".jpeg", ".gif", ".webp"}:
        return "image"
    if extension == ".pdf":
        return "pdf"
    return "file"


def _register_artifacts(task_id: str, agent_id: str, text: str, source: str) -> None:
    for path in _paths_in_text(text):
        artifact = _snapshot_artifact(task_id, path)
        _request("/v1/events", body={
            "type": "artifact",
            "idempotencyKey": f"artifact-{source}:{task_id}:{agent_id}:{artifact['id']}",
            "taskId": task_id,
            "actorAgentId": agent_id,
            "artifact": artifact,
        })


def _pending_dispatch(task_id: str, agent_id: str) -> dict[str, Any] | None:
    payload = _request(f"/v1/dispatches/agents/{urllib.parse.quote(agent_id)}")
    matches = [
        item for item in payload.get("dispatches", [])
        if item.get("taskId") == task_id and item.get("status") == "pending"
    ]
    return max(matches, key=lambda item: int(item.get("sequence", 0)), default=None)


def _submit_inbound(context: dict[str, Any], task_id: str, agent_id: str) -> dict[str, Any] | None:
    message_id = str(context.get("message_id") or "")
    message = str(context.get("message_full") or context.get("message") or "(empty message)")
    is_bot = bool(context.get("is_bot"))
    if is_bot:
        return _pending_dispatch(task_id, agent_id)

    _, _, tenant, _ = _settings()
    stable_id = message_id or hashlib.sha256(
        f"{context.get('session_id')}\0{message}".encode("utf-8")
    ).hexdigest()[:24]
    result = _request("/v1/events", body={
        "type": "message",
        "idempotencyKey": f"feishu-message:{stable_id}",
        "address": {
            "tenantKey": tenant,
            "chatId": str(context.get("chat_id") or ""),
            "threadId": str(context.get("thread_id") or ""),
        },
        "messageId": stable_id,
        "actor": {
            "type": "human",
            "id": str(context.get("user_id") or "unknown"),
        },
        "content": message[:100_000],
        "targetAgentIds": [agent_id],
    })
    return next(
        (item for item in result.get("dispatches", []) if item.get("targetAgentId") == agent_id),
        None,
    ) or _pending_dispatch(task_id, agent_id)


def _on_start(context: dict[str, Any]) -> None:
    if context.get("platform") != "feishu" or not context.get("thread_id"):
        return
    _, _, tenant, agent_id = _settings()
    task_id = _task_id(tenant, str(context.get("chat_id") or ""), str(context.get("thread_id")))
    dispatch = _submit_inbound(context, task_id, agent_id)
    if dispatch is None:
        if context.get("is_bot"):
            context["cancel"] = True
        return

    message = str(context.get("message_full") or context.get("message") or "")
    _register_artifacts(task_id, agent_id, message, "inbound")

    encoded_task = urllib.parse.quote(task_id)
    encoded_agent = urllib.parse.quote(agent_id)
    shared = _request(f"/v1/tasks/{encoded_task}/context?agentId={encoded_agent}&after=0")
    collaboration = {
        "task": shared.get("task"),
        "dispatch": dispatch,
        "entries": shared.get("entries", []),
        "artifacts": shared.get("artifacts", []),
        "rules": [
            "Continue from accepted shared conclusions and artifacts.",
            "Do not reveal private chain-of-thought or secrets.",
            "Your final visible answer will be recorded into shared task context.",
            "Files listed in artifacts are durable shared copies; read localPath directly.",
            "When you create a file, include its absolute path in the final response so Hermes sends it and the Hub registers it.",
        ],
    }
    context["message_full"] = (
        "<collaboration_context>\n"
        f"{json.dumps(collaboration, ensure_ascii=False)}\n"
        "</collaboration_context>\n\n"
        f"{message}"
    )
    session_id = str(context.get("session_id") or "")
    if session_id:
        _TASK_BY_SESSION[session_id] = task_id
    _request(f"/v1/dispatches/{urllib.parse.quote(str(dispatch['id']))}/ack", body={
        "agentId": agent_id,
        "status": "accepted",
        "idempotencyKey": f"accept:{dispatch['id']}:{context.get('message_id') or session_id}",
    })


def _on_end(context: dict[str, Any]) -> None:
    session_id = str(context.get("session_id") or "")
    task_id = _TASK_BY_SESSION.pop(session_id, None)
    response = str(context.get("response_full") or context.get("response") or "").strip()
    if not task_id or not response:
        return
    _, _, _, agent_id = _settings()
    _register_artifacts(task_id, agent_id, response, "outbound")
    digest = hashlib.sha256(response.encode("utf-8")).hexdigest()[:24]
    _request("/v1/events", body={
        "type": "return",
        "idempotencyKey": f"agent-result:{agent_id}:{session_id}:{digest}",
        "taskId": task_id,
        "actorAgentId": agent_id,
        "content": response[:100_000],
    })


async def handle(event_type: str, context: dict[str, Any]) -> None:
    if event_type == "agent:start":
        _on_start(context)
    elif event_type == "agent:end":
        _on_end(context)
