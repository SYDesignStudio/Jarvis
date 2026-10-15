# JARVIS on the MacBook

One JARVIS, two bodies. The Windows PC stays on and owns Telegram, the inbox
watchers and the background jobs. The MacBook runs its own brain and face,
talks and listens like the PC does, and shares the same memory: the tracker,
the knowledge store, project notes, JOBS.md, held emails and the practice
library are the PC's folders, mounted over Tailscale. Whatever either machine
files, the other sees.

## On the PC (once)

1. Share the two folders. PowerShell **as administrator**:

   ```powershell
   New-SmbShare -Name "APP DEVLOPMENT" -Path "D:\APP DEVLOPMENT" -FullAccess "$env:USERNAME"
   New-SmbShare -Name "BUILDING REGULATIONS" -Path "D:\BUILDING REGULATIONS" -ReadAccess "$env:USERNAME"
   Set-NetConnectionProfile -InterfaceAlias Tailscale -NetworkCategory Private
   ```

   The library is shared read-only on purpose: the Mac's JARVIS cannot write
   there even by accident. The Mac signs in with your Windows user name and
   password.

2. So the Mac can reach the NAS when you are out of the house, let the PC
   route your home network over Tailscale:

   ```powershell
   & "C:\Program Files\Tailscale\tailscale.exe" set --advertise-routes=192.168.0.0/24
   ```

   then approve the route for `salman-pc` at https://login.tailscale.com/admin/machines.
   At home the Mac reaches the NAS directly and this is not needed.

## On the Mac (once)

1. Get the code (see "Moving the code" below), open Terminal in the `jarvis` folder.
2. Copy `.env.local` from the PC into that folder (AirDrop or the share). Never paste its contents anywhere.
3. Run the setup, then sign in to Claude:

   ```bash
   bash scripts/mac/setup.sh
   claude
   ```

   The setup installs Node, Python, Chrome and Claude Code, builds the Mac's
   own `node_modules`, makes a Python with mlx-whisper for the M5, sets
   `JARVIS_SATELLITE=1` in `.env.local`, and makes `/Applications/JARVIS.app`.

4. Open **JARVIS** from Launchpad. The first time, macOS asks for the PC's and
   the NAS's password for the mounts: tick *Remember this password in my keychain*.
   Chrome asks for the microphone once.

## Every day

Open JARVIS from Launchpad. It mounts the shares, starts the brain and the face
if they are not running, and opens JARVIS in its own window. Check it with:

```bash
npm run preflight -- --free
```

Stop it with `bash scripts/mac/stop.sh`. Restart from the Diagnostics panel works the same as on the PC.

## What is different on the Mac

- Telegram, the inbox watchers and the Planning Portal sweep run on the PC only. The Mac still reads mail, sends held emails and messages you on Telegram when asked.
- Reading what is on screen and the Windows window reader are PC only.
- Chat history is per machine: a chat started on the PC is resumed on the PC.
- Everything else, including the tracker, knowledge, Specline and project memory, is shared.

## Moving the code

The jarvis folder is a git checkout whose only remote is the upstream project
it was cloned from. The clean way to carry it to the Mac and keep the two in
step is a private repository under your GitHub: create it (github.com/new,
private, named `jarvis`), tell JARVIS the URL, and it will push. Then on the
Mac: `git clone <url>` once, `git pull` whenever the PC has changed.
`.env.local`, `data/` and `node_modules` never go into git.
