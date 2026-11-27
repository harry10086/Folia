use crate::error::FoliaError;
use crate::fs::encoding::hash_bytes;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistorySnapshotFile {
    pub id: String,
    pub path: String,
    pub timestamp_ms: u64,
    pub hash: String,
    pub reason: String,
    pub chars: usize,
    pub lines: usize,
    pub content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntryMeta {
    pub id: String,
    pub timestamp_ms: u64,
    pub hash: String,
    pub reason: String,
    pub chars: usize,
    pub lines: usize,
    pub size_bytes: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryStats {
    pub total_snapshots: usize,
    pub total_bytes: u64,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn history_root(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join("history")
}

fn normalize_path_key(doc_path: &str) -> String {
    let norm = doc_path.replace('\\', "/").to_lowercase();
    hash_bytes(norm.as_bytes())
}

fn doc_history_dir(app_data_dir: &Path, doc_path: &str) -> PathBuf {
    history_root(app_data_dir).join(normalize_path_key(doc_path))
}

fn sanitize_reason(reason: &str) -> String {
    let cleaned: String = reason
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .take(24)
        .collect();
    if cleaned.is_empty() {
        "auto".to_string()
    } else {
        cleaned
    }
}

fn is_safe_snapshot_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 80
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

fn load_entries_sorted(dir: &Path) -> Vec<(PathBuf, HistoryEntryMeta)> {
    if !dir.exists() {
        return Vec::new();
    }
    let mut items = Vec::new();
    if let Ok(read_dir) = fs::read_dir(dir) {
        for entry in read_dir.flatten() {
            let p = entry.path();
            if p.extension().and_then(|e| e.to_str()) != Some("json") {
                continue;
            }
            if let Ok(text) = fs::read_to_string(&p) {
                if let Ok(snap) = serde_json::from_str::<HistorySnapshotFile>(&text) {
                    let meta = HistoryEntryMeta {
                        id: snap.id,
                        timestamp_ms: snap.timestamp_ms,
                        hash: snap.hash,
                        reason: snap.reason,
                        chars: snap.chars,
                        lines: snap.lines,
                        size_bytes: snap.content.len(),
                    };
                    items.push((p, meta));
                }
            }
        }
    }
    items.sort_by(|a, b| b.1.timestamp_ms.cmp(&a.1.timestamp_ms));
    items
}

pub fn save_snapshot(
    app_data_dir: &Path,
    doc_path: &str,
    content: &str,
    reason: &str,
    min_interval_secs: u64,
    max_snapshots: usize,
    force: bool,
) -> Result<Option<HistoryEntryMeta>, FoliaError> {
    let dir = doc_history_dir(app_data_dir, doc_path);
    let existing = load_entries_sorted(&dir);
    let content_hash = hash_bytes(content.as_bytes());
    let ts = now_ms();

    if let Some((_, latest)) = existing.first() {
        // Content identical to latest snapshot -> skip duplicate
        if latest.hash == content_hash {
            return Ok(None);
        }
        // Auto-save throttling -> respect configured interval (e.g., 5 minutes)
        if !force && min_interval_secs > 0 {
            let elapsed_ms = ts.saturating_sub(latest.timestamp_ms);
            if elapsed_ms < min_interval_secs.saturating_mul(1000) {
                return Ok(None);
            }
        }
    }

    fs::create_dir_all(&dir)?;

    let safe_reason = sanitize_reason(reason);
    let id = format!("{ts}_{safe_reason}");
    let chars = content.chars().count();
    let lines = if content.is_empty() {
        0
    } else {
        content.lines().count()
    };

    let snap = HistorySnapshotFile {
        id: id.clone(),
        path: doc_path.to_string(),
        timestamp_ms: ts,
        hash: content_hash.clone(),
        reason: safe_reason.clone(),
        chars,
        lines,
        content: content.to_string(),
    };

    let file_path = dir.join(format!("{id}.json"));
    let json = serde_json::to_string(&snap).map_err(|e| FoliaError::Config(e.to_string()))?;
    crate::fs::write_atomic(&file_path, json.as_bytes())?;

    // Prune oldest snapshots beyond configured retention limit
    let limit = max_snapshots.clamp(5, 500);
    let mut updated = load_entries_sorted(&dir);
    if updated.len() > limit {
        for (old_path, _) in updated.drain(limit..) {
            let _ = fs::remove_file(old_path);
        }
    }

    Ok(Some(HistoryEntryMeta {
        id,
        timestamp_ms: ts,
        hash: content_hash,
        reason: safe_reason,
        chars,
        lines,
        size_bytes: content.len(),
    }))
}

pub fn list_snapshots(app_data_dir: &Path, doc_path: &str) -> Result<Vec<HistoryEntryMeta>, FoliaError> {
    let dir = doc_history_dir(app_data_dir, doc_path);
    Ok(load_entries_sorted(&dir).into_iter().map(|(_, m)| m).collect())
}

pub fn read_snapshot(app_data_dir: &Path, doc_path: &str, id: &str) -> Result<String, FoliaError> {
    if !is_safe_snapshot_id(id) {
        return Err(FoliaError::InvalidPath("无效的历史快照 ID".into()));
    }
    let file_path = doc_history_dir(app_data_dir, doc_path).join(format!("{id}.json"));
    if !file_path.exists() {
        return Err(FoliaError::NotFound("历史快照不存在或已被清理".into()));
    }
    let text = fs::read_to_string(&file_path)?;
    let snap: HistorySnapshotFile =
        serde_json::from_str(&text).map_err(|e| FoliaError::Config(e.to_string()))?;
    Ok(snap.content)
}

pub fn delete_snapshot(app_data_dir: &Path, doc_path: &str, id: &str) -> Result<(), FoliaError> {
    if !is_safe_snapshot_id(id) {
        return Err(FoliaError::InvalidPath("无效的历史快照 ID".into()));
    }
    let file_path = doc_history_dir(app_data_dir, doc_path).join(format!("{id}.json"));
    if file_path.exists() {
        fs::remove_file(file_path)?;
    }
    Ok(())
}

pub fn get_history_stats(app_data_dir: &Path) -> HistoryStats {
    let root = history_root(app_data_dir);
    if !root.exists() {
        return HistoryStats {
            total_snapshots: 0,
            total_bytes: 0,
        };
    }
    let mut total_snapshots = 0usize;
    let mut total_bytes = 0u64;
    if let Ok(dirs) = fs::read_dir(&root) {
        for sub in dirs.flatten() {
            let p = sub.path();
            if p.is_dir() {
                if let Ok(files) = fs::read_dir(&p) {
                    for f in files.flatten() {
                        let fp = f.path();
                        if fp.extension().and_then(|e| e.to_str()) == Some("json") {
                            total_snapshots += 1;
                            if let Ok(meta) = f.metadata() {
                                total_bytes += meta.len();
                            }
                        }
                    }
                }
            }
        }
    }
    HistoryStats {
        total_snapshots,
        total_bytes,
    }
}

pub fn clear_all_history(app_data_dir: &Path) -> Result<usize, FoliaError> {
    let root = history_root(app_data_dir);
    let stats = get_history_stats(app_data_dir);
    if root.exists() {
        fs::remove_dir_all(&root)?;
    }
    Ok(stats.total_snapshots)
}
