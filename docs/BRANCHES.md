# Choose a deployment branch

This repository contains Windows Feishu bridges for local coding agents.
`main` is the starting page; deploy one of the two named branches.

| Branch | Use it for | New-computer setup |
| --- | --- | --- |
| `antigravity` | Google Antigravity (`agy`) | Clone the branch, run `scripts/bootstrap-antigravity-bridge.ps1`, then run `scripts/run-antigravity-bridge.ps1` and scan the Feishu QR code. |
| `deepseek-harness` | DeepSeek Harness (`dsh`) | Clone the branch, run `scripts/bootstrap-deepseek-bridge.ps1`, then run `scripts/setup-deepseek-feishu.ps1`. |

Each local clone has its own `.lark-channel` folder, workspace, sessions, and
encrypted secrets. Do not copy these directories between computers or branches.
