pub mod encoding;

use crate::error::FoliaError;
use chrono::Local;
use encoding::{decode_bytes, encode_text, hash_bytes, LineEnding};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::time::UNIX_EPOCH;
use uuid::Uuid;

pub const LARGE_FILE_BYTES: u64 = 512 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum FileKind {
    Folder,
    Markdown,
    Html,
    Image,
    Pdf,
    Other,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileNode {
    pub name: String,
    pub path: String,
    pub workspace_id: String,
    pub kind: FileKind,
    pub extension: String,
    pub size_bytes: u64,
    pub mtime_ms: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub children: Option<Vec<FileNode>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileDocument {
    pub path: String,
    pub content: String,
    pub encoding: String,
    pub has_bom: bool,
    pub line_ending: LineEnding,
    pub hash: String,
    pub mtime_ms: u64,
    pub size_bytes: u64,
    pub is_large: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveFileResult {
    pub path: String,
    pub hash: String,
    pub mtime_ms: u64,
    pub size_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentItem {
    pub name: String,
    pub path: String,
    pub relative_path: String,
    pub kind: FileKind,
    pub extension: String,
    pub size_bytes: u64,
    pub mtime_ms: u64,
}

pub fn canonicalize_clean(path: &Path) -> Result<PathBuf, FoliaError> {
    let canon = fs::canonicalize(path).map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            FoliaError::NotFound(path.to_string_lossy().to_string())
        } else {
            FoliaError::Io(e)
        }
    })?;
    Ok(strip_verbatim_prefix(canon))
}

pub fn strip_verbatim_prefix(path: PathBuf) -> PathBuf {
    #[cfg(target_os = "windows")]
    {
        let s = path.to_string_lossy();
        if let Some(stripped) = s.strip_prefix(r"\\?\UNC\") {
            return PathBuf::from(format!(r"\\{stripped}"));
        }
        if let Some(stripped) = s.strip_prefix(r"\\?\") {
            return PathBuf::from(stripped);
        }
    }
    path
}

pub fn normalize_lexical(path: &Path) -> PathBuf {
    let mut stack: Vec<Component<'_>> = Vec::new();
    for comp in path.components() {
        match comp {
            Component::CurDir => {}
            Component::ParentDir => {
                if let Some(last) = stack.last() {
                    if matches!(last, Component::Normal(_)) {
                        stack.pop();
                        continue;
                    }
                }
                stack.push(comp);
            }
            other => stack.push(other),
        }
    }
    let mut out = PathBuf::new();
    for c in stack {
        out.push(c.as_os_str());
    }
    strip_verbatim_prefix(out)
}

pub fn path_to_string(path: &Path) -> String {
    strip_verbatim_prefix(path.to_path_buf())
        .to_string_lossy()
        .to_string()
}

pub fn compute_relative_posix(from_dir: &Path, to_file: &Path) -> String {
    let from = normalize_lexical(from_dir);
    let to = normalize_lexical(to_file);

    let from_comps: Vec<Component<'_>> = from.components().collect();
    let to_comps: Vec<Component<'_>> = to.components().collect();

    if from_comps.first() != to_comps.first() {
        return to.to_string_lossy().replace('\\', "/");
    }

    let mut common = 0;
    while common < from_comps.len()
        && common < to_comps.len()
        && comps_equal(&from_comps[common], &to_comps[common])
    {
        common += 1;
    }

    let mut parts: Vec<String> = Vec::new();
    for _ in common..from_comps.len() {
        parts.push("..".to_string());
    }
    for comp in &to_comps[common..] {
        parts.push(comp.as_os_str().to_string_lossy().to_string());
    }
    if parts.is_empty() {
        ".".to_string()
    } else {
        parts.join("/")
    }
}

fn comps_equal(a: &Component<'_>, b: &Component<'_>) -> bool {
    #[cfg(target_os = "windows")]
    {
        a.as_os_str()
            .to_string_lossy()
            .eq_ignore_ascii_case(&b.as_os_str().to_string_lossy())
    }
    #[cfg(not(target_os = "windows"))]
    {
        a == b
    }
}

pub fn is_path_within_roots(target: &Path, roots: &[PathBuf]) -> bool {
    let norm_target = canonicalize_clean(target).unwrap_or_else(|_| normalize_lexical(target));
    for root in roots {
        let norm_root = canonicalize_clean(root).unwrap_or_else(|_| normalize_lexical(root));
        #[cfg(target_os = "windows")]
        {
            let t = norm_target.to_string_lossy().to_lowercase();
            let r = norm_root.to_string_lossy().to_lowercase();
            let r_trim = r.trim_end_matches('\\');
            if t == r_trim || t.starts_with(&format!("{r_trim}\\")) {
                return true;
            }
        }
        #[cfg(not(target_os = "windows"))]
        {
            if norm_target.starts_with(&norm_root) {
                return true;
            }
        }
    }
    false
}

pub fn classify_extension(ext: &str) -> FileKind {
    match ext.to_ascii_lowercase().as_str() {
        "md" | "markdown" | "mdown" | "mkd" | "txt" => FileKind::Markdown,
        "html" | "htm" => FileKind::Html,
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "svg" | "bmp" | "ico" | "avif" => {
            FileKind::Image
        }
        "pdf" => FileKind::Pdf,
        _ => FileKind::Other,
    }
}

pub fn metadata_mtime_ms(meta: &fs::Metadata) -> u64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn should_skip_entry(name: &str, show_hidden: bool) -> bool {
    if name == ".git"
        || name == "node_modules"
        || name == ".DS_Store"
        || name == "Thumbs.db"
        || name == "desktop.ini"
        || name.starts_with(".folia.tmp.")
    {
        return true;
    }
    if !show_hidden && name.starts_with('.') {
        return true;
    }
    false
}

pub fn scan_workspace_tree(
    root: &Path,
    workspace_id: &str,
    show_hidden: bool,
) -> Result<FileNode, FoliaError> {
    let canon = canonicalize_clean(root)?;
    let meta = fs::metadata(&canon)?;
    let name = canon
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| path_to_string(&canon));
    let children = scan_dir_children(&canon, workspace_id, show_hidden, 0)?;
    Ok(FileNode {
        name,
        path: path_to_string(&canon),
        workspace_id: workspace_id.to_string(),
        kind: FileKind::Folder,
        extension: String::new(),
        size_bytes: 0,
        mtime_ms: metadata_mtime_ms(&meta),
        children: Some(children),
    })
}

