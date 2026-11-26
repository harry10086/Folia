use chardetng::EncodingDetector;
use encoding_rs::Encoding;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum LineEnding {
    Lf,
    Crlf,
}

impl LineEnding {
    pub fn as_str(&self) -> &'static str {
        match self {
            LineEnding::Lf => "LF",
            LineEnding::Crlf => "CRLF",
        }
    }

    pub fn from_label(label: &str) -> Self {
        if label.eq_ignore_ascii_case("CRLF") {
            LineEnding::Crlf
        } else {
            LineEnding::Lf
        }
    }
}

#[derive(Debug, Clone)]
pub struct DecodedText {
    pub content: String,
    pub encoding: String,
    pub has_bom: bool,
    pub line_ending: LineEnding,
    pub hash: String,
}

pub fn hash_bytes(bytes: &[u8]) -> String {
    blake3::hash(bytes).to_hex().to_string()
}

pub fn detect_line_ending(text: &str) -> LineEnding {
    if let Some(idx) = text.find('\n') {
        if idx > 0 && text.as_bytes()[idx - 1] == b'\r' {
            return LineEnding::Crlf;
        }
        return LineEnding::Lf;
    }
    #[cfg(target_os = "windows")]
    {
        LineEnding::Crlf
    }
    #[cfg(not(target_os = "windows"))]
    {
        LineEnding::Lf
    }
}

pub fn decode_bytes(bytes: &[u8]) -> DecodedText {
    let hash = hash_bytes(bytes);

    let (encoding, has_bom, slice) = if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        (encoding_rs::UTF_8, true, &bytes[3..])
    } else if bytes.starts_with(&[0xFF, 0xFE]) {
        (encoding_rs::UTF_16LE, true, &bytes[2..])
    } else if bytes.starts_with(&[0xFE, 0xFF]) {
        (encoding_rs::UTF_16BE, true, &bytes[2..])
    } else if std::str::from_utf8(bytes).is_ok() {
        (encoding_rs::UTF_8, false, bytes)
    } else {
        let mut detector = EncodingDetector::new();
        detector.feed(bytes, true);
        let guessed = detector.guess(None, true);
        (guessed, false, bytes)
    };

    let (cow, _, _) = encoding.decode(slice);
    let raw_text = cow.into_owned();
    let line_ending = detect_line_ending(&raw_text);
    let normalized = raw_text.replace("\r\n", "\n");

    DecodedText {
        content: normalized,
        encoding: encoding.name().to_string(),
        has_bom,
        line_ending,
        hash,
    }
}

pub fn encode_text(
    content: &str,
    encoding_name: &str,
    has_bom: bool,
    line_ending: LineEnding,
) -> Vec<u8> {
    let prepared = match line_ending {
        LineEnding::Crlf => content.replace("\r\n", "\n").replace('\n', "\r\n"),
        LineEnding::Lf => content.replace("\r\n", "\n"),
    };

    let enc = Encoding::for_label(encoding_name.as_bytes()).unwrap_or(encoding_rs::UTF_8);

    if enc == encoding_rs::UTF_16LE {
        let mut out = Vec::with_capacity(prepared.len() * 2 + 2);
        if has_bom {
            out.extend_from_slice(&[0xFF, 0xFE]);
        }
        for unit in prepared.encode_utf16() {
            out.extend_from_slice(&unit.to_le_bytes());
        }
        return out;
    }
    if enc == encoding_rs::UTF_16BE {
        let mut out = Vec::with_capacity(prepared.len() * 2 + 2);
        if has_bom {
            out.extend_from_slice(&[0xFE, 0xFF]);
        }
        for unit in prepared.encode_utf16() {
            out.extend_from_slice(&unit.to_be_bytes());
        }
        return out;
    }

    let (encoded, _, _) = enc.encode(&prepared);
    let mut out = Vec::with_capacity(encoded.len() + 3);
    if has_bom && enc == encoding_rs::UTF_8 {
        out.extend_from_slice(&[0xEF, 0xBB, 0xBF]);
    }
    out.extend_from_slice(&encoded);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

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
        assert_eq!(decoded.content, "中文旧文档内容测试，包含标点符号和数字12345。\n第二行测试内容。\n");
        assert_eq!(decoded.line_ending, LineEnding::Crlf);
        let reencoded = encode_text(
            &decoded.content,
            &decoded.encoding,
            decoded.has_bom,
            decoded.line_ending,
        );
        assert_eq!(reencoded.as_slice(), gb_bytes.as_ref());
    }
}
