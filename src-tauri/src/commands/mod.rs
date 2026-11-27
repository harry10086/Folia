use crate::config::{self, RecoveryDraft};
use crate::error::{ConflictPayload, FoliaError};
use crate::fs::encoding::LineEnding;
use crate::fs::{
    self, canonicalize_clean, compute_disk_hash, compute_relative_posix, normalize_lexical,
    path_to_string, AttachmentItem, FileDocument, FileNode, SaveFileResult,
};
use crate::history::{self, HistoryEntryMeta, HistoryStats};
use crate::search::{SearchManager, SearchRequest, SearchResponse};
use crate::terminal::{detect_available_shells, DetectedShellInfo, SpawnTerminalResult, TerminalManager};
use crate::watcher::WatcherService;
use base64::Engine;
use parking_lot::RwLock;
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Manager, State};

#[derive(Debug, Clone, Default)]
pub struct TrayBehavior {
    pub minimize_to_tray: bool,
    pub close_to_tray: bool,
}

pub struct AppRuntimeState {
    pub workspace_roots: Arc<RwLock<Vec<PathBuf>>>,
    pub watcher: WatcherService,
    pub search: SearchManager,
    pub terminal: TerminalManager,
    pub app_data_dir: PathBuf,
    pub tray_behavior: Arc<RwLock<TrayBehavior>>,
    pub was_maximized: Arc<AtomicBool>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveAssetResult {
    pub absolute_path: String,
    pub relative_path: String,
}

#[tauri::command]
pub fn register_workspaces(
    state: State<'_, AppRuntimeState>,
    roots: Vec<String>,
) -> Result<Vec<String>, FoliaError> {
    let mut normalized = Vec::new();
    let mut new_paths = Vec::new();

    for r in roots {
        let p = PathBuf::from(&r);
        if p.exists() && p.is_dir() {
            if let Ok(canon) = canonicalize_clean(&p) {
                normalized.push(path_to_string(&canon));
                new_paths.push(canon);
            }
        }
    }

    let old_paths: Vec<PathBuf> = {
        let mut guard = state.workspace_roots.write();
        let prev = guard.clone();
        *guard = new_paths.clone();
        prev
    };

    for old in &old_paths {
        if !new_paths.contains(old) {
            let _ = state.watcher.unwatch_root(old);
        }
    }
    for np in &new_paths {
        let _ = state.watcher.watch_root(np);
    }

    Ok(normalized)
}

#[tauri::command]
pub fn scan_workspace(
    workspace_id: String,
    root_path: String,
    show_hidden: bool,
) -> Result<FileNode, FoliaError> {
    fs::scan_workspace_tree(Path::new(&root_path), &workspace_id, show_hidden)
}

#[tauri::command]
pub fn read_file(path: String) -> Result<FileDocument, FoliaError> {
    fs::read_document(Path::new(&path))
}

#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub fn save_file(
    state: State<'_, AppRuntimeState>,
    path: String,
    content: String,
    encoding: String,
    has_bom: bool,
    line_ending: String,
    expected_hash: Option<String>,
    force: bool,
) -> Result<SaveFileResult, FoliaError> {
    let target = PathBuf::from(&path);
    let canon = canonicalize_clean(&target).unwrap_or_else(|_| target.clone());
    let canon_str = path_to_string(&canon);

    if !force && canon.exists() {
        if let Some(exp) = expected_hash {
            if let Ok(disk_hash) = compute_disk_hash(&canon) {
                if disk_hash != exp {
                    let disk_doc = fs::read_document(&canon)?;
                    return Err(FoliaError::Conflict(ConflictPayload {
                        disk_content: disk_doc.content,
                        disk_hash: disk_doc.hash,
                        disk_mtime_ms: disk_doc.mtime_ms,
                        encoding: disk_doc.encoding,
                        has_bom: disk_doc.has_bom,
                        line_ending: disk_doc.line_ending.as_str().to_string(),
                    }));
                }
            }
        }
    }

    let le = LineEnding::from_label(&line_ending);
    let bytes = fs::encoding::encode_text(&content, &encoding, has_bom, le);
    let precomputed_hash = fs::encoding::hash_bytes(&bytes);

    state.watcher.guard.record_write(&canon_str, &precomputed_hash);

    let (result, _) = fs::encode_and_write(&canon, &content, &encoding, has_bom, le)?;
    let _ = config::delete_draft(&state.app_data_dir, &canon_str);
    Ok(result)
}