fn scan_dir_children(
    dir: &Path,
    workspace_id: &str,
    show_hidden: bool,
    depth: usize,
) -> Result<Vec<FileNode>, FoliaError> {
    if depth > 32 {
        return Ok(Vec::new());
    }
    let mut nodes = Vec::new();
    let entries = match fs::read_dir(dir) {
        Ok(rd) => rd,
        Err(_) => return Ok(nodes),
    };

    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if should_skip_entry(&name, show_hidden) {
            continue;
        }
        let path = strip_verbatim_prefix(entry.path());
        let meta = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };

        if meta.is_dir() {
            let children = scan_dir_children(&path, workspace_id, show_hidden, depth + 1)?;
            nodes.push(FileNode {
                name,
                path: path_to_string(&path),
                workspace_id: workspace_id.to_string(),
                kind: FileKind::Folder,
                extension: String::new(),
                size_bytes: 0,
                mtime_ms: metadata_mtime_ms(&meta),
                children: Some(children),
            });
        } else if meta.is_file() {
            let ext = path
                .extension()
                .map(|e| e.to_string_lossy().to_string())
                .unwrap_or_default();
            let kind = classify_extension(&ext);
            nodes.push(FileNode {
                name,
                path: path_to_string(&path),
                workspace_id: workspace_id.to_string(),
                kind,
                extension: ext,
                size_bytes: meta.len(),
                mtime_ms: metadata_mtime_ms(&meta),
                children: None,
            });
        }
    }

    nodes.sort_by(|a, b| {
        let a_dir = a.kind == FileKind::Folder;
        let b_dir = b.kind == FileKind::Folder;
        b_dir
            .cmp(&a_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });

    Ok(nodes)
}

