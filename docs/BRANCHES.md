# Windows bridge branches

This repository is a Windows bridge collection for Feishu PersonalAgent bots.
Choose exactly one branch per local bot installation.

| Branch | Local coding agent | Clone directory suggestion | Setup entry point |
| --- | --- | --- | --- |
| `bridge/antigravity` | Google Antigravity (`agy`) | `antigravity-feishu-bridge` | `scripts/bootstrap-antigravity-bridge.ps1` then `scripts/run-antigravity-bridge.ps1` |
| `bridge/deepseek-harness` | DeepSeek Harness (`dsh`) | `deepseek-feishu-bridge` | `scripts/bootstrap-deepseek-bridge.ps1` then `scripts/setup-deepseek-feishu.ps1` |

`main` is the shared development baseline. It is not a deployment target.

Each clone keeps its own `.lark-channel` folder. Never copy that folder, an App
Secret, or `workspace` from another computer. Bind a Feishu PersonalAgent app
on the target computer during setup.

Deployment branches use stable `bridge/<agent>` names. Feature work uses
`feature/<topic>` branches and is merged into its matching deployment branch
only after validation.
