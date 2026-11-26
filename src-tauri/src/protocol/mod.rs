use crate::fs::{canonicalize_clean, is_path_within_roots, normalize_lexical};
use parking_lot::RwLock;
use percent_encoding::percent_decode_str;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::http::{header, Request, Response, StatusCode};

const COMMON_ASSET_DIRS: &[&str] = &[
    "_resources",
    "resources",
    "assets",
    "images",
    "Images",
    "attachments",
    "Attachments",
    "图片",
    "附件",
];

pub fn handle_asset_request(
    request: Request<Vec<u8>>,
    workspace_roots: &Arc<RwLock<Vec<PathBuf>>>,
) -> Response<Vec<u8>> {
    let raw_uri_path = request.uri().path();
    let decoded = match percent_decode_str(raw_uri_path).decode_utf8() {
        Ok(cow) => cow.into_owned(),
        Err(_) => return text_response(StatusCode::BAD_REQUEST, "Invalid UTF-8 path"),
    };

    let note_path = request.uri().query().and_then(|q| parse_query_param(q, "note"));
    let fs_path_str = normalize_protocol_path(&decoded);
    let requested = PathBuf::from(&fs_path_str);

    let roots = workspace_roots.read().clone();
    let resolved = resolve_asset_path(&requested, note_path.as_deref(), &roots);

    let Some(canon) = resolved else {
        return text_response(StatusCode::NOT_FOUND, "Asset not found");
    };

    if !is_allowed_asset_path(&canon, &roots) {
        return text_response(StatusCode::FORBIDDEN, "Path outside open workspaces");
    }

    let bytes = match fs::read(&canon) {
        Ok(b) => b,
        Err(_) => return text_response(StatusCode::NOT_FOUND, "Unable to read asset"),
    };

    let mime = mime_guess::from_path(&canon)
        .first_or_octet_stream()
        .essence_str()
        .to_string();

    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, mime)
        .header(header::CACHE_CONTROL, "no-store")
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .body(bytes)
        .unwrap_or_else(|_| text_response(StatusCode::INTERNAL_SERVER_ERROR, "Response build error"))
}

/// Resolve an image/attachment path with Obsidian-compatible fallback:
/// 1. Direct path if it exists on disk.
/// 2. Search common attachment folders (`_resources`, `images`, `assets`, `attachments`, `图片`, `附件`)
///    and `.obsidian/app.json`'s `attachmentFolderPath` walking upward from the note directory
///    and across open workspace roots (including their parent Obsidian vault root if present).
pub fn resolve_asset_path(
    requested: &Path,
    note_path: Option<&str>,
    workspace_roots: &[PathBuf],
) -> Option<PathBuf> {
    if requested.is_file() {
        return canonicalize_clean(requested).ok();
    }

    let file_name = requested.file_name()?;

    // Collect candidate search roots: ancestors of note_dir (up to 4 levels) + open workspaces + their parent dirs
    let mut search_bases: Vec<PathBuf> = Vec::new();
    if let Some(np) = note_path {
        let mut cur = Path::new(np).parent().map(Path::to_path_buf);
        for _ in 0..5 {
            let Some(dir) = cur else { break };
            if !search_bases.contains(&dir) {
                search_bases.push(dir.clone());
            }
            cur = dir.parent().map(Path::to_path_buf);
        }
    }

    for root in workspace_roots {
        if !search_bases.contains(root) {
            search_bases.push(root.clone());
        }
        if let Some(parent) = root.parent() {
            let p = parent.to_path_buf();
            if !search_bases.contains(&p) {
                search_bases.push(p);
            }
        }
    }

    // 1. Check direct filename & common asset subfolders in each base
    for base in &search_bases {
        let direct = base.join(file_name);
        if direct.is_file() {
            if let Ok(c) = canonicalize_clean(&direct) {
                return Some(c);
            }
        }

        // Check Obsidian `.obsidian/app.json` attachmentFolderPath if present
        if let Some(custom_dir) = read_obsidian_attachment_folder(base) {
            let cand = base.join(custom_dir).join(file_name);
            if cand.is_file() {
                if let Ok(c) = canonicalize_clean(&cand) {
                    return Some(c);
                }
            }
        }

        for folder in COMMON_ASSET_DIRS {
            let cand = base.join(folder).join(file_name);
            if cand.is_file() {
                if let Ok(c) = canonicalize_clean(&cand) {
                    return Some(c);
                }
            }
        }
    }

    None
}

fn read_obsidian_attachment_folder(vault_dir: &Path) -> Option<String> {
    let app_json = vault_dir.join(".obsidian").join("app.json");
    let text = fs::read_to_string(app_json).ok()?;
    let parsed: serde_json::Value = serde_json::from_str(&text).ok()?;
    let folder = parsed.get("attachmentFolderPath")?.as_str()?.trim();
    if folder.is_empty() || folder == "/" || folder == "./" {
        return None;
    }
    Some(folder.trim_start_matches("./").to_string())
}

fn is_allowed_asset_path(target: &Path, roots: &[PathBuf]) -> bool {
    if roots.is_empty() || is_path_within_roots(target, roots) {
        return true;
    }
    // Also allow sibling/vault-level attachment directories (e.g. D:\Obsidian\_resources when D:\Obsidian\01工作 is open)
    let mut extended_roots: Vec<PathBuf> = Vec::new();
    for root in roots {
        if let Some(parent) = root.parent() {
            for folder in COMMON_ASSET_DIRS {
                let candidate = parent.join(folder);
                if candidate.is_dir() {
                    extended_roots.push(candidate);
                }
            }
            if let Some(custom_dir) = read_obsidian_attachment_folder(parent) {
                let candidate = normalize_lexical(&parent.join(custom_dir));
                if candidate.is_dir() {
                    extended_roots.push(candidate);
                }
            }
        }
    }
    is_path_within_roots(target, &extended_roots)
}

fn parse_query_param(query: &str, key: &str) -> Option<String> {
    for pair in query.split('&') {
        if let Some((k, v)) = pair.split_once('=') {
            if k == key {
                let plus_fixed = v.replace('+', " ");
                return percent_decode_str(&plus_fixed)
                    .decode_utf8()
                    .ok()
                    .map(|c| c.into_owned());
            }
        }
    }
    None
}

fn normalize_protocol_path(decoded: &str) -> String {
    #[cfg(target_os = "windows")]
    {
        let trimmed = decoded.strip_prefix('/').unwrap_or(decoded);
        if trimmed.len() >= 2 && trimmed.as_bytes()[1] == b':' {
            return trimmed.replace('/', "\\");
        }
        decoded.replace('/', "\\")
    }
    #[cfg(not(target_os = "windows"))]
    {
        if decoded.starts_with('/') {
            decoded.to_string()
        } else {
            format!("/{decoded}")
        }
    }
}

fn text_response(status: StatusCode, msg: &str) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
        .body(msg.as_bytes().to_vec())
        .unwrap()
}