pub fn read_document(path: &Path) -> Result<FileDocument, FoliaError> {
    let canon = canonicalize_clean(path)?;
    let meta = fs::metadata(&canon)?;
    let bytes = fs::read(&canon)?;
    let decoded = decode_bytes(&bytes);
    let size_bytes = meta.len();

    Ok(FileDocument {
        path: path_to_string(&canon),
        content: decoded.content,
        encoding: decoded.encoding,
        has_bom: decoded.has_bom,
        line_ending: decoded.line_ending,
        hash: decoded.hash,
        mtime_ms: metadata_mtime_ms(&meta),
        size_bytes,
        is_large: size_bytes >= LARGE_FILE_BYTES,
    })
}

pub fn compute_disk_hash(path: &Path) -> Result<String, FoliaError> {
    let bytes = fs::read(path)?;
    Ok(hash_bytes(&bytes))
}

pub fn write_atomic(path: &Path, bytes: &[u8]) -> Result<fs::Metadata, FoliaError> {
    let parent = path
        .parent()
        .ok_or_else(|| FoliaError::InvalidPath(path_to_string(path)))?;
    let tmp_name = format!(".folia.tmp.{}", Uuid::new_v4());
    let tmp_path = parent.join(tmp_name);

    if let Err(e) = fs::write(&tmp_path, bytes) {
        let _ = fs::remove_file(&tmp_path);
        return Err(FoliaError::Io(e));
    }

    if fs::rename(&tmp_path, path).is_err() {
        let _ = fs::remove_file(&tmp_path);
        fs::write(path, bytes)?;
    }

    Ok(fs::metadata(path)?)
}

pub fn encode_and_write(
    path: &Path,
    content: &str,
    encoding_name: &str,
    has_bom: bool,
    line_ending: LineEnding,
) -> Result<(SaveFileResult, String), FoliaError> {
    let bytes = encode_text(content, encoding_name, has_bom, line_ending);
    let new_hash = hash_bytes(&bytes);
    let meta = write_atomic(path, &bytes)?;
    let canon = canonicalize_clean(path).unwrap_or_else(|_| path.to_path_buf());
    Ok((
        SaveFileResult {
            path: path_to_string(&canon),
            hash: new_hash.clone(),
            mtime_ms: metadata_mtime_ms(&meta),
            size_bytes: meta.len(),
        },
        new_hash,
    ))
}

pub fn create_note_file(parent_dir: &Path, name: &str, initial_content: &str) -> Result<PathBuf, FoliaError> {
    let trimmed = name.trim();
    if trimmed.is_empty() || trimmed.contains(['/', '\\']) {
        return Err(FoliaError::InvalidPath(name.to_string()));
    }
    let file_name = if trimmed.contains('.') {
        trimmed.to_string()
    } else {
        format!("{trimmed}.md")
    };
    let target = parent_dir.join(file_name);
    if target.exists() {
        return Err(FoliaError::AlreadyExists(path_to_string(&target)));
    }
    fs::write(&target, initial_content.as_bytes())?;
    canonicalize_clean(&target)
}

pub fn create_folder(parent_dir: &Path, name: &str) -> Result<PathBuf, FoliaError> {
    let trimmed = name.trim();
    if trimmed.is_empty() || trimmed.contains(['/', '\\']) {
        return Err(FoliaError::InvalidPath(name.to_string()));
    }
    let target = parent_dir.join(trimmed);
    if target.exists() {
        return Err(FoliaError::AlreadyExists(path_to_string(&target)));
    }
    fs::create_dir_all(&target)?;
    canonicalize_clean(&target)
}

pub fn rename_entry(old_path: &Path, new_name: &str) -> Result<PathBuf, FoliaError> {
    let trimmed = new_name.trim();
    if trimmed.is_empty() || trimmed.contains(['/', '\\']) {
        return Err(FoliaError::InvalidPath(new_name.to_string()));
    }
    let canon_old = canonicalize_clean(old_path)?;
    let parent = canon_old
        .parent()
        .ok_or_else(|| FoliaError::InvalidPath(path_to_string(&canon_old)))?;
    let target = parent.join(trimmed);

    let is_case_only = canon_old
        .file_name()
        .map(|n| n.to_string_lossy().eq_ignore_ascii_case(trimmed))
        .unwrap_or(false);

    if target.exists() && !is_case_only {
        return Err(FoliaError::AlreadyExists(path_to_string(&target)));
    }

    if is_case_only {
        let tmp = parent.join(format!(".folia.tmp.{}", Uuid::new_v4()));
        fs::rename(&canon_old, &tmp)?;
        fs::rename(&tmp, &target)?;
    } else {
        fs::rename(&canon_old, &target)?;
    }
    canonicalize_clean(&target)
}

