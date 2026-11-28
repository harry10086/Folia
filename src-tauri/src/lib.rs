pub mod commands;
pub mod config;
pub mod error;
pub mod fs;
pub mod history;
pub mod protocol;
pub mod search;
pub mod terminal;
pub mod watcher;

use commands::{AppRuntimeState, TrayBehavior};
use parking_lot::RwLock;
use search::SearchManager;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{Manager, WindowEvent};
use terminal::TerminalManager;
use watcher::{SelfWriteGuard, WatcherService};

static RESTORING_WINDOW: AtomicBool = AtomicBool::new(false);
static INITIAL_WINDOW_SHOWN: AtomicBool = AtomicBool::new(false);

pub fn show_main_window_ready(window: &tauri::WebviewWindow, should_maximize: bool) {
    if INITIAL_WINDOW_SHOWN.swap(true, Ordering::SeqCst) {
        return;
    }
    RESTORING_WINDOW.store(true, Ordering::SeqCst);
    if should_maximize {
        // Calling maximize() while hidden transitions directly to maximized on Windows,
        // avoiding the intermediate 1280x820 white frame flash.
        let _ = window.maximize();
        let _ = window.show();
    } else {
        let _ = window.show();
    }
    let _ = window.set_focus();
    std::thread::spawn(|| {
        std::thread::sleep(std::time::Duration::from_millis(160));
        RESTORING_WINDOW.store(false, Ordering::SeqCst);
    });
}

fn force_focus_window(window: &tauri::WebviewWindow) {
    let _ = window.set_always_on_top(true);
    let _ = window.set_focus();
    let _ = window.set_always_on_top(false);
}

fn restore_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let should_maximize = app
            .try_state::<AppRuntimeState>()
            .map(|s| s.was_maximized.load(Ordering::SeqCst))
            .unwrap_or(false);

        RESTORING_WINDOW.store(true, Ordering::SeqCst);

        // Only call unminimize when actually minimized; on Windows calling unminimize()
        // on a hidden-but-maximized window invokes SW_RESTORE and shrinks it back!
        if window.is_minimized().unwrap_or(false) {
            let _ = window.unminimize();
        }
        let _ = window.show();
        if should_maximize && !window.is_maximized().unwrap_or(false) {
            let _ = window.maximize();
        }
        force_focus_window(&window);

        if let Some(state) = app.try_state::<AppRuntimeState>() {
            state.was_maximized.store(should_maximize, Ordering::SeqCst);
        }

        // Re-assert foreground focus after a short delay in case the exiting second
        // single-instance process or Windows taskbar briefly reclaimed focus.
        let app_handle = app.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(120));
            let inner = app_handle.clone();
            let _ = app_handle.run_on_main_thread(move || {
                if let Some(win) = inner.get_webview_window("main") {
                    if win.is_visible().unwrap_or(false) && !win.is_focused().unwrap_or(false) {
                        force_focus_window(&win);
                    }
                }
                RESTORING_WINDOW.store(false, Ordering::SeqCst);
            });
        });
    }
}

fn clean_quit(app: &tauri::AppHandle) {
    if let Some(state) = app.try_state::<AppRuntimeState>() {
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
    }
    // Explicitly remove tray icon before exit so Windows doesn't leave a stale icon.
    if let Some(tray) = app.remove_tray_by_id("folia-tray") {
        drop(tray);
    }
    app.exit(0);
}

