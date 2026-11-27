use crate::error::FoliaError;
use crate::fs::{canonicalize_clean, compute_disk_hash, metadata_mtime_ms, path_to_string};
use notify::{RecommendedWatcher, RecursiveMode};
use notify_debouncer_mini::{new_debouncer, DebounceEventResult, Debouncer};
use parking_lot::Mutex;
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalFileEvent {
    pub path: String,
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hash: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mtime_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TreeChangedEvent {
    pub paths: Vec<String>,
}

#[derive(Default)]
pub struct SelfWriteGuard {
    entries: Mutex<HashMap<String, (String, Instant)>>,
}

impl SelfWriteGuard {
    pub fn record_write(&self, canonical_path: &str, hash: &str) {
        let mut map = self.entries.lock();
        map.insert(
            normalize_key(canonical_path),
            (hash.to_string(), Instant::now()),
        );
        let cutoff = Instant::now() - Duration::from_secs(30);
        map.retain(|_, (_, ts)| *ts >= cutoff);
    }

    pub fn is_self_write(&self, canonical_path: &str, disk_hash: &str) -> bool {
        let map = self.entries.lock();
        if let Some((saved_hash, ts)) = map.get(&normalize_key(canonical_path)) {
            if ts.elapsed() < Duration::from_secs(15) && saved_hash == disk_hash {
                return true;
            }
        }
        false
    }
}

fn normalize_key(path: &str) -> String {
    #[cfg(target_os = "windows")]
    {
        path.to_lowercase()
    }
    #[cfg(not(target_os = "windows"))]
    {
        path.to_string()
    }
}

pub struct WatcherService {
    debouncer: Mutex<Option<Debouncer<RecommendedWatcher>>>,
    watched_roots: Mutex<HashSet<PathBuf>>,
    pub guard: Arc<SelfWriteGuard>,
}

impl WatcherService {
    pub fn new(guard: Arc<SelfWriteGuard>) -> Self {
        Self {
            debouncer: Mutex::new(None),
            watched_roots: Mutex::new(HashSet::new()),
            guard,
        }
    }

    pub fn init(&self, app: AppHandle) -> Result<(), FoliaError> {
        let guard = Arc::clone(&self.guard);
        let debouncer = new_debouncer(
            Duration::from_millis(260),
            move |res: DebounceEventResult| {
                let events = match res {
                    Ok(ev) => ev,
                    Err(_) => return,
                };

                let mut seen: HashSet<String> = HashSet::new();
                let mut tree_paths: Vec<String> = Vec::new();

                for ev in events {
                    let raw_path = ev.path;
                    let name = raw_path
                        .file_name()
                        .map(|n| n.to_string_lossy().to_string())
                        .unwrap_or_default();
                    if name.starts_with(".folia.tmp.") || name == ".git" {
                        continue;
                    }
                    if raw_path.components().any(|c| {
                        let s = c.as_os_str();
                        s == ".git"
                            || s == "node_modules"
                            || s == "build_dir"
                            || s == "staging_dir"
                            || s == "__pycache__"
                            || s == ".venv"
                    }) {
                        continue;
                    }

                    let canonical = canonicalize_clean(&raw_path).unwrap_or(raw_path.clone());
                    let path_str = path_to_string(&canonical);
                    if !seen.insert(normalize_key(&path_str)) {
                        continue;
                    }

                    tree_paths.push(path_str.clone());

                    if canonical.exists() {
                        if canonical.is_file() {
                            if let Ok(disk_hash) = compute_disk_hash(&canonical) {
                                if guard.is_self_write(&path_str, &disk_hash) {
                                    continue;
                                }
                                let mtime_ms = fs::metadata(&canonical)
                                    .ok()
                                    .map(|m| metadata_mtime_ms(&m));
                                let _ = app.emit(
                                    "fs:file-changed",
                                    ExternalFileEvent {
                                        path: path_str,
                                        kind: "modified".to_string(),
                                        hash: Some(disk_hash),
                                        mtime_ms,
                                    },
                                );
                            }
                        }
                    } else {
                        let _ = app.emit(
                            "fs:file-changed",
                            ExternalFileEvent {
                                path: path_str,
                                kind: "deleted".to_string(),
                                hash: None,
                                mtime_ms: None,
                            },
                        );
                    }
                }

                if !tree_paths.is_empty() {
                    let _ = app.emit("fs:tree-changed", TreeChangedEvent { paths: tree_paths });
                }
            },
        )
        .map_err(|e| FoliaError::Watch(e.to_string()))?;

        *self.debouncer.lock() = Some(debouncer);
        Ok(())
    }

    pub fn watch_root(&self, root: &Path) -> Result<(), FoliaError> {
        let canon = canonicalize_clean(root)?;
        let mut roots = self.watched_roots.lock();
        if roots.contains(&canon) {
            return Ok(());
        }
        if let Some(ref mut d) = *self.debouncer.lock() {
            d.watcher()
                .watch(&canon, RecursiveMode::Recursive)
                .map_err(|e| FoliaError::Watch(e.to_string()))?;
            roots.insert(canon);
        }
        Ok(())
    }

    pub fn unwatch_root(&self, root: &Path) -> Result<(), FoliaError> {
        let canon = canonicalize_clean(root).unwrap_or_else(|_| root.to_path_buf());
        let mut roots = self.watched_roots.lock();
        if roots.remove(&canon) {
            if let Some(ref mut d) = *self.debouncer.lock() {
                let _ = d.watcher().unwatch(&canon);
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn self_write_guard_matches_same_hash_and_rejects_different_hash() {
        let guard = SelfWriteGuard::default();
        guard.record_write("D:\\Notes\\a.md", "hash_v1");
        assert!(guard.is_self_write("D:\\Notes\\a.md", "hash_v1"));
        assert!(!guard.is_self_write("D:\\Notes\\a.md", "hash_external_v2"));
    }
}
