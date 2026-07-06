---
date: 2026-07-06T11:19:42.494-07:00
git_commit: 5f0711e228dc7cd8089806b656121080862202b0
branch: feature/agent-native-vault-tools
repository: obsidian-copilot-agent
topic: "Agent-native vault navigation tools code research"
tags: [research, codebase, vault-tools, obsidian-api, search-content]
status: complete
last_updated: 2026-07-06
---

# Research: Agent-native vault navigation tools

## Research Question

Document existing vault-tool manifest, Obsidian API wrapper, search/read-tool implementations, registration/dispatch, tests, documentation, and verification commands that Phase 1 for six agent-native vault tools will build on (`.paw/work/agent-native-vault-tools/Spec.md:195-244`, `.paw/work/agent-native-vault-tools/Spec.md:369-387`).

## Summary

The current vault tool surface is declared in a central manifest and rendered into the session preamble from `ALL_VAULT_TOOL_ENTRIES`; tool factories separately attach SDK descriptions, JSON schemas, permission flags, and handlers with `defineTool` (`src/domain/vaultToolManifest.ts:168-180`, `src/domain/PreambleAssembler.ts:158-188`, `src/tools/ReadTools.ts:79-180`, `src/tools/ReadNoteTools.ts:52-228`, `src/tools/SearchTools.ts:43-116`). Runtime registration concatenates raw read/write, read-note, search, and write-note tools, gates raw filesystem tools if configured, then passes the resulting tool list to `CopilotAgentSession` (`src/main.ts:661-701`, `src/main.ts:711-740`). The existing `search_content` tool accepts only `query` and optional `regex`, returns `{ matches, totalMatches, truncated }`, reads markdown files serially, and caps returned matches at 50 with 80-character snippets (`src/tools/ReadTools.ts:147-178`, `src/tools/ReadTools.ts:275-358`).

## Documentation System

- **Framework**: Plain Markdown plus JSON Schema assets; no mkdocs/docusaurus/sphinx config was found by repository glob (`README.md:1-5`, `docs/preset-packs.md:51-84`, `package.json:8-28`).
- **Docs Directory**: `docs/` contains user guides and schema assets (`docs/m365-graph-mcp.md:1-20`, `docs/preset-packs.md:1-15`, `docs/schemas/preset-pack-v1.json`).
- **Navigation Config**: N/A; no `mkdocs.yml`, Docusaurus sidebar, or Sphinx config appears in the repository file inventory.
- **Style Conventions**: README uses release-oriented sections headed `## What's new in vX.Y` and links to focused docs (`README.md:7-38`, `README.md:40-52`); docs use task-oriented user-guide headings, numbered quick starts, tables, JSON code blocks, and troubleshooting sections (`docs/m365-graph-mcp.md:21-40`, `docs/m365-graph-mcp.md:45-75`, `docs/m365-graph-mcp.md:76-117`, `docs/preset-packs.md:86-120`). Proposals use numbered `NNNN-short-slug.md` files with `Problem`, `Sketch`, and `Open questions` expectations (`proposals/README.md:5-17`).
- **Build Command**: N/A for docs; package scripts include build/test/typecheck/schema checks, but no docs build script (`package.json:8-28`).
- **Standard Files**: `README.md`, `CHANGELOG.md`, `RELEASING.md`, `docs/m365-graph-mcp.md`, `docs/preset-packs.md`, `proposals/README.md` (`README.md:1-5`, `CHANGELOG.md:1-5`, `proposals/README.md:1-17`).

## Verification Commands

- **Test Command**: `npm test` runs `vitest run`; `pretest` generates the pinned binary version first (`package.json:11-28`).
- **Lint Command**: N/A; no lint script is declared in `package.json` (`package.json:8-28`).
- **Build Command**: `npm run build` runs `node esbuild.config.mjs production`; `prebuild` generates the pinned binary version first (`package.json:8-28`).
- **Type Check**: `npm run typecheck` runs `tsc --noEmit`; `pretypecheck` generates the pinned binary version first (`package.json:11-28`).
- **Schema Check**: `npm run schema:check` runs `node scripts/check-pack-schema.mjs` (`package.json:12-13`).

## Detailed Findings

### Existing tool inventory / manifest layer

