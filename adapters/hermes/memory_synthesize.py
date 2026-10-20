"""Tool-free local memory synthesis using the installed Hermes model/login.

No gateway, Hub calls, native memory writes or sessions are created by this helper.
"""
from __future__ import annotations
import contextlib
import os
import sys


def main() -> None:
    prompt = sys.stdin.buffer.read().decode("utf-8")
    for key in list(os.environ):
        if key.startswith("LARK_COLLAB_") or key == "LARK_MEMORY_BINDING":
            os.environ.pop(key, None)
    with open(os.devnull, "w", encoding="utf-8") as quiet:
        with contextlib.redirect_stdout(quiet):
            from hermes_cli.config import load_config
            from hermes_cli.runtime_provider import resolve_runtime_provider
            from run_agent import AIAgent
            cfg = load_config()
            model_cfg = cfg.get("model") or {}
            model = model_cfg if isinstance(model_cfg, str) else model_cfg.get("default") or model_cfg.get("model") or ""
            runtime = resolve_runtime_provider(target_model=model or None)
            agent = AIAgent(
                api_key=runtime.get("api_key"), base_url=runtime.get("base_url"),
                provider=runtime.get("provider"), api_mode=runtime.get("api_mode"),
                model=model, credential_pool=runtime.get("credential_pool"),
                enabled_toolsets=[], max_iterations=1, quiet_mode=True,
                skip_context_files=True, skip_memory=True, save_trajectories=False,
            )
            if agent.tools:
                raise RuntimeError("Hermes memory maintenance unexpectedly enabled tools")
            agent._skip_mcp_refresh = True
            agent.suppress_status_output = True
            result = agent.run_conversation(prompt)
            if result.get("failed") or result.get("partial"):
                raise RuntimeError("Hermes memory maintenance failed")
            response = str(result.get("final_response") or "").strip()
    if not response:
        raise RuntimeError("Hermes memory maintenance returned no data")
    sys.stdout.buffer.write(response.encode("utf-8"))


if __name__ == "__main__":
    main()
