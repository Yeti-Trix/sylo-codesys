/**
 * sylo-codesys — setup + diagnostics for the CODESYS MCP bridge.
 *
 * IMPORTANT: this package does NOT speak MCP itself and does NOT spawn CODESYS.
 * The actual CODESYS tools come from the `codesys-mcp-sp21-plus` stdio MCP
 * server, surfaced into Pi through the **pi-mcp-adapter** package (enabled
 * separately in the Capability manager) once the operator adds a `codesys`
 * server entry to a workspace `.mcp.json`.
 *
 * The single tool registered here, `codesys_setup_check`, validates that wiring:
 *   - detects the installed CODESYS V3.5.x under C:\Program Files,
 *   - checks the global `codesys-mcp-sp21-plus` npm package (and runs
 *     `--print-config` to read the exact codesys-path / codesys-profile),
 *   - inspects the workspace `.mcp.json` (+ ~/.pi/agent/mcp.json) for a codesys
 *     server entry and reports its key fields,
 *   - confirms the `mcp` adapter tool (pi-mcp-adapter) is live, and
 *   - emits a ready-to-paste, *augmented* `.mcp.json` snippet: a curated
 *     ~24-tool directTools surface, destructive-op approval gating, and a
 *     lazy-keep-alive lifecycle that keeps the CODESYS instance resident across
 *     turns while launching it lazily on first use.
 *
 * It is read-only with respect to operator config — it never writes the
 * `.mcp.json` (operator-owned config; the host does not silently enable MCP
 * servers). The operator (or the agent via `write`) pastes the snippet.
 */
import { execFile } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'

const execFileAsync = promisify(execFile)

type ToolContentBlock = { type: 'text'; text: string }

function toolText(text: string): { content: ToolContentBlock[]; details: unknown } {
  return { content: [{ type: 'text', text }], details: {} }
}

/** Strip // line + block comments and trailing commas so a JSONC .mcp.json parses. */
function parseJsoncLoose(raw: string): unknown {
  const attempt = (s: string): unknown => {
    try {
      return JSON.parse(s)
    } catch {
      return null
    }
  }
  const direct = attempt(raw)
  if (direct !== null) return direct
  const stripped = raw
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => {
      const i = line.indexOf('//')
      return i === -1 ? line : line.slice(0, i)
    })
    .join('\n')
    .replace(/,(\s*[}\]])/g, '$1')
  return attempt(stripped)
}

interface CodesysInstall {
  path: string
  folder: string
}

function detectCodesysInstalls(): CodesysInstall[] {
  const out: CodesysInstall[] = []
  const progFiles = 'C:\\Program Files'
  try {
    if (!existsSync(progFiles)) return out
    for (const folder of readdirSync(progFiles)) {
      if (!/^CODESYS 3\.5\./i.test(folder)) continue
      const exe = join(progFiles, folder, 'CODESYS', 'Common', 'CODESYS.exe')
      if (existsSync(exe)) out.push({ path: exe, folder })
    }
  } catch {
    /* ignore FS errors — this is best-effort detection */
  }
  return out
}

interface ServerEntry {
  command?: string
  args?: string[]
  lifecycle?: string
  directTools?: unknown
  approveTools?: unknown
  [k: string]: unknown
}