- `VaultToolEntry` carries `name`, one-line `hint`, and `readOnly`; comments describe it as the single source of truth for preamble inventory names and usage hints (`src/domain/vaultToolManifest.ts:1-26`).
- `V01_TOOL_ENTRIES` declares the six raw filesystem tools: `view`, `read_file`, `search_content`, `create_file`, `edit_file`, and `delete_file`, with read-only flags for the three read tools and mutating flags for writes (`src/domain/vaultToolManifest.ts:28-63`).
- `READ_NOTE_TOOL_ENTRIES` declares `get_active_note`, `list_recent_notes`, `find_backlinks`, `vault_tree`, `vault_metadata`, and `find_tasks`, all read-only (`src/domain/vaultToolManifest.ts:65-102`).
- `WRITE_NOTE_TOOL_ENTRIES` declares workspace/write note tools; `open_note` is marked read-only while `create_note`, `edit_note`, `insert_into_active_note`, `create_daily_note`, `create_task`, and `update_task` are marked non-read-only (`src/domain/vaultToolManifest.ts:104-144`).
- `V03_READ_TOOL_ENTRIES` declares `search_by_tag`, `search_by_name`, and `list_all_tags`, all read-only and described as auto-approved read search tools (`src/domain/vaultToolManifest.ts:146-166`).
- `ALL_VAULT_TOOL_ENTRIES` concatenates read-note, v0.3 search, write-note, and v0.1 raw entries in inventory presentation order; the manifest also exports name arrays used by tool modules and gating (`src/domain/vaultToolManifest.ts:168-204`).
- Tool descriptions, schemas, permission flags, and executor handlers are attached in tool factories using `defineTool`; examples include `search_content` (`src/tools/ReadTools.ts:147-178`), read-note tools (`src/tools/ReadNoteTools.ts:57-227`), and v0.3 search tools (`src/tools/SearchTools.ts:48-114`).
- Preamble generation imports `ALL_VAULT_TOOL_ENTRIES` and `V01_RAW_FS_TOOL_NAMES`, builds full and gated inventory blocks, appends optional MCP inventory, and emits the inventory inside default/custom preambles (`src/domain/PreambleAssembler.ts:1-4`, `src/domain/PreambleAssembler.ts:64-78`, `src/domain/PreambleAssembler.ts:98-134`, `src/domain/PreambleAssembler.ts:136-188`).
- `buildToolInventoryBlock` adds `(R/O)` for read-only manifest entries and `(fallback)` for raw filesystem entries when raw tools are exposed (`src/domain/PreambleAssembler.ts:158-188`).

### Obsidian API wrapper

- `ObsidianApi` wraps a narrow `AppLike` rather than importing Obsidian `App`; `AppLike` includes `app.vault`, `workspace`, `metadataCache`, `internalPlugins`, and `plugins` surfaces used by read and write tools (`src/tools/ObsidianApi.ts:1-21`, `src/tools/ObsidianApi.ts:86-144`).
- Vault wrapper fields include read-tool vault methods plus `create` and `modify`; workspace wrapper fields include active-file/view lookup, leaf opening, and `openLinkText`; metadata wrapper includes `resolvedLinks`, `getFileCache`, and optional `getTags`; plugin wrappers include Daily Notes internal plugin options and community plugin registry (`src/tools/ObsidianApi.ts:90-144`).
- The wrapper returns `ApiResult<T>` discriminated unions with reasons including `no-active-note`, `plugin-not-enabled`, `index-unavailable`, `not-found`, `invalid-path`, and `metadata-cache-not-ready` (`src/tools/ObsidianApi.ts:26-42`).
- Existing read helpers relevant to new tools include markdown-file enumeration and mtime sorting via `listRecentlyModifiedNotes` (`src/tools/ObsidianApi.ts:204-225`), active markdown file lookup via `getActiveFile` (`src/tools/ObsidianApi.ts:176-202`), resolved link graph access via `getResolvedLinks` (`src/tools/ObsidianApi.ts:227-241`), and per-file metadata retrieval via `getFileCache` (`src/tools/ObsidianApi.ts:243-263`).
- Tag helpers include native `metadataCache.getTags()` plus fallback scan of `vault.getMarkdownFiles()` and `metadataCache.getFileCache(file)` (`src/tools/ObsidianApi.ts:265-324`), per-tag file discovery via `findFilesByTag` (`src/tools/ObsidianApi.ts:326-362`), and reusable tag normalization/collection helpers (`src/tools/ObsidianApi.ts:818-859`).
- Structure/navigation helpers include bounded folder tree walking with `getVaultTree` (`src/tools/ObsidianApi.ts:364-458`, `src/tools/ObsidianApi.ts:773-815`) and metadata extraction later shaped by `vaultMetadataImpl` (`src/tools/ReadNoteTools.ts:542-613`).
- Workspace/write helpers currently exposed on the same wrapper include `openFile`, `getEditorForActive`, `applyEditorTransform`, `getDailyNotesConfig`, `isCommunityPluginEnabled`, `createNote`, `modifyNote`, `getActiveNotePath`, and `isActiveFileReadOnly` (`src/tools/ObsidianApi.ts:467-748`).