#[tauri::command]
pub fn create_file(
    parent_dir: String,
    name: String,
    initial_content: Option<String>,
) -> Result<String, FoliaError> {
    let created = fs::create_note_file(
        Path::new(&parent_dir),
        &name,
        initial_content.as_deref().unwrap_or(""),
    )?;
    Ok(path_to_string(&created))
}

#[tauri::command]
pub fn create_folder(parent_dir: String, name: String) -> Result<String, FoliaError> {
    let created = fs::create_folder(Path::new(&parent_dir), &name)?;
    Ok(path_to_string(&created))
}

#[tauri::command]
pub fn rename_path(old_path: String, new_name: String) -> Result<String, FoliaError> {
    let renamed = fs::rename_entry(Path::new(&old_path), &new_name)?;
    Ok(path_to_string(&renamed))
}

#[tauri::command]
pub fn move_path(src_path: String, dest_dir: String) -> Result<String, FoliaError> {
    let moved = fs::move_entry(Path::new(&src_path), Path::new(&dest_dir))?;
    Ok(path_to_string(&moved))
}

#[tauri::command]
pub fn copy_path(src_path: String, dest_dir: String) -> Result<String, FoliaError> {
    let copied = fs::copy_entry(Path::new(&src_path), Path::new(&dest_dir))?;
    Ok(path_to_string(&copied))
}

#[tauri::command]
pub fn delete_to_trash(path: String) -> Result<(), FoliaError> {
    fs::delete_to_trash(Path::new(&path))
}

#[tauri::command]
pub fn list_attachments(note_path: String) -> Result<Vec<AttachmentItem>, FoliaError> {
    fs::list_attachments(Path::new(&note_path))
}

#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub fn save_pasted_image(
    note_path: String,
    workspace_root: String,
    strategy: String,
    custom_dir: String,
    suggested_name: Option<String>,
    ext: String,
    base64_data: String,
) -> Result<SaveAssetResult, FoliaError> {
    let clean_b64 = base64_data
        .split_once(",")
        .map(|(_, b)| b)
        .unwrap_or(&base64_data);
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(clean_b64.trim())
        .map_err(|e| FoliaError::InvalidPath(format!("无效图片数据: {e}")))?;

    let (abs, rel) = fs::save_attachment_bytes(
        Path::new(&note_path),
        Path::new(&workspace_root),
        &strategy,
        &custom_dir,
        suggested_name.as_deref(),
        &ext,
        &bytes,
    )?;

    Ok(SaveAssetResult {
        absolute_path: path_to_string(&abs),
        relative_path: rel,
    })
}

#[tauri::command]
pub fn copy_dropped_asset(
    note_path: String,
    workspace_root: String,
    source_path: String,
    strategy: String,
    custom_dir: String,
) -> Result<SaveAssetResult, FoliaError> {
    let src = canonicalize_clean(Path::new(&source_path))?;
    let note = canonicalize_clean(Path::new(&note_path))?;
    let ws = canonicalize_clean(Path::new(&workspace_root))?;

    if fs::is_path_within_roots(&src, std::slice::from_ref(&ws)) {
        let doc_dir = note
            .parent()
            .ok_or_else(|| FoliaError::InvalidPath(note_path.clone()))?;
        let rel = compute_relative_posix(doc_dir, &src);
        return Ok(SaveAssetResult {
            absolute_path: path_to_string(&src),
            relative_path: rel,
        });
    }

    let bytes = std::fs::read(&src)?;
    let ext = src
        .extension()
        .map(|e| e.to_string_lossy().to_string())
        .unwrap_or_else(|| "png".to_string());
    let name = src.file_name().map(|n| n.to_string_lossy().to_string());

    let (abs, rel) = fs::save_attachment_bytes(
        &note,
        &ws,
        &strategy,
        &custom_dir,
        name.as_deref(),
        &ext,
        &bytes,
    )?;

    Ok(SaveAssetResult {
        absolute_path: path_to_string(&abs),
        relative_path: rel,
    })
}

