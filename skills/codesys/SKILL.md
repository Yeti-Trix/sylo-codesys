---
name: codesys
description: Drive a live, open CODESYS V3.5 project from chat — create POUs, write Structured Text, compile, read/write PLC variables — via the codesys-mcp-sp21-plus MCP server bridged through pi-mcp-adapter.
metadata:
  sylo:
    category: automation
    icon: cpu
---

# CODESYS — live project via MCP

You drive a **live, open CODESYS V3.5 project** from chat. Every change is
applied to the project the operator has open and appears in the CODESYS IDE in
real time. It is the standalone CODESYS chat experience for live projects.

## How this is wired (the part you cannot see)

These CODESYS tools are **not** built into Sylo. They come from the external
`codesys-mcp-sp21-plus` stdio MCP server, surfaced into Pi by the
**pi-mcp-adapter** package once a `codesys` server is configured in a
workspace `.mcp.json`. If the wiring is missing or broken, your tool calls will
fail — fix the wiring, don't keep retrying blindly.

**Run `codesys_setup_check` first** whenever CODESYS is the task or a call
fails. It reports: is CODESYS installed? is `codesys-mcp-sp21-plus` on PATH? is
there a `codesys` server in `.mcp.json`? is the `mcp` adapter tool live? It also
emits a ready-to-paste `.mcp.json` snippet. Tell the operator the gaps and the
exact fix (install command / enable pi-mcp-adapter / paste snippet / restart
broker).

## Two ways to call the tools

1. **Direct tools** (if `directTools` is configured in `.mcp.json`): a curated
   ~24-tool surface is registered as first-class Pi tools named `codesys_<mcp_name>`:
   `codesys_get_codesys_status`, `codesys_get_project_info`, `codesys_get_all_pou_code`,
   `codesys_create_pou`, `codesys_set_pou_code`, `codesys_create_method`,
   `codesys_create_property`, `codesys_create_dut`, `codesys_create_gvl`,
   `codesys_create_folder`, `codesys_delete_object`, `codesys_rename_object`,
   `codesys_save_project`, `codesys_compile_project`, `codesys_get_compile_messages`,
   `codesys_add_library`, `codesys_list_project_libraries`, `codesys_connect_to_device`,
   `codesys_read_variable`, `codesys_write_variable`, `codesys_start_stop_application`,
   `codesys_get_application_state`, `codesys_mirror_export`, `codesys_shutdown_codesys`.
   Prefer these when they fit — no search round-trip.

2. **The `mcp` proxy** for everything else (the other ~78 tools, plus resources).
   Discover → describe → call:
   ```
   mcp({ search: "symbol config" })          // find candidate tools
   mcp({ describe: "create_symbol_config" })  // read the schema
   mcp({ tool: "create_symbol_config", args: { projectFilePath: "C:/p.project", ... } })
   ```
   **Project structure is an MCP resource, not a tool**: read it via the proxy
   with the resource URI `codesys://project/{+project_path}/structure` (the
   adapter exposes resources as tools when `exposeResources` is on). For a plain
   project-info read, use the `codesys_get_project_info` direct tool.

## `projectFilePath` is required on every tool

Every CODESYS tool takes `projectFilePath` (absolute path to the open `.project`
file, forward or back slashes both work). **Determine it before calling:**
- Ask the operator which `.project` they have open, or
- Look in the workspace for `*.project`, or
- Run `codesys_setup_check` (it lists the detected CODESYS install but not the
  project — the project path still comes from the operator/workspace).

The server's `ensure_project_open` helper opens the project if it isn't already
open, so passing the correct path is sufficient.

## Discipline

- **Inspect before editing.** Call `codesys_get_project_info` + `codesys_get_all_pou_code`
  (or the structure resource) to understand the project. Don't edit blind.
- **Always compile after authoring.** After `create_pou` / `set_pou_code` /
  `create_method` / `create_dut` / `create_gvl` / `add_library` / `rename_object`,
  call `codesys_compile_project` and **report errors/warnings to the operator
  before declaring success.** Use `codesys_get_compile_messages` for detail.
  These modifying tools **auto-save** the project on success.