### Current `search_content` implementation

- The `search_content` SDK tool description says it searches markdown files for a substring or regex and returns up to 50 `{ path, line, snippet }` matches (`src/tools/ReadTools.ts:147-151`).
- Its current schema requires `query` and accepts optional boolean `regex`; `additionalProperties: false` means no path filter, case-sensitivity flag, caller-supplied cap, or snippet-radius option is accepted today (`src/tools/ReadTools.ts:152-166`).
- The handler validates non-empty string `query`, coerces `regex` with `Boolean(parsed.regex)`, and calls `searchContentImpl(query, isRegex, vault)` (`src/tools/ReadTools.ts:167-178`).
- `MAX_SEARCH_MATCHES` is `50` and `SNIPPET_RADIUS` is `80` (`src/tools/ReadTools.ts:30-37`).
- `searchContentImpl` returns `{ matches: Array<{ path, line, snippet }>, totalMatches, truncated }` (`src/tools/ReadTools.ts:275-283`, `src/tools/ReadTools.ts:358`).
- Regex mode constructs `new RegExp(query)` and uses `re.exec(line)` to find the first match index, returning an `Invalid regex` error on construction failure (`src/tools/ReadTools.ts:286-299`). Substring mode uses `line.indexOf(query)` exactly as provided (`src/tools/ReadTools.ts:300-302`).
- The executor obtains files from `vault.getMarkdownFiles()`, validates each candidate with `resolveVaultPath`, reads with `cachedRead` before `read`, skips unreadable files, splits content into lines, records 1-based line numbers, and slices snippets from `idx - SNIPPET_RADIUS` through `idx + query.length + SNIPPET_RADIUS` (`src/tools/ReadTools.ts:284-347`).
- It records only the first 50 matches, sets `truncated` after the cap, continues counting after the cap, and stops the outer scan when `total >= MAX_SEARCH_MATCHES * 4` (`src/tools/ReadTools.ts:333-358`).

### Sibling read tools and patterns