#[tauri::command]
pub fn compute_relative_link(from_note_path: String, target_path: String) -> Result<String, FoliaError> {
    let note = Path::new(&from_note_path);
    let doc_dir = note
        .parent()
        .ok_or_else(|| FoliaError::InvalidPath(from_note_path.clone()))?;
    Ok(compute_relative_posix(doc_dir, Path::new(&target_path)))
}

#[tauri::command]
pub fn resolve_relative_path(from_note_path: String, relative_path: String) -> Result<String, FoliaError> {
    let note = Path::new(&from_note_path);
    let doc_dir = note
        .parent()
        .ok_or_else(|| FoliaError::InvalidPath(from_note_path.clone()))?;
    let joined = doc_dir.join(relative_path.replace('/', std::path::MAIN_SEPARATOR_STR));
    let resolved = canonicalize_clean(&joined).unwrap_or_else(|_| normalize_lexical(&joined));
    Ok(path_to_string(&resolved))
}

#[tauri::command]
pub async fn search_files_content(
    state: State<'_, AppRuntimeState>,
    req: SearchRequest,
) -> Result<SearchResponse, FoliaError> {
    let mgr = state.search.clone();
    tokio::task::spawn_blocking(move || mgr.search(req))
        .await
        .map_err(|e| FoliaError::Search(format!("搜索线程异常: {e}")))?
}

#[tauri::command]
pub fn cancel_search(state: State<'_, AppRuntimeState>) {
    state.search.cancel_current();
}

#[tauri::command]
pub fn load_app_config(state: State<'_, AppRuntimeState>) -> Result<Option<serde_json::Value>, FoliaError> {
    config::load_config_json(&state.app_data_dir)
}

#[tauri::command]
pub fn save_app_config(
    state: State<'_, AppRuntimeState>,
    config_data: serde_json::Value,
) -> Result<(), FoliaError> {
    config::save_config_json(&state.app_data_dir, &config_data)
}

#[tauri::command]
pub fn save_recovery_draft(
    state: State<'_, AppRuntimeState>,
    draft: RecoveryDraft,
) -> Result<(), FoliaError> {
    config::save_draft(&state.app_data_dir, &draft)
}

#[tauri::command]
pub fn delete_recovery_draft(
    state: State<'_, AppRuntimeState>,
    path: String,
) -> Result<(), FoliaError> {
    config::delete_draft(&state.app_data_dir, &path)
}

#[tauri::command]
pub fn list_recovery_drafts(state: State<'_, AppRuntimeState>) -> Result<Vec<RecoveryDraft>, FoliaError> {
    config::list_drafts(&state.app_data_dir)
}

#[tauri::command]
pub fn export_html_file(target_path: String, html: String) -> Result<(), FoliaError> {
    fs::write_atomic(Path::new(&target_path), html.as_bytes())?;
    Ok(())
}

#[tauri::command]
pub fn read_binary_base64(path: String) -> Result<String, FoliaError> {
    let canon = canonicalize_clean(Path::new(&path))?;
    let bytes = std::fs::read(&canon)?;
    let mime = mime_guess::from_path(&canon)
        .first_or_octet_stream()
        .essence_str()
        .to_string();
    let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);
    Ok(format!("data:{mime};base64,{encoded}"))
}

#[tauri::command]
pub fn reveal_in_file_manager(path: String) -> Result<(), FoliaError> {
    let target = canonicalize_clean(Path::new(&path))?;
    #[cfg(target_os = "windows")]
    {
        Command::new("explorer")
            .arg(format!("/select,{}", target.display()))
            .spawn()?;
    }
    #[cfg(target_os = "macos")]
    {
        Command::new("open").arg("-R").arg(&target).spawn()?;
    }
    #[cfg(target_os = "linux")]
    {
        let dir = if target.is_dir() {
            target.as_path()
        } else {
            target.parent().unwrap_or(target.as_path())
        };
        Command::new("xdg-open").arg(dir).spawn()?;
    }
    Ok(())
}