- **Confirm destructive ops.** `delete_object`, `write_variable` (forces),
  `download_to_device`, `reset_application`, `shutdown_codesys`, `remove_library`
  are approval-gated (the operator clicks to confirm). Still announce intent in
  chat first — e.g. "I'm about to delete `Application/OldPou` — confirm?"
- **Undo caveat.** `set_pou_code` writes the live binary; **Ctrl+Z in the IDE
  does NOT recover it.** With `--auto-mirror` configured, each change re-runs
  `mirror_export` to a `.st` mirror on disk — commit that mirror to git for
  real undo. Call `codesys_mirror_export` to refresh it on demand.

## Online / runtime

- `codesys_connect_to_device` may pop a **"Device User Login" modal in the
  CODESYS IDE** that the agent cannot see or dismiss. **Announce this to the
  operator before calling** and tell them to be ready to click. To suppress it,
  set `CODESYS_DEVICE_USER` / `CODESYS_DEVICE_PASSWORD` in the `codesys` server
  `env` block of `.mcp.json`.
- Read/write variables require an online connection first (`codesys_connect_to_device`).
- `codesys_get_application_state` returns run / stop / exception + logged-in status.

## Lifecycle

The first tool call launches CODESYS **persistent (UI visible)**; with the
recommended `lazy-keep-alive` lifecycle the instance stays resident across turns
so subsequent calls are fast (cold launch + watcher ready can take 60s+). To stop
CODESYS from chat, call `codesys_shutdown_codesys` (it relaunches on the next
tool call). If the operator already has CODESYS open with the project, the
bridge uses that instance.

## ⚠️ UI lock — CODESYS scripting engine is single-threaded

**While the MCP bridge is active, the operator has limited ability to interact
with the CODESYS IDE.** The bridge runs a watcher script inside CODESYS's
scripting engine, which is single-threaded. The watcher loop (`system.delay()`
polling) blocks new commands — direct double-click navigation and menu actions
are locked.