- `get_active_note` has an empty-object schema, `skipPermission: true`, and returns `{ ok: true, path, content }` or `{ ok: false, reason: "no_active_note" }` after `api.getActiveFile()` and vault read/cachedRead (`src/tools/ReadNoteTools.ts:57-69`, `src/tools/ReadNoteTools.ts:233-253`).
- `list_recent_notes` accepts optional numeric `n`, defaults to `RECENT_DEFAULT = 20`, clamps through `ObsidianApi.listRecentlyModifiedNotes` to `[1,100]`, and returns `{ notes, requested, returned }` (`src/tools/ReadNoteTools.ts:21-24`, `src/tools/ReadNoteTools.ts:71-96`, `src/tools/ReadNoteTools.ts:260-277`, `src/tools/ObsidianApi.ts:204-225`).
- `find_backlinks` requires `targetPath`, validates it with `resolveVaultPath`, prefers `metadataCache.resolvedLinks`, consults per-source file cache for link form, and returns `{ target, backlinks, usedFallback, truncated }` with `BACKLINK_SNIPPET_CAP = 50` (`src/tools/ReadNoteTools.ts:25-26`, `src/tools/ReadNoteTools.ts:98-122`, `src/tools/ReadNoteTools.ts:279-348`).
- `find_backlinks` fallback scans up to `FALLBACK_MAX_FILES = 500`, caps each file at `FALLBACK_MAX_BYTES_PER_FILE = 256 * 1024`, uses wikilink and Markdown-link regexes, and returns the same result shape with `usedFallback: true` (`src/tools/ReadNoteTools.ts:401-498`).
- `vault_tree` accepts optional `folder` and `depth`, uses `DEFAULT_TREE_DEPTH = 2`, `MAX_TREE_DEPTH = 5`, and `MAX_TREE_NODES = 500`, and returns either `{ ok: true, root, nodeCount, truncated, truncatedAt? }` or structured not-found/not-folder/invalid-path reasons (`src/tools/ObsidianApi.ts:166-171`, `src/tools/ReadNoteTools.ts:125-155`, `src/tools/ReadNoteTools.ts:504-540`).
- `vault_metadata` requires `path`, validates/looks up a note, reads file cache and resolved links, and returns `{ ok: true, path, tags, headings, frontmatter, outboundLinks, stat }` without note body, or structured not-found/invalid-path reasons (`src/tools/ReadNoteTools.ts:157-181`, `src/tools/ReadNoteTools.ts:542-613`).
- `find_tasks` accepts optional `path`, `tag`, `status`, `dueBefore`, `dueAfter`, and `descriptionRegex`, passes a filtered `FindTasksFilter` to `findTasksImpl`, and is registered as read-only with `skipPermission: true` (`src/tools/ReadNoteTools.ts:184-227`). `findTasksImpl` caps results at 500 and per-file size at 5 MiB, validates strict dates and regex, uses metadata-cache `listItems`, reads each file once, and returns `{ ok: true, results, truncated, scanned }` or structured invalid reasons (`src/tools/FindTasks.ts:1-18`, `src/tools/FindTasks.ts:30-68`, `src/tools/FindTasks.ts:71-179`).
- `search_by_tag` requires `tag`, normalizes with/without `#`, caps matches at `SEARCH_BY_TAG_CAP = 200`, sorts paths, and returns `{ ok: true, tag, matches, total, truncated }` or `metadata-cache-not-ready`/`invalid-tag` (`src/tools/SearchTools.ts:14-17`, `src/tools/SearchTools.ts:48-73`, `src/tools/SearchTools.ts:127-135`, `src/tools/SearchTools.ts:166-193`).
- `search_by_name` requires `query`, ranks exact > prefix > substring case-insensitively, caps at `SEARCH_BY_NAME_CAP = 50`, and returns `{ ok: true, query, matches, total, truncated }` or `invalid-query` (`src/tools/SearchTools.ts:75-99`, `src/tools/SearchTools.ts:137-145`, `src/tools/SearchTools.ts:195-236`).
- `list_all_tags` has an empty-object schema, returns sorted `{ tag, count }` entries on success, and returns `metadata-cache-not-ready` when tag inventory cannot be read (`src/tools/SearchTools.ts:101-114`, `src/tools/SearchTools.ts:147-153`, `src/tools/SearchTools.ts:238-254`).
- Common patterns across read tools are `defineTool` JSON schemas with `additionalProperties: false`, explicit required fields where applicable, `skipPermission: true` for read-only tools, helper implementations exported for tests, cap constants near the implementation, and structured result objects for recoverable conditions (`src/tools/ReadTools.ts:79-180`, `src/tools/ReadNoteTools.ts:52-228`, `src/tools/SearchTools.ts:19-42`).

### Tool registration / dispatch pipeline

- `main.ts` imports all vault tool factories: `createReadTools`, `createWriteTools`, `createReadNoteTools`, `createWriteNoteTools`, and `createSearchTools` (`src/main.ts:29-35`).
- During runtime factory construction, `main.ts` creates raw read tools, write tools, read-note tools, search tools, and write-note tools, concatenates them into `vaultTools`, then applies `filterRawFsToolsIfGated` (`src/main.ts:661-702`).
- `filterRawFsToolsIfGated` filters by `V01_RAW_FS_TOOL_NAMES` when raw filesystem tools are not exposed, keeping SDK-bound tools and preamble gating keyed to the same manifest list (`src/domain/toolGating.ts:1-23`).
- `CopilotAgentSession` receives `tools: vaultTools` plus an MCP tool producer; MCP tools are created from the current registry snapshot with `createMcpSdkTools` (`src/main.ts:703-740`).
- `AgentSessionOptions.tools` stores registered custom tools, and `SdkTool` includes `name`, `description`, `parameters`, `handler`, `overridesBuiltInTool`, and `skipPermission` (`src/sdk/AgentSession.ts:125-130`, `src/sdk/AgentSession.ts:176-188`).
- `toolsForSession()` merges the static custom tool list with the current MCP tool snapshot and returns the combined array to SDK session creation and live refresh (`src/sdk/AgentSession.ts:1217-1228`).
- SDK sessions are created/resumed with `availableTools: ["builtin:*", "custom:*", "mcp:*"]`, `tools: this.toolsForSession()`, and `onPermissionRequest: this.handlePermission` (`src/sdk/AgentSession.ts:1526-1533`, `src/sdk/AgentSession.ts:1725-1733`).
- Tool-call UI routing listens for `tool.execution_start` and `tool.execution_complete`, classifies sources by tool name/kind, records argument previews and results, and emits stream events (`src/sdk/AgentSession.ts:825-929`, `src/sdk/AgentSession.ts:2380-2386`).
- Permission handling classifies registered custom tools, auto-apply/approval/rejection paths, and vault write tools via `isVaultWriteToolName`; read-only custom tools with `skipPermission: true` run through SDK tool execution rather than the permission prompt path (`src/sdk/AgentSession.ts:1864-1928`, `src/sdk/AgentSession.ts:1942-2010`, `src/sdk/AgentSession.ts:2136-2179`).
- Argument validation is represented in each tool's SDK `parameters` schema and in handler-level checks/casts; examples include `parseArgs` for `read_file`, explicit non-empty `query` for `search_content`, required `targetPath`/`path` checks in read-note tools, and typed filter construction for `find_tasks` (`src/tools/ReadTools.ts:152-178`, `src/tools/ReadTools.ts:361-379`, `src/tools/ReadNoteTools.ts:116-121`, `src/tools/ReadNoteTools.ts:175-180`, `src/tools/ReadNoteTools.ts:209-225`).

