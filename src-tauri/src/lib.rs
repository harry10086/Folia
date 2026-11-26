pub mod commands;
pub mod config;
pub mod error;
pub mod fs;
pub mod protocol;
pub mod search;
pub mod terminal;
pub mod watcher;

use commands::AppRuntimeState;
use parking_lot::RwLock;
use search::SearchManager;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::Manager;
use terminal::TerminalManager;
use watcher::{SelfWriteGuard, WatcherService};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let workspace_roots: Arc<RwLock<Vec<PathBuf>>> = Arc::new(RwLock::new(Vec::new()));
    let protocol_roots = Arc::clone(&workspace_roots);

    // Support true portable mode: if `portable.txt` exists next to the executable,
    // store app config & crash recovery drafts in `<exe_dir>/data` instead of system AppData.
    let portable_dir = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|p| p.to_path_buf()))
        .and_then(|dir| {
            if dir.join("portable.txt").exists() {
                Some(dir.join("data"))
            } else {
                None
            }
        });

    let app_data_dir = portable_dir.unwrap_or_else(|| {
        dirs::data_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("Folia")
    });

    let guard = Arc::new(SelfWriteGuard::default());
    let runtime_state = AppRuntimeState {
        workspace_roots,
        watcher: WatcherService::new(guard),
        search: SearchManager::default(),
        terminal: TerminalManager::default(),
        app_data_dir,
    };

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .register_uri_scheme_protocol("folia-asset", move |_ctx, request| {
            protocol::handle_asset_request(request, &protocol_roots)
        })
        .manage(runtime_state)
        .setup(|app| {
            let state = app.state::<AppRuntimeState>();
            let _ = state.watcher.init(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::register_workspaces,
            commands::scan_workspace,
            commands::read_file,
            commands::save_file,
            commands::create_file,
            commands::create_folder,
            commands::rename_path,
            commands::move_path,
            commands::copy_path,
            commands::delete_to_trash,
            commands::list_attachments,
            commands::save_pasted_image,
            commands::copy_dropped_asset,
            commands::compute_relative_link,
            commands::resolve_relative_path,
            commands::search_files_content,
            commands::cancel_search,
            commands::load_app_config,
            commands::save_app_config,
            commands::save_recovery_draft,
            commands::delete_recovery_draft,
            commands::list_recovery_drafts,
            commands::export_html_file,
            commands::read_binary_base64,
            commands::reveal_in_file_manager,
            commands::terminal_spawn,
            commands::terminal_write,
            commands::terminal_resize,
            commands::terminal_kill,
            commands::terminal_list_shells,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Folia application");
}

