"""Hermes gateway hook for the local Feishu collaboration Hub.

This adapter uses only the Python standard library and never changes Hermes
sessions, model configuration, credentials, or tools. The pilot gateway copy
allows this hook to enrich ``message_full`` and cancel unauthorized bot wakes.
"""

from __future__ import annotations

import hashlib
import json
import os
import urllib.error
import urllib.parse
import urllib.request
from typing import Any


_TASK_BY_SESSION: dict[str, str] = {}


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

    encoded_task = urllib.parse.quote(task_id)
    encoded_agent = urllib.parse.quote(agent_id)
    shared = _request(f"/v1/tasks/{encoded_task}/context?agentId={encoded_agent}&after=0")
    message = str(context.get("message_full") or context.get("message") or "")
    collaboration = {
        "task": shared.get("task"),
        "dispatch": dispatch,
        "entries": shared.get("entries", []),
        "rules": [
            "Continue from accepted shared conclusions and artifacts.",
            "Do not reveal private chain-of-thought or secrets.",
            "Your final visible answer will be recorded into shared task context.",
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
