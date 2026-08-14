# Windows bridge branches

This repository is a Windows bridge collection for Feishu PersonalAgent bots.
Choose exactly one branch per local bot installation.

| Branch | Local coding agent | Clone directory suggestion | Setup entry point |
| --- | --- | --- | --- |
| `antigravity` | Google Antigravity (`agy`) | `antigravity-feishu-bridge` | `scripts/run-antigravity-bridge.ps1` |
| `deepseek-harness` | DeepSeek Harness (`dsh`) | `deepseek-feishu-bridge` | `scripts/bootstrap-deepseek-bridge.ps1` then `scripts/setup-deepseek-feishu.ps1` |

`main` is the shared development baseline. It is not a deployment target.

Each branch keeps its own `.lark-channel` folder inside its clone. Never copy
that folder, App Secret, or `workspace` from one computer to another. Create or
bind a Feishu PersonalAgent app on the target computer and scan that computer's
QR code during setup.

Branches are named for stable deployment targets. Day-to-day feature work uses
`feature/<topic>` branches and is merged into its matching deployment branch
only after validation.
