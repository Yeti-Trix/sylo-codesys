# sylo-codesys

Drive a **live, open CODESYS V3.5 project** from Sylo chat — create POUs, write
Structured Text, compile, read/write PLC variables — with changes appearing in
the CODESYS IDE in real time.

This package does **not** speak MCP and does **not** spawn CODESYS. It is the
skill + a setup/diagnostic tool. The actual CODESYS tools come from the external
[`codesys-mcp-sp21-plus`](https://github.com/phobicdotno/Codesys-MCP-SP21-plus)
stdio MCP server, surfaced into Pi by the **`pi-mcp-adapter`** package once you
add a `codesys` server to a workspace `.mcp.json`.

## Requirements

- **CODESYS V3.5 SP19 / SP21 / SP22** installed (Windows).
- **Node.js 18+** (for the MCP server).
- The **`pi-mcp-adapter`** package enabled in Sylo → Capability manager.
- The global npm package `codesys-mcp-sp21-plus`:
  ```bash
  npm install -g codesys-mcp-sp21-plus
  ```

## Setup

1. Enable **sylo-codesys** in Sylo → Capability manager → Sylo optional packages.
2. Enable **pi-mcp-adapter** (separate package) if it isn't already.
3. In Sylo chat, ask the agent to call **`codesys_setup_check`**. It detects your
   CODESYS install, verifies the npm package, checks for a `codesys` server in
   your `.mcp.json`, confirms the `mcp` adapter is live, and prints a
   ready-to-paste, augmented `.mcp.json` snippet.
4. Paste that snippet into your workspace `.mcp.json` (merge into the existing
   `mcpServers` object). The recommended entry looks like:

   ```json
   {
     "mcpServers": {
       "codesys": {
         "command": "codesys-mcp-sp21-plus",
         "args": [
           "--codesys-path", "C:\\Program Files\\CODESYS 3.5.22.30\\CODESYS\\Common\\CODESYS.exe",
           "--codesys-profile", "CODESYS V3.5 SP22 Patch 3",
           "--mode", "persistent",
           "--no-auto-launch",
           "--auto-mirror"
         ],
         "lifecycle": "lazy-keep-alive",
         "requestTimeoutMs": 180000,
         "directTools": ["get_codesys_status", "get_project_info", "get_all_pou_code", "create_pou", "set_pou_code", "create_method", "create_property", "create_dut", "create_gvl", "create_folder", "delete_object", "rename_object", "save_project", "compile_project", "get_compile_messages", "add_library", "list_project_libraries", "connect_to_device", "read_variable", "write_variable", "start_stop_application", "get_application_state", "mirror_export", "shutdown_codesys"],
         "approveTools": ["delete_object", "write_variable", "force_variables", "unforce_variables", "download_to_device", "reset_application", "shutdown_codesys", "remove_library"]
       }
     }
   }
   ```
   Get the exact `--codesys-path` / `--codesys-profile` strings with
   `codesys-mcp-sp21-plus --print-config` (the setup tool does this for you).

5. Restart the broker so `pi-mcp-adapter` re-reads `.mcp.json`.
6. In chat, ask the agent to drive CODESYS (e.g. "create a POU `FB_Motor` in
   Application and compile"). The first tool call launches CODESYS (persistent,
   UI visible); with `lazy-keep-alive` it stays resident across turns.

## How it works

```
Sylo agent (LLM)
   │  calls codesys_create_pou, codesys_compile_project, …  (directTools)
   │  or mcp({ tool: "create_pou", args })                   (proxy, other tools)
   ▼
pi-mcp-adapter  (Pi extension; spawns + owns the MCP server stdio process)
   ▼
codesys-mcp-sp21-plus   (Node, stdio MCP server)
   │  file-based IPC: writes command .py → watcher polls → result
   ▼
CODESYS.exe             (persistent, --runscript=watcher.py, UI visible)
   ▼
open .project           (live; operator watches changes in the IDE)
```

## Notes

- Modifying tools (`set_pou_code`, `create_pou`, …) **auto-save** the project.
  **Ctrl+Z in the IDE does not recover `set_pou_code` edits.** With
  `--auto-mirror`, each change re-runs `mirror_export` to a `.st` mirror on disk
  — commit that mirror to git for real undo.
- `connect_to_device` may pop a "Device User Login" modal in the IDE. Pre-set
  `CODESYS_DEVICE_USER` / `CODESYS_DEVICE_PASSWORD` in the server `env` block to
  suppress it.
- MCP-server compatibility & docs: see the
  [codesys-mcp-sp21-plus README](https://github.com/phobicdotno/Codesys-MCP-SP21-plus#readme)
  and [ARCHITECTURE.md](https://github.com/phobicdotno/Codesys-MCP-SP21-plus/blob/main/ARCHITECTURE.md).