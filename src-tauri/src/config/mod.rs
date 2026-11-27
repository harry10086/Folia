use crate::error::FoliaError;
use crate::fs::encoding::hash_bytes;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryDraft {
    pub path: String,
    pub content: String,
    pub base_hash: String,
    pub updated_at_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct WindowState {
    pub maximized: bool,
}

pub fn config_file_path(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join("config.json")
}

pub fn window_state_path(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join("window_state.json")
}

pub fn load_window_state(app_data_dir: &Path) -> WindowState {
    let path = window_state_path(app_data_dir);
    if !path.exists() {
        return WindowState::default();
    }
    fs::read_to_string(&path)
        .ok()
        .and_then(|t| serde_json::from_str::<WindowState>(&t).ok())
        .unwrap_or_default()
}

pub fn save_window_state(app_data_dir: &Path, state: &WindowState) {
    if fs::create_dir_all(app_data_dir).is_err() {
        return;
    }
    if let Ok(json) = serde_json::to_string(state) {
        let _ = crate::fs::write_atomic(&window_state_path(app_data_dir), json.as_bytes());
    }
}

pub fn recovery_dir(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join("recovery")
}

pub fn load_config_json(app_data_dir: &Path) -> Result<Option<serde_json::Value>, FoliaError> {
    let path = config_file_path(app_data_dir);
    if !path.exists() {
        return Ok(None);
    }
    let text = fs::read_to_string(&path)?;
    let val: serde_json::Value =
        serde_json::from_str(&text).map_err(|e| FoliaError::Config(e.to_string()))?;
    Ok(Some(val))
}

pub fn save_config_json(app_data_dir: &Path, config: &serde_json::Value) -> Result<(), FoliaError> {
    fs::create_dir_all(app_data_dir)?;
    let path = config_file_path(app_data_dir);
    let pretty =
        serde_json::to_string_pretty(config).map_err(|e| FoliaError::Config(e.to_string()))?;
    crate::fs::write_atomic(&path, pretty.as_bytes())?;
    Ok(())
}

fn draft_file_for_path(app_data_dir: &Path, doc_path: &str) -> PathBuf {
    let key = hash_bytes(doc_path.to_lowercase().as_bytes());
    recovery_dir(app_data_dir).join(format!("{key}.json"))
}

pub fn save_draft(app_data_dir: &Path, draft: &RecoveryDraft) -> Result<(), FoliaError> {
    let dir = recovery_dir(app_data_dir);
    fs::create_dir_all(&dir)?;
    let file = draft_file_for_path(app_data_dir, &draft.path);
    let json = serde_json::to_string(draft).map_err(|e| FoliaError::Config(e.to_string()))?;
    crate::fs::write_atomic(&file, json.as_bytes())?;
    Ok(())
}

pub fn delete_draft(app_data_dir: &Path, doc_path: &str) -> Result<(), FoliaError> {
    let file = draft_file_for_path(app_data_dir, doc_path);
    if file.exists() {
        let _ = fs::remove_file(file);
    }
    Ok(())
}

pub fn list_drafts(app_data_dir: &Path) -> Result<Vec<RecoveryDraft>, FoliaError> {
    let dir = recovery_dir(app_data_dir);
    if !dir.exists() {
        return Ok(Vec::new());
    }
    let mut drafts = Vec::new();
    for entry in fs::read_dir(&dir)?.flatten() {
        let p = entry.path();
        if p.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        if let Ok(text) = fs::read_to_string(&p) {
            if let Ok(draft) = serde_json::from_str::<RecoveryDraft>(&text) {
                drafts.push(draft);
            }
        }
    }
    drafts.sort_by(|a, b| b.updated_at_ms.cmp(&a.updated_at_ms));
    Ok(drafts)
}

