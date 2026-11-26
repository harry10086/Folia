use crate::error::FoliaError;
use parking_lot::Mutex;
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::{AppHandle, Emitter};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpawnTerminalResult {
    pub id: String,
    pub shell_label: String,
    pub program: String,
    pub cwd: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalDataEvent {
    pub id: String,
    pub data: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalExitEvent {
    pub id: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectedShellInfo {
    pub id: String,
    pub label: String,
    pub available: bool,
    pub path: String,
}

struct TerminalSession {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
}

#[derive(Default, Clone)]
pub struct TerminalManager {
    sessions: Arc<Mutex<HashMap<String, TerminalSession>>>,
}

#[cfg(target_os = "windows")]
fn find_git_bash() -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = vec![
        PathBuf::from(r"C:\Program Files\Git\bin\bash.exe"),
        PathBuf::from(r"C:\Program Files\Git\usr\bin\bash.exe"),
        PathBuf::from(r"C:\Program Files (x86)\Git\bin\bash.exe"),
        PathBuf::from(r"C:\Program Files (x86)\Git\usr\bin\bash.exe"),
    ];
    if let Ok(local_app) = std::env::var("LOCALAPPDATA") {
        candidates.push(PathBuf::from(&local_app).join(r"Programs\Git\bin\bash.exe"));
        candidates.push(PathBuf::from(&local_app).join(r"Programs\Git\usr\bin\bash.exe"));
    }
    if let Ok(path_env) = std::env::var("PATH") {
        for dir in std::env::split_paths(&path_env) {
            let git_exe = dir.join("git.exe");
            if git_exe.exists() {
                if let Some(parent) = dir.parent() {
                    candidates.push(parent.join(r"bin\bash.exe"));
                    candidates.push(parent.join(r"usr\bin\bash.exe"));
                }
            }
        }
    }
    candidates.into_iter().find(|p| p.exists() && p.is_file())
}

#[cfg(target_os = "windows")]
fn find_in_path(exe_name: &str) -> Option<PathBuf> {
    if let Ok(path_env) = std::env::var("PATH") {
        for dir in std::env::split_paths(&path_env) {
            let cand = dir.join(exe_name);
            if cand.exists() && cand.is_file() {
                return Some(cand);
            }
        }
    }
    None
}

pub fn detect_available_shells() -> Vec<DetectedShellInfo> {
    #[cfg(target_os = "windows")]
    {
        let git_bash = find_git_bash();
        let pwsh = find_in_path("pwsh.exe");
        vec![
            DetectedShellInfo {
                id: "git-bash".to_string(),
                label: "Git Bash".to_string(),
                available: git_bash.is_some(),
                path: git_bash
                    .map(|p| p.to_string_lossy().to_string())
                    .unwrap_or_default(),
            },
            DetectedShellInfo {
                id: "powershell".to_string(),
                label: if pwsh.is_some() {
                    "PowerShell (pwsh)".to_string()
                } else {
                    "Windows PowerShell".to_string()
                },
                available: true,
                path: pwsh
                    .map(|p| p.to_string_lossy().to_string())
                    .unwrap_or_else(|| "powershell.exe".to_string()),
            },
            DetectedShellInfo {
                id: "cmd".to_string(),
                label: "命令提示符 (CMD)".to_string(),
                available: true,
                path: "cmd.exe".to_string(),
            },
        ]
    }
    #[cfg(not(target_os = "windows"))]
    {
        let zsh_exists = Path::new("/bin/zsh").exists();
        let bash_exists = Path::new("/bin/bash").exists();
        vec![
            DetectedShellInfo {
                id: "git-bash".to_string(),
                label: "Bash (Git)".to_string(),
                available: bash_exists,
                path: "/bin/bash".to_string(),
            },
            DetectedShellInfo {
                id: "zsh".to_string(),
                label: "Zsh".to_string(),
                available: zsh_exists,
                path: "/bin/zsh".to_string(),
            },
        ]
    }
}

fn resolve_shell_command(
    shell_type: &str,
    custom_path: Option<&str>,
) -> (String, Vec<String>, String, bool) {
    let custom = custom_path.map(|s| s.trim()).filter(|s| !s.is_empty());
    if shell_type == "custom" {
        if let Some(p) = custom {
            let is_bash = p.to_lowercase().contains("bash");
            return (
                p.to_string(),
                if is_bash {
                    vec!["--login".to_string(), "-i".to_string()]
                } else {
                    Vec::new()
                },
                Path::new(p)
                    .file_name()
                    .map(|n| n.to_string_lossy().to_string())
                    .unwrap_or_else(|| "自定义终端".to_string()),
                is_bash,
            );
        }
    }

    #[cfg(target_os = "windows")]
    {
        match shell_type {
            "cmd" => ("cmd.exe".to_string(), Vec::new(), "CMD".to_string(), false),
            "powershell" => {
                if let Some(pwsh) = find_in_path("pwsh.exe") {
                    (
                        pwsh.to_string_lossy().to_string(),
                        vec!["-NoLogo".to_string()],
                        "PowerShell".to_string(),
                        false,
                    )
                } else {
                    (
                        "powershell.exe".to_string(),
                        vec!["-NoLogo".to_string()],
                        "PowerShell".to_string(),
                        false,
                    )
                }
            }
            _ => {
                if let Some(bash) = find_git_bash() {
                    (
                        bash.to_string_lossy().to_string(),
                        vec!["--login".to_string(), "-i".to_string()],
                        "Git Bash".to_string(),
                        true,
                    )
                } else {
                    (
                        "powershell.exe".to_string(),
                        vec!["-NoLogo".to_string()],
                        "PowerShell (未找到 Git Bash)".to_string(),
                        false,
                    )
                }
            }
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        match shell_type {
            "zsh" if Path::new("/bin/zsh").exists() => (
                "/bin/zsh".to_string(),
                vec!["-l".to_string()],
                "Zsh".to_string(),
                false,
            ),
            "git-bash" | "bash" if Path::new("/bin/bash").exists() => (
                "/bin/bash".to_string(),
                vec!["-l".to_string()],
                "Bash".to_string(),
                true,
            ),
            _ => {
                let default_sh = std::env::var("SHELL").unwrap_or_else(|_| {
                    if Path::new("/bin/zsh").exists() {
                        "/bin/zsh".to_string()
                    } else {
                        "/bin/bash".to_string()
                    }
                });
                let label = Path::new(&default_sh)
                    .file_name()
                    .map(|n| n.to_string_lossy().to_string())
                    .unwrap_or_else(|| "Shell".to_string());
                (default_sh, vec!["-l".to_string()], label, false)
            }
        }
    }
}

/// Safely decode streaming UTF-8 bytes without garbling multi-byte Chinese characters split across reads.
fn decode_utf8_stream(pending: &mut Vec<u8>, chunk: &[u8]) -> String {
    pending.extend_from_slice(chunk);
    match std::str::from_utf8(pending) {
        Ok(s) => {
            let out = s.to_string();
            pending.clear();
            out
        }
        Err(e) => {
            let valid_up_to = e.valid_up_to();
            let mut out = String::new();
            if valid_up_to > 0 {
                out.push_str(std::str::from_utf8(&pending[..valid_up_to]).unwrap_or(""));
            }
            if let Some(err_len) = e.error_len() {
                out.push('\u{FFFD}');
                let rest = pending[valid_up_to + err_len..].to_vec();
                *pending = rest;
            } else {
                // Incomplete multi-byte sequence at end of buffer; wait for next chunk
                let rest = pending[valid_up_to..].to_vec();
                *pending = rest;
            }
            out
        }
    }
}

impl TerminalManager {
    pub fn spawn(
        &self,
        app: AppHandle,
        cwd: String,
        shell_type: String,
        custom_path: Option<String>,
        cols: u16,
        rows: u16,
    ) -> Result<SpawnTerminalResult, FoliaError> {
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows: rows.max(5),
                cols: cols.max(20),
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| FoliaError::InvalidPath(format!("创建终端 PTY 失败: {e}")))?;

        let (program, args, shell_label, is_git_bash) =
            resolve_shell_command(&shell_type, custom_path.as_deref());

        let mut cmd = CommandBuilder::new(&program);
        for a in &args {
            cmd.arg(a);
        }

        let work_dir = PathBuf::from(&cwd);
        if work_dir.exists() && work_dir.is_dir() {
            cmd.cwd(&work_dir);
        }

        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        if is_git_bash {
            // Keep Git Bash in the requested workspace directory instead of jumping to $HOME
            cmd.env("CHERE_INVOKING", "1");
            cmd.env("MSYSTEM", "MINGW64");
        }

        let child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| FoliaError::InvalidPath(format!("启动终端 {program} 失败: {e}")))?;
        drop(pair.slave);

        let mut reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| FoliaError::InvalidPath(format!("初始化终端输出流失败: {e}")))?;
        let writer = pair
            .master
            .take_writer()
            .map_err(|e| FoliaError::InvalidPath(format!("初始化终端输入流失败: {e}")))?;

        let id = format!("term-{}", Uuid::new_v4().simple());

        self.sessions.lock().insert(
            id.clone(),
            TerminalSession {
                master: pair.master,
                writer,
                child,
            },
        );

        let id_clone = id.clone();
        let sessions_ref = Arc::clone(&self.sessions);
        std::thread::spawn(move || {
            let mut buf = [0u8; 4096];
            let mut pending = Vec::new();
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        let text = decode_utf8_stream(&mut pending, &buf[..n]);
                        if !text.is_empty() {
                            let _ = app.emit(
                                "terminal:data",
                                TerminalDataEvent {
                                    id: id_clone.clone(),
                                    data: text,
                                },
                            );
                        }
                    }
                    Err(_) => break,
                }
            }
            if !pending.is_empty() {
                let tail = String::from_utf8_lossy(&pending).to_string();
                let _ = app.emit(
                    "terminal:data",
                    TerminalDataEvent {
                        id: id_clone.clone(),
                        data: tail,
                    },
                );
            }
            sessions_ref.lock().remove(&id_clone);
            let _ = app.emit("terminal:exit", TerminalExitEvent { id: id_clone });
        });

        Ok(SpawnTerminalResult {
            id,
            shell_label,
            program,
            cwd,
        })
    }

    pub fn write(&self, id: &str, data: &str) -> Result<(), FoliaError> {
        let mut guard = self.sessions.lock();
        if let Some(session) = guard.get_mut(id) {
            session
                .writer
                .write_all(data.as_bytes())
                .map_err(|e| FoliaError::InvalidPath(format!("写入终端失败: {e}")))?;
            let _ = session.writer.flush();
        }
        Ok(())
    }

    pub fn resize(&self, id: &str, cols: u16, rows: u16) -> Result<(), FoliaError> {
        let guard = self.sessions.lock();
        if let Some(session) = guard.get(id) {
            let _ = session.master.resize(PtySize {
                rows: rows.max(5),
                cols: cols.max(20),
                pixel_width: 0,
                pixel_height: 0,
            });
        }
        Ok(())
    }

    pub fn kill(&self, id: &str) {
        if let Some(mut session) = self.sessions.lock().remove(id) {
            let _ = session.child.kill();
        }
    }
}
