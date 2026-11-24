use std::sync::atomic::{AtomicBool, Ordering};

use anyhow::{Context, Result, ensure};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Runtime, Url};
use tauri_plugin_deep_link::DeepLinkExt;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

use crate::{
    commands::claude_mom_import_web_key,
    show_main_window,
    upstreams::{MAX_KEY_EXPORT_BYTES, parse_web_key},
};

const IMPORT_EVENT: &str = "yclaude-key-imported";
static CONFIRMING: AtomicBool = AtomicBool::new(false);

#[derive(Clone, Serialize)]
struct ImportOutcome {
    id: Option<String>,
    message: String,
    success: bool,
}

fn decode(url: &Url) -> Result<String> {
    ensure!(
        url.scheme() == "yclaude"
            && url.host_str() == Some("import")
            && url.path() == "/v1"
            && url.username().is_empty()
            && url.password().is_none()
            && url.port().is_none()
            && url.query().is_none(),
        "不支持的 YClaude 导入链接"
    );
    let payload = url.fragment().context("导入链接缺少 Key 内容")?;
    ensure!(
        payload.len() <= MAX_KEY_EXPORT_BYTES.div_ceil(3) * 4,
        "导入内容太大"
    );
    let raw = URL_SAFE_NO_PAD
        .decode(payload)
        .context("导入链接格式错误")?;
    String::from_utf8(raw).context("导入链接格式错误")
}

fn handle<R: Runtime>(app: &AppHandle<R>, url: &Url) {
    show_main_window(app);
    let parsed = decode(url).and_then(|data| Ok((parse_web_key(&data)?.name, data)));
    let Ok((name, data)) = parsed else {
        let _ = app.emit(
            IMPORT_EVENT,
            ImportOutcome {
                id: None,
                message: "YClaude 导入链接无效".into(),
                success: false,
            },
        );
        return;
    };
    if CONFIRMING.swap(true, Ordering::AcqRel) {
        return;
    }
    let handle = app.clone();
    app.dialog()
        .message(format!("将网页 Key 导入「{name}」分组？"))
        .title("导入到 YClaude")
        .kind(MessageDialogKind::Info)
        .buttons(MessageDialogButtons::OkCancelCustom(
            "导入".into(),
            "取消".into(),
        ))
        .show(move |confirmed| {
            if confirmed {
                let result = claude_mom_import_web_key(data);
                let _ = handle.emit(
                    IMPORT_EVENT,
                    ImportOutcome {
                        id: result.payload.imported_id,
                        message: result.message,
                        success: result.status == "ok",
                    },
                );
            }
            CONFIRMING.store(false, Ordering::Release);
        });
}

pub(crate) fn install<R: Runtime>(app: &AppHandle<R>) -> Result<()> {
    let handle_for_events = app.clone();
    app.deep_link().on_open_url(move |event| {
        for url in event.urls() {
            handle(&handle_for_events, &url);
        }
    });
    if let Some(urls) = app.deep_link().get_current()? {
        for url in urls {
            handle(app, &url);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_the_web_import_contract_and_rejects_other_routes() {
        let json = r#"{"format":"yclaude-key","version":1,"keyId":"7","groupName":"测试分组","apiKey":"sk-fixture-import"}"#;
        let encoded = URL_SAFE_NO_PAD.encode(json);
        let url = Url::parse(&format!("yclaude://import/v1#{encoded}")).unwrap();
        assert_eq!(decode(&url).unwrap(), json);
        assert_eq!(
            parse_web_key(&decode(&url).unwrap()).unwrap().name,
            "测试分组"
        );
        for rule in [
            "yclaude://import/v2",
            "yclaude://someone@import/v1",
            "yclaude://import/v1?extra=true",
            "https://import/v1",
        ] {
            let url = Url::parse(&format!("{rule}#{encoded}")).unwrap();
            assert!(decode(&url).is_err(), "{rule}");
        }
    }
}