### Test conventions

- Tests are colocated under `src/**` using `.test.ts` filenames, and Vitest includes `src/**/*.test.ts` with Node environment (`vitest.config.ts:12-18`).
- The test framework is Vitest, declared in dev dependencies and invoked by `npm test` (`package.json:11-13`, `package.json:37-44`).
- The Vitest config aliases `obsidian` to `src/test/obsidianMock.ts`, whose mock exports Obsidian classes such as `Plugin`, `MarkdownView`, `Notice`, and UI component shells (`vitest.config.ts:4-10`, `src/test/obsidianMock.ts:1-128`).
- Tool tests commonly build narrow fixtures rather than whole Obsidian apps: `ReadTools.test.ts` defines `makeVault()` with `getMarkdownFiles`, `getFiles`, `read`, and `cachedRead` (`src/tools/ReadTools.test.ts:40-56`); `ReadNoteTools.test.ts` defines `makeApp()` returning `{ app, vault }` with workspace and metadata cache stubs (`src/tools/ReadNoteTools.test.ts:39-107`); `SearchTools.test.ts` defines `makeFixture()` with files, file caches, optional `getTags`, and `ObsidianApi` (`src/tools/SearchTools.test.ts:22-70`).
- `ReadTools.test.ts` covers `searchContentImpl` substring, regex, invalid regex, 1-based line numbers, symlink escape skipping, and factory metadata for `search_content` (`src/tools/ReadTools.test.ts:111-188`, `src/tools/ReadTools.test.ts:190-202`).
- `SearchTools.test.ts` covers `search_by_tag`, `search_by_name`, `list_all_tags`, cap behavior, ordering, metadata-cache-not-ready shapes, and manifest-name matching (`src/tools/SearchTools.test.ts:72-209`, `src/tools/SearchTools.test.ts:211-294`, `src/tools/SearchTools.test.ts:296-412`).
- `ReadNoteTools.test.ts` covers `get_active_note`, `list_recent_notes`, and `find_backlinks` resolved-link/fallback paths with link-form discrimination (`src/tools/ReadNoteTools.test.ts:109-173`, `src/tools/ReadNoteTools.test.ts:175-220`).
- `FindTasks.test.ts` covers metadata-cache task enumeration, filters, structured invalid regex/date responses, single-path scoping, 500-hit truncation, and parsed task flavors (`src/tools/FindTasks.test.ts:55-211`).
- `ObsidianApi.test.ts` covers wrapper error-shape behavior, active-file lookup, recent-note sorting/clamping, resolved links, file cache access, and tree caps via `MAX_TREE_NODES` (`src/tools/ObsidianApi.test.ts:121-163`, `src/tools/ObsidianApi.test.ts:166-239`, `src/tools/ObsidianApi.test.ts:241-260`, `src/tools/ObsidianApi.test.ts:475-507`).

## Code References

