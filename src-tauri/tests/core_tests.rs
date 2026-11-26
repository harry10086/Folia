use folia_lib::fs::encoding::{decode_bytes, encode_text, LineEnding};
use folia_lib::fs::{compute_relative_posix, is_path_within_roots};
use folia_lib::search::{SearchManager, SearchRequest, SearchScopeRoot};
use folia_lib::watcher::SelfWriteGuard;
use std::fs;
use tempfile::tempdir;

#[test]
fn roundtrip_utf8_lf() {
    let src = b"# Hello \xE4\xB8\xAD\xE6\x96\x87\nLine 2\n";
    let decoded = decode_bytes(src);
    assert_eq!(decoded.encoding, "UTF-8");
    assert!(!decoded.has_bom);
    assert_eq!(decoded.line_ending, LineEnding::Lf);
    assert_eq!(decoded.content, "# Hello 中文\nLine 2\n");

    let reencoded = encode_text(
        &decoded.content,
        &decoded.encoding,
        decoded.has_bom,
        decoded.line_ending,
    );
    assert_eq!(reencoded, src);
}

#[test]
fn roundtrip_utf8_bom_crlf() {
    let mut src = vec![0xEF, 0xBB, 0xBF];
    src.extend_from_slice("标题\r\n第二行\r\n".as_bytes());
    let decoded = decode_bytes(&src);
    assert_eq!(decoded.encoding, "UTF-8");
    assert!(decoded.has_bom);
    assert_eq!(decoded.line_ending, LineEnding::Crlf);
    assert_eq!(decoded.content, "标题\n第二行\n");

    let reencoded = encode_text(
        &decoded.content,
        &decoded.encoding,
        decoded.has_bom,
        decoded.line_ending,
    );
    assert_eq!(reencoded, src);
}

#[test]
fn roundtrip_gb18030() {
    let text = "中文旧文档内容测试，包含标点符号和数字12345。\r\n第二行测试内容。\r\n";
    let (gb_bytes, _, _) = encoding_rs::GB18030.encode(text);
    let decoded = decode_bytes(&gb_bytes);
    assert_eq!(
        decoded.content,
        "中文旧文档内容测试，包含标点符号和数字12345。\n第二行测试内容。\n"
    );
    assert_eq!(decoded.line_ending, LineEnding::Crlf);
    let reencoded = encode_text(
        &decoded.content,
        &decoded.encoding,
        decoded.has_bom,
        decoded.line_ending,
    );
    assert_eq!(reencoded.as_slice(), gb_bytes.as_ref());
}

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

#[test]
fn self_write_guard_matches_same_hash_and_rejects_different_hash() {
    let guard = SelfWriteGuard::default();
    guard.record_write("D:\\Notes\\a.md", "hash_v1");
    assert!(guard.is_self_write("D:\\Notes\\a.md", "hash_v1"));
    assert!(!guard.is_self_write("D:\\Notes\\a.md", "hash_external_v2"));
}

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

#[test]
fn test_obsidian_resources_fallback_image_resolution() {
    let vault = tempdir().unwrap();
    let ws = vault.path().join("01工作");
    let sub = ws.join("测试与仿真");
    let res_dir = vault.path().join("_resources");
    fs::create_dir_all(&sub).unwrap();
    fs::create_dir_all(&res_dir).unwrap();

    let note = sub.join("测试.md");
    let img = res_dir.join("7697c8711b8e18121ad23861bb20398d.jpg");
    fs::write(&note, b"![img](7697c8711b8e18121ad23861bb20398d.jpg)").unwrap();
    fs::write(&img, b"fakejpg").unwrap();

    // Direct candidate next to note doesn't exist; protocol resolver should locate vault/_resources/<filename>
    let missing_direct = sub.join("7697c8711b8e18121ad23861bb20398d.jpg");
    let resolved = folia_lib::protocol::resolve_asset_path(
        &missing_direct,
        Some(&note.to_string_lossy()),
        &[ws],
    );
    assert!(resolved.is_some());
    assert_eq!(
        resolved.unwrap().file_name().unwrap().to_string_lossy(),
        "7697c8711b8e18121ad23861bb20398d.jpg"
    );
}
