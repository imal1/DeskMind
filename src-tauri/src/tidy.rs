//! The AI layer: one structured call, no agent loop (see ADR 0007).
//!
//! Two shapes of request:
//!   * **suggest** — first run, the model proposes the zone set itself
//!   * **assign**  — every later tidy, the model may only place targets into
//!                   zones that already exist (ADR 0009)

use crate::config::Config;
use serde::Deserialize;
use std::collections::HashMap;

#[derive(Deserialize)]
struct ChatResponse {
    choices: Vec<Choice>,
}

#[derive(Deserialize)]
struct Choice {
    message: Message,
}

#[derive(Deserialize)]
struct Message {
    content: String,
}

/// Strips the ``` fence models add even when told not to.
fn unfence(text: &str) -> &str {
    let t = text.trim();
    let t = t.strip_prefix("```json").or_else(|| t.strip_prefix("```")).unwrap_or(t);
    t.strip_suffix("```").unwrap_or(t).trim()
}

/// The key is passed in rather than read off `Config`: it lives in the credential
/// store now, and `Config::api_key` is only a migration inbox.
async fn ask(cfg: &Config, key: &str, prompt: String) -> Result<String, String> {
    let body = serde_json::json!({
        "model": cfg.model,
        "max_tokens": 8000,
        "messages": [{ "role": "user", "content": prompt }],
    });

    let client = reqwest::Client::new();
    let response = client
        .post(&cfg.base_url)
        .bearer_auth(key)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("请求失败：{e}"))?;

    let status = response.status();
    let text = response.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        // The provider's own words plus a plain-language reading of the status —
        // "402" on its own sends people to a search engine.
        let hint = match status.as_u16() {
            401 | 403 => "key 不对或没有权限",
            402 => "账户余额不足",
            404 => "base_url 或模型名不对",
            429 => "请求过于频繁，或已用完配额",
            500..=599 => "服务端出错，稍后再试",
            _ => "",
        };
        return if hint.is_empty() {
            Err(format!("模型返回 {status}：{text}"))
        } else {
            Err(format!("{hint}（HTTP {}）：{text}", status.as_u16()))
        };
    }

    let parsed: ChatResponse =
        serde_json::from_str(&text).map_err(|e| format!("响应不是预期格式：{e}"))?;
    parsed
        .choices
        .into_iter()
        .next()
        .map(|c| c.message.content)
        .ok_or_else(|| "响应里没有内容".to_string())
}

// ---------- first run: propose the zone set ----------

#[derive(Deserialize)]
struct SuggestReply {
    zones: Vec<SuggestZone>,
}

#[derive(Deserialize)]
struct SuggestZone {
    name: String,
    items: Vec<String>,
}

/// Returns `(zone name, member names)` pairs for the user to accept or edit.
pub async fn suggest(
    cfg: &Config,
    key: &str,
    names: &[String],
) -> Result<Vec<(String, Vec<String>)>, String> {
    let list = names
        .iter()
        .map(|n| format!("- {n}"))
        .collect::<Vec<_>>()
        .join("\n");

    // The rules here are the S1 findings turned into instructions: games kept out
    // of a catch-all "娱乐", no single-item zones, no wildly uneven split.
    let prompt = format!(
        "下面是一台 Windows 电脑上的启动项列表。请把它们分成 6 到 9 个分区。

要求：
1. 分区名用中文，2 到 4 个字，是用户自己会起的那种名字，例如「开发」「游戏」「影音」「办公」
2. 游戏必须单独成区，不要和影音合并成「娱乐」
3. 不允许出现只有 1 个条目的分区
4. 不要让某一个分区装下超过三分之一的条目
5. 每个启动项必须且只能出现在一个分区里，不能遗漏、不能重复、不能编造列表里没有的名字
6. 按用途分，不要按文件类型或首字母分

只输出 JSON，不要任何解释文字：
{{\"zones\":[{{\"name\":\"开发\",\"items\":[\"某程序\"]}}]}}

启动项列表：
{list}"
    );

    let raw = ask(cfg, key, prompt).await?;
    let reply: SuggestReply = serde_json::from_str(unfence(&raw))
        .map_err(|e| format!("模型没有返回合法 JSON：{e}\n原文：{raw}"))?;
    Ok(reply
        .zones
        .into_iter()
        .map(|z| (z.name, z.items))
        .collect())
}

// ---------- later runs: place into existing zones ----------

#[derive(Deserialize)]
struct AssignReply {
    /// launch-target name -> zone name
    assignments: HashMap<String, String>,
}

pub async fn assign(
    cfg: &Config,
    key: &str,
    names: &[String],
    zone_names: &[String],
) -> Result<HashMap<String, String>, String> {
    let list = names
        .iter()
        .map(|n| format!("- {n}"))
        .collect::<Vec<_>>()
        .join("\n");
    let zones = zone_names.join("、");

    let prompt = format!(
        "已有这些分区：{zones}

请判断下面每一个启动项应该归入哪一个**已有**分区。

要求：
1. 只能使用上面列出的分区名，不要新建、不要改名
2. 每个启动项都要给出归属
3. 按用途判断

只输出 JSON，不要任何解释文字：
{{\"assignments\":{{\"某程序\":\"开发\"}}}}

启动项列表：
{list}"
    );

    let raw = ask(cfg, key, prompt).await?;
    let reply: AssignReply = serde_json::from_str(unfence(&raw))
        .map_err(|e| format!("模型没有返回合法 JSON：{e}\n原文：{raw}"))?;
    Ok(reply.assignments)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unfence_handles_both_fence_styles_and_none() {
        assert_eq!(unfence("```json\n{\"a\":1}\n```"), "{\"a\":1}");
        assert_eq!(unfence("```\n{\"a\":1}\n```"), "{\"a\":1}");
        assert_eq!(unfence("  {\"a\":1}  "), "{\"a\":1}");
    }
}