function readMcpJson(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null
  try {
    const raw = readFileSync(path, 'utf8')
    const v = parseJsoncLoose(raw)
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function findCodesysServers(obj: Record<string, unknown>): Record<string, ServerEntry> | null {
  const servers = obj.mcpServers
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) return null
  const map = servers as Record<string, ServerEntry>
  const keys = Object.keys(map).filter((k) => /codesys/i.test(k))
  if (keys.length === 0) return null
  const out: Record<string, ServerEntry> = {}
  for (const k of keys) out[k] = map[k]!
  return out
}

function argAfter(args: string[] | undefined, flag: string): string | undefined {
  if (!args) return undefined
  const i = args.indexOf(flag)
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined
}

/** Curated first-class tool surface (original MCP tool names). */
const CURATED_DIRECT_TOOLS = [
  'get_codesys_status',
  'get_project_info',
  'get_all_pou_code',
  'create_pou',
  'set_pou_code',
  'create_method',
  'create_property',
  'create_dut',
  'create_gvl',
  'create_folder',
  'delete_object',
  'rename_object',
  'save_project',
  'compile_project',
  'get_compile_messages',
  'add_library',
  'list_project_libraries',
  'connect_to_device',
  'read_variable',
  'write_variable',
  'start_stop_application',
  'get_application_state',
  'mirror_export',
  'shutdown_codesys',
]

/** Tools that must be confirmed before running (destructive / online forces). */
const APPROVE_TOOLS = [
  'delete_object',
  'write_variable',
  'force_variables',
  'unforce_variables',
  'download_to_device',
  'reset_application',
  'shutdown_codesys',
  'remove_library',
]

function buildAugmentedEntry(codesysPath: string, profile: string): Record<string, unknown> {
  return {
    command: 'codesys-mcp-sp21-plus',
    args: [
      '--codesys-path',
      codesysPath,
      '--codesys-profile',
      profile,
      '--mode',
      'persistent',
      '--no-auto-launch',
      '--auto-mirror',
    ],
    lifecycle: 'lazy-keep-alive',
    requestTimeoutMs: 180000,
    directTools: CURATED_DIRECT_TOOLS,
    approveTools: APPROVE_TOOLS,
  }
}

function extractPathProfileFromPrintConfig(raw: string): {
  path?: string
  profile?: string
} {
  const v = parseJsoncLoose(raw) as { mcpServers?: Record<string, ServerEntry> } | null
  if (!v?.mcpServers) return {}
  const keys = Object.keys(v.mcpServers)
  // Prefer an SP22 entry; fall back to the first.
  const pick = keys.find((k) => /sp22/i.test(k)) ?? keys[0]
  if (!pick) return {}
  const entry = v.mcpServers[pick]!
  return {
    path: argAfter(entry.args, '--codesys-path'),
    profile: argAfter(entry.args, '--codesys-profile'),
  }
}

async function runPrintConfig(): Promise<{ ok: boolean; raw?: string; error?: string }> {
  try {
    const { stdout } = await execFileAsync('codesys-mcp-sp21-plus', ['--print-config'], {
      windowsHide: true,
      timeout: 15_000,
    })
    return { ok: true, raw: stdout }
  } catch (err) {
    const e = err as NodeJS.ErrnoException
    if (e.code === 'ENOENT') return { ok: false, error: 'not-installed' }
    return { ok: false, error: e.message ?? String(err) }
  }
}

export default function piSyloCodesysExtension(pi: ExtensionAPI): void {
  pi.registerTool({
    name: 'codesys_setup_check',
    label: 'CODESYS MCP setup check',
    description:
      'Validate the CODESYS MCP bridge wiring for this Sylo: detect the CODESYS V3.5 install, ' +
      'check the global `codesys-mcp-sp21-plus` npm package, inspect the workspace `.mcp.json` for a ' +
      'codesys server entry, confirm the `mcp` adapter tool (pi-mcp-adapter) is live, and emit a ' +
      'ready-to-paste augmented `.mcp.json` snippet (curated directTools + destructive-op approval ' +
      'gating + lazy-keep-alive lifecycle). The CODESYS tools themselves come from the MCP server via ' +
      'pi-mcp-adapter (directTools + the `mcp` proxy), NOT from this tool. Run once after enabling the ' +
      'sylo-codesys package and whenever the wiring changes.',
    parameters: Type.Object({
      mcp_json_path: Type.Optional(
        Type.String({
          description:
            'Path to the `.mcp.json` to inspect (defaults to <cwd>/.mcp.json). ' +
            'Also checks ~/.pi/agent/mcp.json.',
        }),
      ),
      print_config: Type.Optional(
        Type.Boolean({
          description:
            'Run `codesys-mcp-sp21-plus --print-config` to read the exact CODESYS path/profile ' +
            '(default true; needs the package installed).',
        }),
      ),
    }),
    async execute(_toolCallId, params) {
      const lines: string[] = []
      const wantPrint = params.print_config !== false

      // 1. CODESYS install detection
      lines.push('=== CODESYS install ===')
      const installs = detectCodesysInstalls()
      if (installs.length === 0) {
        lines.push('  No CODESYS 3.5.x install found under C:\\Program Files.')
      } else {
        for (const i of installs) lines.push(`  ${i.folder}  ->  ${i.path}`)
      }

      // 2. codesys-mcp-sp21-plus package + --print-config
      lines.push('')
      lines.push('=== codesys-mcp-sp21-plus (npm) ===')
      let detectedPath: string | undefined
      let detectedProfile: string | undefined
      let packageInstalled = false
      if (wantPrint) {
        const pc = await runPrintConfig()
        if (pc.ok && pc.raw) {
          packageInstalled = true
          const ex = extractPathProfileFromPrintConfig(pc.raw)
          detectedPath = ex.path
          detectedProfile = ex.profile
          lines.push('  Installed. `--print-config` OK.')
          if (detectedPath) lines.push(`  path:    ${detectedPath}`)
          if (detectedProfile) lines.push(`  profile: ${detectedProfile}`)
        } else if (pc.error === 'not-installed') {
          lines.push('  NOT installed / not on PATH. Install with:')
          lines.push('    npm install -g codesys-mcp-sp21-plus')
        } else {
          lines.push(`  \`--print-config\` failed: ${pc.error}`)
        }
      } else {
        lines.push('  (print_config=false — skipped)')
      }
      if (!detectedPath && installs.length > 0) {
        detectedPath = installs[0]!.path
        lines.push(`  (using filesystem-scanned path for the snippet: ${detectedPath})`)
      }
      if (!detectedProfile) {
        lines.push(
          '  profile: UNKNOWN — run `codesys-mcp-sp21-plus --print-config` to get the exact string.',
        )
      }

      // 3. .mcp.json inspection
      lines.push('')
      lines.push('=== .mcp.json ===')
      const cwd = process.cwd()
      const candidates = [
        {
          label: 'workspace',
          path: (params.mcp_json_path ?? '').trim() || join(cwd, '.mcp.json'),
        },
        { label: 'user-global', path: join(homedir(), '.pi', 'agent', 'mcp.json') },
      ]
      let foundCodesysEntry = false
      for (const c of candidates) {
        const obj = readMcpJson(c.path)
        if (!obj) {
          lines.push(`  ${c.label}: (none)  ${c.path}`)
          continue
        }
        lines.push(`  ${c.label}: ${c.path}`)
        const codesys = findCodesysServers(obj)
        if (codesys) {
          foundCodesysEntry = true
          for (const [k, e] of Object.entries(codesys)) {
            const cp = argAfter(e.args, '--codesys-path')
            const cf = argAfter(e.args, '--codesys-profile')
            const mode = argAfter(e.args, '--mode')
            const lifecycle = typeof e.lifecycle === 'string' ? e.lifecycle : '(unset)'
            const dt = Array.isArray(e.directTools) ? e.directTools.length : 0
            lines.push(`    server "${k}":`)
            lines.push(`      command:    ${e.command ?? '?'}`)
            if (cp) lines.push(`      codesys-path:    ${cp}`)
            if (cf) lines.push(`      codesys-profile: ${cf}`)
            if (mode) lines.push(`      mode:           ${mode}`)
            lines.push(`      lifecycle: ${lifecycle}, directTools: ${dt}`)
          }
        } else {
          lines.push('    (no codesys* server entry — add one using the snippet below)')
        }
      }

      // 4. pi-mcp-adapter live?
      lines.push('')
      lines.push('=== pi-mcp-adapter ===')
      let mcpTool = false
      try {
        mcpTool = pi.getAllTools().some((t) => t.name === 'mcp')
      } catch {
        /* getAllTools not available yet — treat as unknown */
      }
      if (mcpTool) {
        lines.push('  `mcp` tool is registered — pi-mcp-adapter is enabled.')
      } else {
        lines.push(
          '  `mcp` tool NOT registered — enable the pi-mcp-adapter package in the Capability manager, then restart the broker.',
        )
      }
      if (mcpTool && !foundCodesysEntry) {
        lines.push(
          '  (adapter is live but no codesys server is configured — paste the snippet below into a .mcp.json.)',
        )
      }

      // 5. Ready-to-paste snippet
      if (detectedPath && detectedProfile) {
        lines.push('')
        lines.push('=== Augmented .mcp.json snippet (merge into your .mcp.json) ===')
        const entry = buildAugmentedEntry(detectedPath, detectedProfile)
        lines.push(JSON.stringify({ mcpServers: { codesys: entry } }, null, 2))
        lines.push('')
        lines.push('Notes:')
        lines.push(
          '  - directTools promote a ~24-tool curated surface as first-class Pi tools named codesys_<tool> ' +
            '(codesys_create_pou, codesys_set_pou_code, codesys_compile_project, ...).',
        )
        lines.push(
          '  - approveTools require confirmation before destructive/online ops (delete_object, write_variable, force_variables, download_to_device, ...).',
        )
        lines.push(
          '  - lazy-keep-alive: CODESYS spawns on the first tool call and stays resident across turns; ' +
            '--no-auto-launch keeps it from starting at broker boot.',
        )
        lines.push(
          '  - --auto-mirror re-runs mirror_export after each change so the .st mirror stays in sync for undo ' +
            '(Ctrl+Z in the IDE does NOT recover set_pou_code edits).',
        )
        lines.push('  - After editing .mcp.json, restart the broker so pi-mcp-adapter re-reads it.')
      } else if (!packageInstalled) {
        lines.push('')
        lines.push(
          'Next: `npm install -g codesys-mcp-sp21-plus`, then re-run codesys_setup_check to get the exact .mcp.json snippet.',
        )
      }

      return toolText(lines.join('\n'))
    },
  })
}