pub fn move_entry(src_path: &Path, dest_dir: &Path) -> Result<PathBuf, FoliaError> {
    let canon_src = canonicalize_clean(src_path)?;
    let canon_dest = canonicalize_clean(dest_dir)?;
    if !canon_dest.is_dir() {
        return Err(FoliaError::InvalidPath(path_to_string(&canon_dest)));
    }
    if canon_src.is_dir() && canon_dest.starts_with(&canon_src) {
        return Err(FoliaError::InvalidPath("不能将文件夹移动到自身内部".to_string()));
    }
    let name = canon_src
        .file_name()
        .ok_or_else(|| FoliaError::InvalidPath(path_to_string(&canon_src)))?;
    let target = canon_dest.join(name);
    if target.exists() {
        return Err(FoliaError::AlreadyExists(path_to_string(&target)));
    }
    if fs::rename(&canon_src, &target).is_err() {
        copy_recursive(&canon_src, &target)?;
        if canon_src.is_dir() {
            fs::remove_dir_all(&canon_src)?;
        } else {
            fs::remove_file(&canon_src)?;
        }
    }
    canonicalize_clean(&target)
}

pub fn copy_entry(src_path: &Path, dest_dir: &Path) -> Result<PathBuf, FoliaError> {
    let canon_src = canonicalize_clean(src_path)?;
    let canon_dest = canonicalize_clean(dest_dir)?;
    if !canon_dest.is_dir() {
        return Err(FoliaError::InvalidPath(path_to_string(&canon_dest)));
    }
    let target = unique_copy_target(&canon_src, &canon_dest);
    copy_recursive(&canon_src, &target)?;
    canonicalize_clean(&target)
}

fn unique_copy_target(src: &Path, dest_dir: &Path) -> PathBuf {
    let stem = src
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "copy".to_string());
    let ext = src
        .extension()
        .map(|e| format!(".{}", e.to_string_lossy()))
        .unwrap_or_default();

    let first = dest_dir.join(format!("{stem}{ext}"));
    if !first.exists() {
        return first;
    }
    for i in 1..1000 {
        let candidate = if i == 1 {
            dest_dir.join(format!("{stem} 副本{ext}"))
        } else {
            dest_dir.join(format!("{stem} 副本 {i}{ext}"))
        };
        if !candidate.exists() {
            return candidate;
        }
    }
    dest_dir.join(format!("{stem}-{}{ext}", Uuid::new_v4()))
}

fn copy_recursive(src: &Path, dst: &Path) -> Result<(), FoliaError> {
    if src.is_dir() {
        fs::create_dir_all(dst)?;
        for entry in fs::read_dir(src)? {
            let entry = entry?;
            let child_src = entry.path();
            let child_dst = dst.join(entry.file_name());
            copy_recursive(&child_src, &child_dst)?;
        }
    } else {
        fs::copy(src, dst)?;
    }
    Ok(())
}

pub fn delete_to_trash(path: &Path) -> Result<(), FoliaError> {
    let canon = canonicalize_clean(path)?;
    trash::delete(&canon).map_err(|e| FoliaError::Trash(e.to_string()))
}