#[tauri::command]
pub fn terminal_spawn(
    app: AppHandle,
    state: State<'_, AppRuntimeState>,
    cwd: String,
    shell_type: String,
    custom_path: Option<String>,
    cols: u16,
    rows: u16,
) -> Result<SpawnTerminalResult, FoliaError> {
    state
        .terminal
        .spawn(app, cwd, shell_type, custom_path, cols, rows)
}

#[tauri::command]
pub fn terminal_write(
    state: State<'_, AppRuntimeState>,
    id: String,
    data: String,
) -> Result<(), FoliaError> {
    state.terminal.write(&id, &data)
}

#[tauri::command]
pub fn terminal_resize(
    state: State<'_, AppRuntimeState>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), FoliaError> {
    state.terminal.resize(&id, cols, rows)
}

#[tauri::command]
pub fn terminal_kill(state: State<'_, AppRuntimeState>, id: String) {
    state.terminal.kill(&id);
}

#[tauri::command]
pub fn terminal_list_shells() -> Vec<DetectedShellInfo> {
    detect_available_shells()
}

#[tauri::command]
pub fn set_tray_behavior(
    state: State<'_, AppRuntimeState>,
    minimize_to_tray: bool,
    close_to_tray: bool,
) {
    let mut guard = state.tray_behavior.write();
    guard.minimize_to_tray = minimize_to_tray;
    guard.close_to_tray = close_to_tray;
}

#[tauri::command]
pub fn hide_to_tray(app: AppHandle, state: State<'_, AppRuntimeState>) {
    if let Some(window) = app.get_webview_window("main") {
        let is_max = window.is_maximized().unwrap_or(false);
        state.was_maximized.store(is_max, Ordering::SeqCst);
        config::save_window_state(&state.app_data_dir, &config::WindowState { maximized: is_max });
        let _ = window.hide();
    }
}

#[tauri::command]
pub fn quit_app(app: AppHandle, state: State<'_, AppRuntimeState>) {
    if let Some(window) = app.get_webview_window("main") {
        if window.is_visible().unwrap_or(false) && !window.is_minimized().unwrap_or(false) {
            let is_max = window.is_maximized().unwrap_or(false);
            state.was_maximized.store(is_max, Ordering::SeqCst);
        }
    }
    config::save_window_state(
        &state.app_data_dir,
        &config::WindowState {
            maximized: state.was_maximized.load(Ordering::SeqCst),
        },
    );
    if let Some(tray) = app.remove_tray_by_id("folia-tray") {
        drop(tray);
    }
    app.exit(0);
}

#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub fn history_save_snapshot(
    state: State<'_, AppRuntimeState>,
    path: String,
    content: String,
    reason: String,
    min_interval_secs: u64,
    max_snapshots: usize,
    force: bool,
) -> Result<Option<HistoryEntryMeta>, FoliaError> {
    history::save_snapshot(
        &state.app_data_dir,
        &path,
        &content,
        &reason,
        min_interval_secs,
        max_snapshots,
        force,
    )
}

#[tauri::command]
pub fn history_list(
    state: State<'_, AppRuntimeState>,
    path: String,
) -> Result<Vec<HistoryEntryMeta>, FoliaError> {
    history::list_snapshots(&state.app_data_dir, &path)
}

#[tauri::command]
pub fn history_read(
    state: State<'_, AppRuntimeState>,
    path: String,
    id: String,
) -> Result<String, FoliaError> {
    history::read_snapshot(&state.app_data_dir, &path, &id)
}

#[tauri::command]
pub fn history_delete_entry(
    state: State<'_, AppRuntimeState>,
    path: String,
    id: String,
) -> Result<(), FoliaError> {
    history::delete_snapshot(&state.app_data_dir, &path, &id)
}

#[tauri::command]
pub fn history_stats(state: State<'_, AppRuntimeState>) -> HistoryStats {
    history::get_history_stats(&state.app_data_dir)
}

#[tauri::command]
pub fn history_clear_all(state: State<'_, AppRuntimeState>) -> Result<usize, FoliaError> {
    history::clear_all_history(&state.app_data_dir)
}
