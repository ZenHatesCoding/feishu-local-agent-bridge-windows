# Choose a deployment branch

This repository contains Windows Feishu bridges for local coding agents.
Deploy a `release/*` branch. Work only on its matching `develop/*` branch;
`archive/*` is never a new-install entry point.

| Branch | Use it for | New-computer setup |
| --- | --- | --- |
| `release/hub` | Central Hub deployment | Clone this branch for the computer that runs the Hub. |
| `release/worker` | Second-PC Worker deployment | Clone this branch for a Worker machine. It connects to, but never starts, a Hub. |
| `develop/hub` / `develop/worker` | Corresponding development lines | Do focused acceptance before merging into the matching release branch. |
| `archive/*` | Historical deployments and migration protection points | Rollback/history only. |

Each local clone has its own `.lark-channel` folder, workspace, sessions, and
encrypted secrets. Do not copy these directories between computers or branches.