fn load_initial_tray_behavior(app_data_dir: &std::path::Path) -> TrayBehavior {
    if let Ok(Some(cfg)) = config::load_config_json(app_data_dir) {
        if let Some(settings) = cfg.get("settings").and_then(|v| v.as_object()) {
            let minimize_to_tray = settings
                .get("minimizeToTray")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            let close_to_tray = settings
                .get("closeToTray")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            return TrayBehavior {
                minimize_to_tray,
                close_to_tray,
            };
        }
    }
    TrayBehavior::default()
}

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

    let initial_tray_behavior = load_initial_tray_behavior(&app_data_dir);
    let tray_behavior = Arc::new(RwLock::new(initial_tray_behavior));
    let initial_window_state = config::load_window_state(&app_data_dir);
    let was_maximized = Arc::new(AtomicBool::new(initial_window_state.maximized));

    let guard = Arc::new(SelfWriteGuard::default());
    let runtime_state = AppRuntimeState {
        workspace_roots,
        watcher: WatcherService::new(guard),
        search: SearchManager::default(),
        terminal: TerminalManager::default(),
        app_data_dir: app_data_dir.clone(),
        tray_behavior: Arc::clone(&tray_behavior),
        was_maximized: Arc::clone(&was_maximized),
    };

    let window_tray_behavior = Arc::clone(&tray_behavior);
    let window_was_maximized = Arc::clone(&was_maximized);
    let window_data_dir = app_data_dir.clone();

    let mut builder = tauri::Builder::default();

    // Must be registered first so a second launch wakes the existing window
    // and exits cleanly BEFORE creating a duplicate window or tray icon.
    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            restore_main_window(app);
        }));
    }

    builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .register_uri_scheme_protocol("folia-asset", move |_ctx, request| {
            protocol::handle_asset_request(request, &protocol_roots)
        })
        .manage(runtime_state)
        .setup(move |app| {
            let state = app.state::<AppRuntimeState>();
            let _ = state.watcher.init(app.handle().clone());

            // Keep window hidden until the frontend finishes hydrating theme & layout,
            // with a safety fallback so the window always appears even if JS stalls.
            let fallback_handle = app.handle().clone();
            let should_max_fallback = state.was_maximized.load(Ordering::SeqCst);
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(1500));
                if !INITIAL_WINDOW_SHOWN.load(Ordering::SeqCst) {
                    let h = fallback_handle.clone();
                    let _ = fallback_handle.run_on_main_thread(move || {
                        if let Some(win) = h.get_webview_window("main") {
                            show_main_window_ready(&win, should_max_fallback);
                        }
                    });
                }
            });

            let show_item = MenuItem::with_id(app, "tray_show", "显示 Folia", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "tray_quit", "退出 Folia", true, None::<&str>)?;
            let tray_menu = Menu::with_items(app, &[&show_item, &quit_item])?;

            let mut tray_builder = TrayIconBuilder::with_id("folia-tray")
                .menu(&tray_menu)
                .tooltip("Folia")
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "tray_show" => restore_main_window(app),
                    "tray_quit" => clean_quit(app),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        restore_main_window(tray.app_handle());
                    }
                });

            if let Some(icon) = app.default_window_icon() {
                tray_builder = tray_builder.icon(icon.clone());
            }

            let _ = tray_builder.build(app)?;
            Ok(())
        })
        .on_window_event(move |window, event| {
            if window.label() != "main" {
                return;
            }
            match event {
                WindowEvent::CloseRequested { api, .. } => {
                    if window.is_visible().unwrap_or(false) && !window.is_minimized().unwrap_or(false) {
                        let is_max = window.is_maximized().unwrap_or(false);
                        window_was_maximized.store(is_max, Ordering::SeqCst);
                        config::save_window_state(
                            &window_data_dir,
                            &config::WindowState { maximized: is_max },
                        );
                    }
                    if window_tray_behavior.read().close_to_tray {
                        api.prevent_close();
                        let _ = window.hide();
                    } else if let Some(tray) = window.app_handle().remove_tray_by_id("folia-tray") {
                        drop(tray);
                    }
                }
                WindowEvent::Resized(_) => {
                    if RESTORING_WINDOW.load(Ordering::SeqCst) {
                        return;
                    }
                    if window.is_minimized().unwrap_or(false) {
                        if window_tray_behavior.read().minimize_to_tray {
                            let _ = window.hide();
                        }
                    } else if window.is_visible().unwrap_or(false) {
                        let is_max = window.is_maximized().unwrap_or(false);
                        let prev = window_was_maximized.swap(is_max, Ordering::SeqCst);
                        if prev != is_max {
                            config::save_window_state(
                                &window_data_dir,
                                &config::WindowState { maximized: is_max },
                            );
                        }
                    }
                }
                _ => {}
            }
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
            commands::set_tray_behavior,
            commands::hide_to_tray,
            commands::show_main_window,
            commands::quit_app,
            commands::history_save_snapshot,
            commands::history_list,
            commands::history_read,
            commands::history_delete_entry,
            commands::history_stats,
            commands::history_clear_all,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Folia application");
}

