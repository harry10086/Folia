import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { open, save } from "@tauri-apps/plugin-dialog";
import { openPath, openUrl } from "@tauri-apps/plugin-opener";

export type FileKind = "folder" | "markdown" | "html" | "image" | "pdf" | "terminal" | "other";
export type LineEnding = "LF" | "CRLF";

export interface FileNode {
  name: string;
  path: string;
  workspaceId: string;
  kind: FileKind;
  extension: string;
  sizeBytes: number;
  mtimeMs: number;
  children?: FileNode[];
}

export interface FileDocument {
  path: string;
  content: string;
  encoding: string;
  hasBom: boolean;
  lineEnding: LineEnding;
  hash: string;
  mtimeMs: number;
  sizeBytes: number;
  isLarge: boolean;
}

export interface SaveFileResult {
  path: string;
  hash: string;
  mtimeMs: number;
  sizeBytes: number;
}

export interface ConflictPayload {
  diskContent: string;
  diskHash: string;
  diskMtimeMs: number;
  encoding: string;
  hasBom: boolean;
  lineEnding: LineEnding;
}

export interface FoliaIpcError {
  code: string;
  message: string;
  conflict?: ConflictPayload;
}

export interface AttachmentItem {
  name: string;
  path: string;
  relativePath: string;
  kind: FileKind;
  extension: string;
  sizeBytes: number;
  mtimeMs: number;
}

export interface SaveAssetResult {
  absolutePath: string;
  relativePath: string;
}

export interface SearchScopeRoot {
  workspaceId: string;
  rootPath: string;
}

export interface SearchRequest {
  roots: SearchScopeRoot[];
  query: string;
  caseSensitive?: boolean;
  wholeWord?: boolean;
  useRegex?: boolean;
  maxResults?: number;
}

export interface SearchMatch {
  workspaceId: string;
  path: string;
  fileName: string;
  lineNumber: number;
  lineText: string;
  matchStart: number;
  matchEnd: number;
}

export interface SearchResponse {
  matches: SearchMatch[];
  truncated: boolean;
  scannedFiles: number;
  cancelled: boolean;
}

export interface RecoveryDraft {
  path: string;
  content: string;
  baseHash: string;
  updatedAtMs: number;
}

export interface ExternalFileEvent {
  path: string;
  kind: "modified" | "deleted";
  hash?: string;
  mtimeMs?: number;
}

export interface TreeChangedEvent {
  paths: string[];
}

export interface SpawnTerminalResult {
  id: string;
  shellLabel: string;
  program: string;
  cwd: string;
}

export interface TerminalDataEvent {
  id: string;
  data: string;
}

export interface TerminalExitEvent {
  id: string;
}

export interface DetectedShellInfo {
  id: string;
  label: string;
  available: boolean;
  path: string;
}

export interface HistoryEntryMeta {
  id: string;
  timestampMs: number;
  hash: string;
  reason: string;
  chars: number;
  lines: number;
  sizeBytes: number;
}

export interface HistoryStats {
  totalSnapshots: number;
  totalBytes: number;
}

export function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export function isWindowsPlatform(): boolean {
  return typeof navigator !== "undefined" && /Windows/i.test(navigator.userAgent);
}

export function isMacPlatform(): boolean {
  return typeof navigator !== "undefined" && /Mac|iPhone|iPad/i.test(navigator.userAgent);
}

export function toAssetUrl(absPath: string, version?: number, notePath?: string | null): string {
  const params = new URLSearchParams();
  if (version) params.set("v", String(version));
  if (notePath) params.set("note", notePath);
  const query = params.toString() ? `?${params.toString()}` : "";

  if (isTauriRuntime()) {
    return `${convertFileSrc(absPath, "folia-asset")}${query}`;
  }

  const normalized = absPath.replace(/\\/g, "/");
  const segments = normalized.split("/").map((seg, idx) => {
    if (idx === 0 && /^[A-Za-z]:$/.test(seg)) return seg;
    return encodeURIComponent(seg);
  });
  const encodedPath = segments.join("/").replace(/^\/+/, "");
  if (isWindowsPlatform()) {
    return `http://folia-asset.localhost/${encodedPath}${query}`;
  }
  return `folia-asset://localhost/${encodedPath}${query}`;
}