pub fn list_attachments(note_path: &Path) -> Result<Vec<AttachmentItem>, FoliaError> {
    let canon = canonicalize_clean(note_path)?;
    let doc_dir = if canon.is_dir() {
        canon.clone()
    } else {
        canon
            .parent()
            .ok_or_else(|| FoliaError::InvalidPath(path_to_string(&canon)))?
            .to_path_buf()
    };

    let mut dirs_to_scan = vec![doc_dir.clone()];
    for sub in ["images", "Images", "图片", "assets", "attachments", "附件"] {
        let candidate = doc_dir.join(sub);
        if candidate.is_dir() {
            dirs_to_scan.push(candidate);
        }
    }

    let mut items = Vec::new();
    for dir in dirs_to_scan {
        if let Ok(entries) = fs::read_dir(&dir) {
            for entry in entries.flatten() {
                let p = strip_verbatim_prefix(entry.path());
                let meta = match entry.metadata() {
                    Ok(m) if m.is_file() => m,
                    _ => continue,
                };
                let name = entry.file_name().to_string_lossy().to_string();
                if should_skip_entry(&name, false) {
                    continue;
                }
                let ext = p
                    .extension()
                    .map(|e| e.to_string_lossy().to_string())
                    .unwrap_or_default();
                let kind = classify_extension(&ext);
                if kind == FileKind::Markdown {
                    continue;
                }
                let rel = compute_relative_posix(&doc_dir, &p);
                items.push(AttachmentItem {
                    name,
                    path: path_to_string(&p),
                    relative_path: rel,
                    kind,
                    extension: ext,
                    size_bytes: meta.len(),
                    mtime_ms: metadata_mtime_ms(&meta),
                });
            }
        }
    }

    items.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(items)
}

pub fn save_attachment_bytes(
    note_path: &Path,
    workspace_root: &Path,
    strategy: &str,
    custom_dir: &str,
    suggested_name: Option<&str>,
    ext: &str,
    bytes: &[u8],
) -> Result<(PathBuf, String), FoliaError> {
    let canon_note = canonicalize_clean(note_path)?;
    let doc_dir = canon_note
        .parent()
        .ok_or_else(|| FoliaError::InvalidPath(path_to_string(&canon_note)))?;

    let target_dir = match strategy {
        "sameDir" => doc_dir.to_path_buf(),
        "workspaceSubfolder" => {
            let sub = if custom_dir.trim().is_empty() {
                "attachments"
            } else {
                custom_dir.trim()
            };
            workspace_root.join(sub)
        }
        _ => {
            let sub = if custom_dir.trim().is_empty() {
                "images"
            } else {
                custom_dir.trim()
            };
            doc_dir.join(sub)
        }
    };

    fs::create_dir_all(&target_dir)?;

    let clean_ext = ext.trim_start_matches('.').to_ascii_lowercase();
    let clean_ext = if clean_ext.is_empty() { "png" } else { &clean_ext };

    let base = match suggested_name {
        Some(n) if !n.trim().is_empty() => {
            let sanitized: String = n
                .trim()
                .chars()
                .map(|c| {
                    if matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') {
                        '-'
                    } else {
                        c
                    }
                })
                .collect();
            let p = Path::new(&sanitized);
            p.file_stem()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_else(|| "image".to_string())
        }
        _ => {
            let note_stem = canon_note
                .file_stem()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_else(|| "note".to_string());
            let stamp = Local::now().format("%Y%m%d-%H%M%S");
            format!("{note_stem}-{stamp}")
        }
    };

    let mut target_file = target_dir.join(format!("{base}.{clean_ext}"));
    if target_file.exists() {
        let short_id = &Uuid::new_v4().to_string()[..6];
        target_file = target_dir.join(format!("{base}-{short_id}.{clean_ext}"));
    }

    fs::write(&target_file, bytes)?;
    let canon_saved = canonicalize_clean(&target_file)?;
    let rel_posix = compute_relative_posix(doc_dir, &canon_saved);
    Ok((canon_saved, rel_posix))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn test_relative_posix_paths() {
        let root = tempdir().unwrap();
        let notes = root.path().join("私人文档");
        let images = root.path().join("图片");
        fs::create_dir_all(&notes).unwrap();
        fs::create_dir_all(&images).unwrap();
        let img = images.join("esp32 接线.png");
        fs::write(&img, b"png").unwrap();

        let rel = compute_relative_posix(&notes, &img);
        assert_eq!(rel, "../图片/esp32 接线.png");
    }

    #[test]
    fn test_workspace_boundary_check() {
        let ws = tempdir().unwrap();
        let outside = tempdir().unwrap();
        let inside_file = ws.path().join("a.md");
        let outside_file = outside.path().join("secret.txt");
        fs::write(&inside_file, b"ok").unwrap();
        fs::write(&outside_file, b"no").unwrap();

        let roots = vec![ws.path().to_path_buf()];
        assert!(is_path_within_roots(&inside_file, &roots));
        assert!(!is_path_within_roots(&outside_file, &roots));
    }
}
