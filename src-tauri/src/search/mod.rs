use crate::error::FoliaError;
use crate::fs::{path_to_string, strip_verbatim_prefix};
use grep_matcher::Matcher;
use grep_regex::RegexMatcherBuilder;
use grep_searcher::sinks::UTF8;
use grep_searcher::{BinaryDetection, SearcherBuilder};
use ignore::{WalkBuilder, WalkState};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;

const MAX_SEARCHABLE_FILE_BYTES: u64 = 2 * 1024 * 1024; // 2 MB

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchScopeRoot {
    pub workspace_id: String,
    pub root_path: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchRequest {
    pub roots: Vec<SearchScopeRoot>,
    pub query: String,
    #[serde(default)]
    pub case_sensitive: bool,
    #[serde(default)]
    pub whole_word: bool,
    #[serde(default)]
    pub use_regex: bool,
    #[serde(default = "default_max_results")]
    pub max_results: usize,
}

fn default_max_results() -> usize {
    500
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchMatch {
    pub workspace_id: String,
    pub path: String,
    pub file_name: String,
    pub line_number: u64,
    pub line_text: String,
    pub match_start: usize,
    pub match_end: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResponse {
    pub matches: Vec<SearchMatch>,
    pub truncated: bool,
    pub scanned_files: usize,
    pub cancelled: bool,
}

#[derive(Default, Clone)]
pub struct SearchManager {
    active_cancel: Arc<Mutex<Option<Arc<AtomicBool>>>>,
}

fn is_ignored_dir_name(name: &str) -> bool {
    matches!(
        name,
        ".git"
            | "node_modules"
            | "target"
            | "dist"
            | "dist-ssr"
            | "build"
            | ".obsidian"
            | ".trash"
            | ".vscode"
            | ".idea"
            | ".venv"
            | "venv"
            | "__pycache__"
            | "_resources"
            | ".next"
            | ".nuxt"
            | "vendor"
    ) || name.starts_with(".folia.tmp.")
}

fn is_searchable_text_ext(ext: &str) -> bool {
    matches!(
        ext.to_ascii_lowercase().as_str(),
        "md" | "markdown"
            | "mdown"
            | "mkd"
            | "txt"
            | "html"
            | "htm"
            | "xml"
            | "json"
            | "yaml"
            | "yml"
            | "toml"
            | "ini"
            | "cfg"
            | "conf"
            | "csv"
            | "tsv"
            | "rst"
            | "org"
            | "tex"
            | "css"
            | "scss"
            | "less"
            | "js"
            | "ts"
            | "jsx"
            | "tsx"
            | "vue"
            | "svelte"
            | "rs"
            | "py"
            | "go"
            | "java"
            | "c"
            | "cpp"
            | "h"
            | "hpp"
            | "cs"
            | "php"
            | "rb"
            | "sh"
            | "bash"
            | "ps1"
            | "bat"
            | "sql"
            | "log"
    )
}

impl SearchManager {
    pub fn cancel_current(&self) {
        if let Some(flag) = self.active_cancel.lock().as_ref() {
            flag.store(true, Ordering::SeqCst);
        }
    }

    pub fn search(&self, req: SearchRequest) -> Result<SearchResponse, FoliaError> {
        let query = req.query.trim();
        if query.is_empty() {
            return Ok(SearchResponse {
                matches: Vec::new(),
                truncated: false,
                scanned_files: 0,
                cancelled: false,
            });
        }

        let cancel = Arc::new(AtomicBool::new(false));
        {
            let mut slot = self.active_cancel.lock();
            if let Some(prev) = slot.replace(Arc::clone(&cancel)) {
                prev.store(true, Ordering::SeqCst);
            }
        }

        let pattern = if req.use_regex {
            query.to_string()
        } else {
            regex_escape(query)
        };

        let matcher = Arc::new(
            RegexMatcherBuilder::new()
                .case_insensitive(!req.case_sensitive)
                .word(req.whole_word)
                .build(&pattern)
                .map_err(|e| FoliaError::Search(format!("无效搜索表达式: {e}")))?,
        );

        let max_results = req.max_results.clamp(1, 2000);
        let matches: Arc<Mutex<Vec<SearchMatch>>> = Arc::new(Mutex::new(Vec::new()));
        let scanned_files = Arc::new(AtomicUsize::new(0));
        let truncated = Arc::new(AtomicBool::new(false));

        let worker_threads = std::thread::available_parallelism()
            .map(|n| n.get().clamp(2, 8))
            .unwrap_or(4);

        for scope in &req.roots {
            if cancel.load(Ordering::Relaxed) || truncated.load(Ordering::Relaxed) {
                break;
            }
            let root_path = PathBuf::from(&scope.root_path);
            if !root_path.exists() {
                continue;
            }

            let walker = WalkBuilder::new(&root_path)
                .hidden(true)
                .git_ignore(false)
                .git_global(false)
                .git_exclude(false)
                .threads(worker_threads)
                .filter_entry(|e| {
                    let name = e.file_name().to_string_lossy();
                    !is_ignored_dir_name(&name)
                })
                .build_parallel();

            let ws_id_root = scope.workspace_id.clone();

            walker.run(|| {
                let mut searcher = SearcherBuilder::new()
                    .binary_detection(BinaryDetection::quit(b'\x00'))
                    .line_number(true)
                    .build();
                let matcher_ref = Arc::clone(&matcher);
                let matches_ref = Arc::clone(&matches);
                let scanned_ref = Arc::clone(&scanned_files);
                let cancel_ref = Arc::clone(&cancel);
                let trunc_ref = Arc::clone(&truncated);
                let ws_id = ws_id_root.clone();

                Box::new(move |entry_res| {
                    if cancel_ref.load(Ordering::Relaxed) || trunc_ref.load(Ordering::Relaxed) {
                        return WalkState::Quit;
                    }
                    let entry = match entry_res {
                        Ok(e) => e,
                        Err(_) => return WalkState::Continue,
                    };
                    let path = entry.path();
                    if !path.is_file() {
                        return WalkState::Continue;
                    }
                    let ext = path
                        .extension()
                        .map(|e| e.to_string_lossy().to_string())
                        .unwrap_or_default();
                    if !is_searchable_text_ext(&ext) {
                        return WalkState::Continue;
                    }
                    if let Ok(meta) = entry.metadata() {
                        if meta.len() == 0 || meta.len() > MAX_SEARCHABLE_FILE_BYTES {
                            return WalkState::Continue;
                        }
                    }

                    scanned_ref.fetch_add(1, Ordering::Relaxed);
                    let clean_path = strip_verbatim_prefix(path.to_path_buf());
                    let path_str = path_to_string(&clean_path);
                    let file_name = clean_path
                        .file_name()
                        .map(|n| n.to_string_lossy().to_string())
                        .unwrap_or_default();

                    let mut file_matches: Vec<SearchMatch> = Vec::new();
                    let _ = searcher.search_path(
                        &*matcher_ref,
                        path,
                        UTF8(|line_num, line| {
                            if cancel_ref.load(Ordering::Relaxed) || trunc_ref.load(Ordering::Relaxed) {
                                return Ok(false);
                            }
                            let trimmed = line.trim_end_matches(&['\r', '\n'][..]);
                            let (m_start, m_end) = matcher_ref
                                .find(trimmed.as_bytes())
                                .ok()
                                .flatten()
                                .map(|m| (m.start(), m.end()))
                                .unwrap_or((0, 0));

                            let preview = if trimmed.len() > 240 {
                                let start_byte = trimmed
                                    .char_indices()
                                    .map(|(i, _)| i)
                                    .take_while(|&i| i <= m_start.saturating_sub(40))
                                    .last()
                                    .unwrap_or(0);
                                let end_byte = trimmed
                                    .char_indices()
                                    .map(|(i, _)| i)
                                    .find(|&i| i >= (m_end + 120).min(trimmed.len()))
                                    .unwrap_or(trimmed.len());
                                trimmed[start_byte..end_byte].to_string()
                            } else {
                                trimmed.to_string()
                            };

                            file_matches.push(SearchMatch {
                                workspace_id: ws_id.clone(),
                                path: path_str.clone(),
                                file_name: file_name.clone(),
                                line_number: line_num,
                                line_text: preview,
                                match_start: m_start,
                                match_end: m_end,
                            });
                            if file_matches.len() >= max_results {
                                return Ok(false);
                            }
                            Ok(true)
                        }),
                    );

                    if !file_matches.is_empty() {
                        let mut guard = matches_ref.lock();
                        let remaining = max_results.saturating_sub(guard.len());
                        if remaining == 0 {
                            trunc_ref.store(true, Ordering::Relaxed);
                            return WalkState::Quit;
                        }
                        if file_matches.len() >= remaining {
                            guard.extend(file_matches.into_iter().take(remaining));
                            trunc_ref.store(true, Ordering::Relaxed);
                            return WalkState::Quit;
                        } else {
                            guard.extend(file_matches);
                        }
                    }

                    WalkState::Continue
                })
            });
        }

        let mut results = std::mem::take(&mut *matches.lock());
        results.sort_by(|a, b| a.path.cmp(&b.path).then(a.line_number.cmp(&b.line_number)));

        Ok(SearchResponse {
            matches: results,
            truncated: truncated.load(Ordering::Relaxed),
            scanned_files: scanned_files.load(Ordering::Relaxed),
            cancelled: cancel.load(Ordering::Relaxed),
        })
    }
}

fn regex_escape(input: &str) -> String {
    let mut out = String::with_capacity(input.len() + 8);
    for ch in input.chars() {
        if matches!(
            ch,
            '\\' | '.' | '+' | '*' | '?' | '(' | ')' | '|' | '[' | ']' | '{' | '}' | '^' | '$'
        ) {
            out.push('\\');
        }
        out.push(ch);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn test_streaming_search_chinese_and_regex() {
        let dir = tempdir().unwrap();
        fs::write(
            dir.path().join("esp32.md"),
            "# ESP32 开发记录\n硬件连接使用 GPIO12 引脚\n",
        )
        .unwrap();
        fs::write(dir.path().join("other.md"), "普通笔记内容\n").unwrap();

        let mgr = SearchManager::default();
        let res = mgr
            .search(SearchRequest {
                roots: vec![SearchScopeRoot {
                    workspace_id: "ws1".into(),
                    root_path: dir.path().to_string_lossy().into(),
                }],
                query: "GPIO\\d+".into(),
                case_sensitive: false,
                whole_word: false,
                use_regex: true,
                max_results: 50,
            })
            .unwrap();

        assert_eq!(res.matches.len(), 1);
        assert_eq!(res.matches[0].line_number, 2);
        assert!(res.matches[0].line_text.contains("GPIO12"));
    }
}