- `src/domain/vaultToolManifest.ts:19-26` - `VaultToolEntry` shape.
- `src/domain/vaultToolManifest.ts:32-63` - v0.1 raw filesystem entries.
- `src/domain/vaultToolManifest.ts:71-102` - read-note entries.
- `src/domain/vaultToolManifest.ts:108-144` - write/workspace entries.
- `src/domain/vaultToolManifest.ts:150-166` - v0.3 read search entries.
- `src/domain/vaultToolManifest.ts:168-204` - combined inventory and exported name arrays.
- `src/domain/PreambleAssembler.ts:98-134` - default/custom preamble assembly.
- `src/domain/PreambleAssembler.ts:158-188` - inventory block generation from manifest.
- `src/tools/ObsidianApi.ts:90-144` - wrapped Obsidian app/vault/workspace/metadata/plugin surfaces.
- `src/tools/ObsidianApi.ts:176-263` - active file, recent notes, resolved links, and file cache helpers.
- `src/tools/ObsidianApi.ts:265-362` - tag collection and tag-file lookup helpers.
- `src/tools/ObsidianApi.ts:364-458` - bounded vault tree helper.
- `src/tools/ObsidianApi.ts:467-748` - workspace/write helper surface.
- `src/tools/ReadTools.ts:147-178` - `search_content` SDK declaration.
- `src/tools/ReadTools.ts:275-358` - `searchContentImpl` executor.
- `src/tools/ReadNoteTools.ts:57-227` - read-note tool SDK declarations.
- `src/tools/ReadNoteTools.ts:285-348` - resolved-link backlink implementation.
- `src/tools/ReadNoteTools.ts:406-498` - backlink fallback implementation.
- `src/tools/ReadNoteTools.ts:514-613` - `vault_tree` and `vault_metadata` result shaping.
- `src/tools/SearchTools.ts:43-116` - v0.3 search tool SDK declarations.
- `src/tools/SearchTools.ts:166-254` - `search_by_tag`, `search_by_name`, and `list_all_tags` implementations.
- `src/tools/FindTasks.ts:71-179` - `find_tasks` implementation.
- `src/main.ts:661-740` - runtime tool construction and session option wiring.
- `src/sdk/AgentSession.ts:1217-1228` - custom/MCP tool list merging.
- `src/sdk/AgentSession.ts:1725-1733` - SDK `createSession` with tools and permission callback.
- `src/sdk/AgentSession.ts:1864-2010` - permission callback flow.
- `src/tools/ReadTools.test.ts:111-188` - `search_content` regression coverage.
- `src/tools/SearchTools.test.ts:72-412` - search sibling tool coverage.
- `src/tools/ReadNoteTools.test.ts:39-107` - Obsidian app/vault fixture pattern for read-note tests.

## Architecture Documentation

- Tool names/hints/read-only status are manifest data used by preamble rendering, while runtime executor descriptions/schemas/handlers are declared in SDK tool factories (`src/domain/vaultToolManifest.ts:19-26`, `src/domain/PreambleAssembler.ts:158-188`, `src/tools/ReadTools.ts:79-180`, `src/tools/ReadNoteTools.ts:52-228`, `src/tools/SearchTools.ts:43-116`).
- Read-only auto-approved vault tools consistently set `skipPermission: true` in the SDK tool declarations (`src/tools/ReadTools.ts:98-99`, `src/tools/ReadTools.ts:130-131`, `src/tools/ReadTools.ts:167-168`, `src/tools/ReadNoteTools.ts:67-68`, `src/tools/SearchTools.ts:67-68`).
- Path-shaped read inputs use `resolveVaultPath`/`toVaultRelative`/`lookupTFile` in implementation layers for vault-relative normalization and lookup (`src/tools/ReadTools.ts:185-224`, `src/tools/ReadTools.ts:246-260`, `src/tools/ReadNoteTools.ts:295-304`, `src/tools/ReadNoteTools.ts:559-579`).
- Metadata-dependent read tools use `ObsidianApi` discriminated unions and translate unavailable native/cache states into structured tool results (`src/tools/ObsidianApi.ts:26-42`, `src/tools/SearchTools.ts:174-185`, `src/tools/SearchTools.ts:241-244`, `src/tools/ReadNoteTools.ts:529-539`).
- Tool tests use small in-memory fixtures and exported implementation helpers rather than invoking the full SDK session (`src/tools/ReadTools.test.ts:40-56`, `src/tools/ReadNoteTools.test.ts:39-107`, `src/tools/SearchTools.test.ts:22-70`, `src/tools/FindTasks.test.ts:8-53`).

## Open Questions

None.