**Workaround:** right-clicking still works (it's a raw Win32 event that
bypasses CODESYS's `StartLengthyOperation` gate). After right-clicking on an
object, double-clicking to open it works. This is not a bug — it's a side
effect of `system.delay()` pumping the Win32 message loop while
`StartLengthyOperation()` blocks CODESYS-level commands. See the [CODESYS
scripting docs on `system.delay`](https://product-help.se.com/docs/Machine+Expert/V1.1/en/ScriptEngine/topics/system.htm).

**What works vs. what's blocked in the agent's instance:**
- ✅ Right-click (raw Win32 event bypasses the gate)
- ✅ Open a POU via right-click → double-click
- ❌ Scroll the editor (CODESYS editor command — blocked)
- ❌ Menu bar, typing, editing (blocked)

You can open a POU and see the top of the code, but **you cannot scroll to
read further down.** For reading long routines, use the second read-only
instance (below) or ask the agent to dump the code to chat.

This is a fundamental limitation of the CODESYS scripting engine, not a bug in
the MCP server.

### Recommended workflow: second read-only CODESYS instance

The cleanest workflow uses **two CODESYS instances** — one for the agent
(MCP bridge), one for the operator (read-only inspection):

1. **Agent's instance** — launched by the MCP server, runs the watcher script,
   UI is locked. This is where tool calls create POUs, write ST, compile, etc.
2. **Operator's instance** — a second CODESYS window opened separately (e.g.
   launch CODESYS manually, File → Open Project, pick the same `.project` file).
   This instance is fully interactive — the operator can navigate, inspect code,
   double-click POUs, etc. without interfering with the bridge.
3. **Seeing live updates** — CODESYS does NOT auto-detect external file changes
   and has no "reload from disk" button. But the operator can **reopen the
   project without closing CODESYS first** (File → Open Project → select the
   same `.project`). This reloads the project from disk with all the agent's
   changes, without killing the agent's MCP-connected instance.
4. **When the agent is done with a batch** — the operator reopens the project
   in the read-only instance to inspect the results. No kill, no relaunch, no
   Sylo restart needed.

This avoids the kill/relaunch cycle entirely for routine inspection. Only use
the recovery procedure below if the watcher actually dies (cancel, close, or
   crash).

### Recovery when the watcher dies (cancel, close, or crash)

No Sylo restart is needed. The MCP server child process is still alive
(lazy-keep-alive keeps it resident), but the watcher inside CODESYS is dead —
tool calls will time out (60s). To recover:

1. The agent kills the dead CODESYS process from bash:
   ```bash
   taskkill /F /IM CODESYS.exe
   ```
2. The next tool call relaunches CODESYS with a fresh watcher and reopens the
   project automatically.

Alternatively, call `codesys_launch_codesys_with_project` with
`killExisting=true` — it kills the orphan and relaunches in one step.

### Orphaned CODESYS after Sylo broker restart

If the Sylo broker restarts (or the machine reboots), the MCP server child
process dies but the CODESYS window it launched stays open as an orphan. The
new MCP server instance refuses to share IPC with the orphan:

> `Refusing to launch: 1 CODESYS.exe instance(s) of the same install already
> running... This MCP server cannot share IPC with an instance it didn't spawn.`

Fix: kill the orphan (`taskkill /F /IM CODESYS.exe`) or call
`launch_codesys_with_project` with `killExisting=true`, then the next tool call
works normally.

## Argument cheat-sheet (most-used tools)

```js
// Create a POU (type: Program | FunctionBlock | Function; language: ST | LD | FBD | SFC | IL | CFC)
codesys_create_pou({
  projectFilePath: "C:/Projects/MyPLC.project",
  name: "FB_Motor",
  type: "FunctionBlock",
  language: "ST",
  parentPath: "Application",            // relative path under the project root
  declarationCode: "FUNCTION_BLOCK FB_Motor\nVAR\n  bRun : BOOL;\nEND_VAR",
  implementationCode: "IF bRun THEN\n  ;\nEND_IF"   // optional
})

// Write declaration and/or implementation of an existing POU / method / property
codesys_set_pou_code({
  projectFilePath: "C:/Projects/MyPLC.project",
  pouPath: "Application/FB_Motor",      // slash path to the object
  declarationCode: "...",               // omit a field to leave it unchanged
  implementationCode: "..."
})

// Create a method on an FB (returnType optional; pass code or leave empty + set_pou_code later)
codesys_create_method({
  projectFilePath: "...",
  parentPouPath: "Application/FB_Motor",
  methodName: "Reset",
  returnType: "BOOL",
  implementationCode: "Reset := TRUE;"
})

// DUT (dutType: Structure | Enumeration | Union | Alias) / GVL / folder
codesys_create_dut({ projectFilePath: "...", name: "ST_Axis", dutType: "Structure", parentPath: "Application" })
codesys_create_gvl({ projectFilePath: "...", name: "GVL_IO",  parentPath: "Application", declarationCode: "VAR_GLOBAL\n  bReady : BOOL;\nEND_VAR" })

// Build + messages
codesys_compile_project({ projectFilePath: "..." })
codesys_get_compile_messages({ projectFilePath: "..." })

// Libraries (name must match the installed Library Repository; refuses unknown libs)
codesys_add_library({ projectFilePath: "...", libraryName: "Standard" })
codesys_list_project_libraries({ projectFilePath: "..." })

// Online
codesys_connect_to_device({ projectFilePath: "..." })        // may pop a login modal
codesys_read_variable({ projectFilePath: "...", variablePath: "PLC_PRG.bMotorRunning" })
codesys_write_variable({ projectFilePath: "...", variablePath: "PLC_PRG.bMotorRunning", value: "TRUE" })
codesys_start_stop_application({ projectFilePath: "...", action: "start" })  // action: start | stop
codesys_get_application_state({ projectFilePath: "..." })
```

**Searching across POUs:** there is no `search_code` tool. Call
`codesys_get_all_pou_code` (returns all declarations + implementations) and grep
the returned text. The project tree is the `codesys://project/{+path}/structure`
resource, read via the `mcp` proxy.

## Scope

This skill is only for **live CODESYS V3.5 projects** driven through the MCP
server. It is not for projects edited as plain files on disk with no CODESYS
running.