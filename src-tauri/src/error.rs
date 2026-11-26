use serde::Serialize;
use thiserror::Error;

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ConflictPayload {
    pub disk_content: String,
    pub disk_hash: String,
    pub disk_mtime_ms: u64,
    pub encoding: String,
    pub has_bom: bool,
    pub line_ending: String,
}

#[derive(Debug, Error)]
pub enum FoliaError {
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),

    #[error("Path not found: {0}")]
    NotFound(String),

    #[error("Target already exists: {0}")]
    AlreadyExists(String),

    #[error("Invalid path: {0}")]
    InvalidPath(String),

    #[error("Access denied outside open workspaces: {0}")]
    OutsideWorkspace(String),

    #[error("External file conflict detected")]
    Conflict(ConflictPayload),

    #[error("Trash error: {0}")]
    Trash(String),

    #[error("Watch error: {0}")]
    Watch(String),

    #[error("Search error: {0}")]
    Search(String),

    #[error("Config error: {0}")]
    Config(String),
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SerializedError {
    code: &'static str,
    message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    conflict: Option<ConflictPayload>,
}

impl Serialize for FoliaError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        let payload = match self {
            FoliaError::Io(e) => SerializedError {
                code: "IO_ERROR",
                message: e.to_string(),
                conflict: None,
            },
            FoliaError::NotFound(p) => SerializedError {
                code: "NOT_FOUND",
                message: format!("文件或目录不存在: {p}"),
                conflict: None,
            },
            FoliaError::AlreadyExists(p) => SerializedError {
                code: "ALREADY_EXISTS",
                message: format!("目标已存在: {p}"),
                conflict: None,
            },
            FoliaError::InvalidPath(p) => SerializedError {
                code: "INVALID_PATH",
                message: format!("无效路径: {p}"),
                conflict: None,
            },
            FoliaError::OutsideWorkspace(p) => SerializedError {
                code: "OUTSIDE_WORKSPACE",
                message: format!("路径超出已打开工作区范围: {p}"),
                conflict: None,
            },
            FoliaError::Conflict(c) => SerializedError {
                code: "FILE_CONFLICT",
                message: "文件已被外部程序修改".to_string(),
                conflict: Some(c.clone()),
            },
            FoliaError::Trash(m) => SerializedError {
                code: "TRASH_ERROR",
                message: m.clone(),
                conflict: None,
            },
            FoliaError::Watch(m) => SerializedError {
                code: "WATCH_ERROR",
                message: m.clone(),
                conflict: None,
            },
            FoliaError::Search(m) => SerializedError {
                code: "SEARCH_ERROR",
                message: m.clone(),
                conflict: None,
            },
            FoliaError::Config(m) => SerializedError {
                code: "CONFIG_ERROR",
                message: m.clone(),
                conflict: None,
            },
        };
        payload.serialize(serializer)
    }
}