export function parseIpcError(err: unknown): FoliaIpcError {
  if (typeof err === "object" && err !== null && "code" in err && "message" in err) {
    return err as FoliaIpcError;
  }
  if (typeof err === "string") {
    try {
      const parsed = JSON.parse(err);
      if (parsed && typeof parsed.code === "string") return parsed as FoliaIpcError;
    } catch {
      // plain string
    }
    return { code: "UNKNOWN", message: err };
  }
  return { code: "UNKNOWN", message: err instanceof Error ? err.message : String(err) };
}

export const ipc = {
  registerWorkspaces(roots: string[]): Promise<string[]> {
    return invoke<string[]>("register_workspaces", { roots });
  },

  scanWorkspace(workspaceId: string, rootPath: string, showHidden = false): Promise<FileNode> {
    return invoke<FileNode>("scan_workspace", { workspaceId, rootPath, showHidden });
  },

  readFile(path: string): Promise<FileDocument> {
    return invoke<FileDocument>("read_file", { path });
  },

  saveFile(params: {
    path: string;
    content: string;
    encoding: string;
    hasBom: boolean;
    lineEnding: LineEnding;
    expectedHash?: string | null;
    force?: boolean;
  }): Promise<SaveFileResult> {
    return invoke<SaveFileResult>("save_file", {
      path: params.path,
      content: params.content,
      encoding: params.encoding,
      hasBom: params.hasBom,
      lineEnding: params.lineEnding,
      expectedHash: params.expectedHash ?? null,
      force: params.force ?? false,
    });
  },

  createFile(parentDir: string, name: string, initialContent = ""): Promise<string> {
    return invoke<string>("create_file", { parentDir, name, initialContent });
  },

  createFolder(parentDir: string, name: string): Promise<string> {
    return invoke<string>("create_folder", { parentDir, name });
  },

  renamePath(oldPath: string, newName: string): Promise<string> {
    return invoke<string>("rename_path", { oldPath, newName });
  },

  movePath(srcPath: string, destDir: string): Promise<string> {
    return invoke<string>("move_path", { srcPath, destDir });
  },

  copyPath(srcPath: string, destDir: string): Promise<string> {
    return invoke<string>("copy_path", { srcPath, destDir });
  },

  deleteToTrash(path: string): Promise<void> {
    return invoke<void>("delete_to_trash", { path });
  },

  listAttachments(notePath: string): Promise<AttachmentItem[]> {
    return invoke<AttachmentItem[]>("list_attachments", { notePath });
  },

  savePastedImage(params: {
    notePath: string;
    workspaceRoot: string;
    strategy: string;
    customDir: string;
    suggestedName?: string | null;
    ext: string;
    base64Data: string;
  }): Promise<SaveAssetResult> {
    return invoke<SaveAssetResult>("save_pasted_image", {
      notePath: params.notePath,
      workspaceRoot: params.workspaceRoot,
      strategy: params.strategy,
      customDir: params.customDir,
      suggestedName: params.suggestedName ?? null,
      ext: params.ext,
      base64Data: params.base64Data,
    });
  },

  copyDroppedAsset(params: {
    notePath: string;
    workspaceRoot: string;
    sourcePath: string;
    strategy: string;
    customDir: string;
  }): Promise<SaveAssetResult> {
    return invoke<SaveAssetResult>("copy_dropped_asset", params);
  },

  computeRelativeLink(fromNotePath: string, targetPath: string): Promise<string> {
    return invoke<string>("compute_relative_link", { fromNotePath, targetPath });
  },

  resolveRelativePath(fromNotePath: string, relativePath: string): Promise<string> {
    return invoke<string>("resolve_relative_path", { fromNotePath, relativePath });
  },

  searchFilesContent(req: SearchRequest): Promise<SearchResponse> {
    return invoke<SearchResponse>("search_files_content", { req });
  },

  cancelSearch(): Promise<void> {
    return invoke<void>("cancel_search");
  },

  loadAppConfig(): Promise<Record<string, unknown> | null> {
    return invoke<Record<string, unknown> | null>("load_app_config");
  },

  saveAppConfig(configData: Record<string, unknown>): Promise<void> {
    return invoke<void>("save_app_config", { configData });
  },

  saveRecoveryDraft(draft: RecoveryDraft): Promise<void> {
    return invoke<void>("save_recovery_draft", { draft });
  },

  deleteRecoveryDraft(path: string): Promise<void> {
    return invoke<void>("delete_recovery_draft", { path });
  },

  listRecoveryDrafts(): Promise<RecoveryDraft[]> {
    return invoke<RecoveryDraft[]>("list_recovery_drafts");
  },

  exportHtmlFile(targetPath: string, html: string): Promise<void> {
    return invoke<void>("export_html_file", { targetPath, html });
  },

  readBinaryBase64(path: string): Promise<string> {
    return invoke<string>("read_binary_base64", { path });
  },

  revealInFileManager(path: string): Promise<void> {
    return invoke<void>("reveal_in_file_manager", { path });
  },

  async pickFolderDialog(title = "选择笔记文件夹"): Promise<string | null> {
    const selected = await open({ directory: true, multiple: false, title });
    return typeof selected === "string" ? selected : null;
  },

  async pickSaveHtmlDialog(defaultName: string): Promise<string | null> {
    const selected = await save({
      title: "导出为 HTML",
      defaultPath: defaultName,
      filters: [{ name: "HTML 文档", extensions: ["html", "htm"] }],
    });
    return selected ?? null;
  },

  openExternalUrl(url: string): Promise<void> {
    return openUrl(url);
  },

  openSystemPath(path: string): Promise<void> {
    return openPath(path);
  },

  onExternalFileChanged(cb: (ev: ExternalFileEvent) => void): Promise<UnlistenFn> {
    return listen<ExternalFileEvent>("fs:file-changed", (e) => cb(e.payload));
  },

  onTreeChanged(cb: (ev: TreeChangedEvent) => void): Promise<UnlistenFn> {
    return listen<TreeChangedEvent>("fs:tree-changed", (e) => cb(e.payload));
  },

  terminalSpawn(params: {
    cwd: string;
    shellType: string;
    customPath?: string | null;
    cols: number;
    rows: number;
  }): Promise<SpawnTerminalResult> {
    return invoke<SpawnTerminalResult>("terminal_spawn", {
      cwd: params.cwd,
      shellType: params.shellType,
      customPath: params.customPath ?? null,
      cols: params.cols,
      rows: params.rows,
    });
  },

  terminalWrite(id: string, data: string): Promise<void> {
    return invoke<void>("terminal_write", { id, data });
  },

  terminalResize(id: string, cols: number, rows: number): Promise<void> {
    return invoke<void>("terminal_resize", { id, cols, rows });
  },

  terminalKill(id: string): Promise<void> {
    return invoke<void>("terminal_kill", { id });
  },

  terminalListShells(): Promise<DetectedShellInfo[]> {
    return invoke<DetectedShellInfo[]>("terminal_list_shells");
  },

  onTerminalData(cb: (ev: TerminalDataEvent) => void): Promise<UnlistenFn> {
    return listen<TerminalDataEvent>("terminal:data", (e) => cb(e.payload));
  },

  onTerminalExit(cb: (ev: TerminalExitEvent) => void): Promise<UnlistenFn> {
    return listen<TerminalExitEvent>("terminal:exit", (e) => cb(e.payload));
  },

  setTrayBehavior(minimizeToTray: boolean, closeToTray: boolean): Promise<void> {
    return invoke<void>("set_tray_behavior", { minimizeToTray, closeToTray });
  },

  hideToTray(): Promise<void> {
    return invoke<void>("hide_to_tray");
  },

  showMainWindow(): Promise<void> {
    return invoke<void>("show_main_window");
  },

  quitApp(): Promise<void> {
    return invoke<void>("quit_app");
  },

  historySaveSnapshot(params: {
    path: string;
    content: string;
    reason: string;
    minIntervalSecs: number;
    maxSnapshots: number;
    force: boolean;
  }): Promise<HistoryEntryMeta | null> {
    return invoke<HistoryEntryMeta | null>("history_save_snapshot", params);
  },

  historyList(path: string): Promise<HistoryEntryMeta[]> {
    return invoke<HistoryEntryMeta[]>("history_list", { path });
  },

  historyRead(path: string, id: string): Promise<string> {
    return invoke<string>("history_read", { path, id });
  },

  historyDeleteEntry(path: string, id: string): Promise<void> {
    return invoke<void>("history_delete_entry", { path, id });
  },

  historyStats(): Promise<HistoryStats> {
    return invoke<HistoryStats>("history_stats");
  },

  historyClearAll(): Promise<number> {
    return invoke<number>("history_clear_all");
  },
};
