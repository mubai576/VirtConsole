//! PVE REST 接入层。
//!
//! 鉴权双支持：API Token（`Authorization: PVEAPIToken=...`）或 用户名密码
//! （`POST /access/ticket` 取 ticket + CSRF）。开发机可用 `mock://` 主机离线联调。

use serde::Serialize;
use serde_json::{json, Value};

use crate::config::PveAuth;

#[derive(Serialize, Clone)]
pub struct Entity {
    pub kind: String, // "host" | "vm"
    pub vmid: Option<u32>,
    pub name: String,
    pub status: String,
    /// 百分比 0..100
    pub cpu: Option<f64>,
    pub mem: Option<f64>,
    pub mem_total: Option<f64>,
    pub node: String,
    pub pve_version: Option<String>,
}

#[derive(Serialize, Clone)]
pub struct VmDetail {
    pub vmid: u32,
    pub name: String,
    pub status: String,
    pub cores: u32,
    pub memory: u32,
    pub disk: String,
    pub vga: String,
    pub mode: String,
}

#[derive(Serialize, Clone)]
pub struct Snapshot {
    pub name: String,
    pub parent: Option<String>,
    pub state: String,
}

#[derive(Serialize, Clone)]
pub struct HostLive {
    pub cpu: f64, // %
    pub mem: f64,
    pub mem_total: f64,
    pub swap: f64,
    pub swap_total: f64,
    pub load1: f64,
    pub load5: f64,
    pub load15: f64,
    pub kversion: String,
}

#[derive(Serialize, Clone, Default)]
pub struct RrdPoint {
    pub time: i64,
    pub cpu: Option<f64>,
    pub mem: Option<f64>,
    pub netin: Option<f64>,
    pub netout: Option<f64>,
    pub io: Option<f64>,
}

#[derive(Serialize, Clone)]
pub struct VmLive {
    pub status: String,
    pub cpu: f64, // %
    pub mem: f64,
    pub mem_total: f64,
}

#[derive(Serialize, Clone, Default)]
pub struct VmRrdPoint {
    pub time: i64,
    pub cpu: Option<f64>,
    pub mem: Option<f64>,
    pub diskread: Option<f64>,
    pub diskwrite: Option<f64>,
    pub netin: Option<f64>,
    pub netout: Option<f64>,
}

#[derive(Serialize, Clone, Default)]
pub struct GpuMetrics {
    pub name: Option<String>,
    pub util: Option<f64>, // %
    pub temp: Option<f64>, // °C
    pub mem_used: Option<f64>,
    pub mem_total: Option<f64>,
    pub power: Option<f64>, // W
}

pub struct PveClient {
    base: String,
    node: String,
    auth: PveAuth,
    ticket: Option<String>,
    csrf: Option<String>,
    version: String,
    http: reqwest::Client,
}

fn build_client() -> reqwest::Client {
    reqwest::Client::builder()
        .danger_accept_invalid_certs(true) // PVE 自签证书
        .build()
        .unwrap_or_else(|_| reqwest::Client::new())
}

impl PveClient {
    pub fn new(auth: &PveAuth) -> Self {
        let host = auth.host.trim().to_string();
        // 保留 mock:// 原样（trim 尾部 '/' 会破坏 scheme）
        let is_mock = host.starts_with("mock://");
        let base = if is_mock {
            "mock://".to_string()
        } else {
            host.trim_end_matches('/').to_string()
        };
        Self {
            base,
            node: auth.node.clone(),
            auth: auth.clone(),
            ticket: None,
            csrf: None,
            version: String::new(),
            http: build_client(),
        }
    }

    pub fn is_mock(&self) -> bool {
        self.base.starts_with("mock://")
    }

    /// 连接：密码鉴权先取 ticket；随后请求 /version 校验并缓存版本号。
    pub async fn connect(&mut self) -> Result<String, String> {
        if self.is_mock() {
            self.version = "9.2.0 (Mock)".into();
            return Ok("已连接 PVE（Mock 模式）".into());
        }
        if self.auth.method == "password" {
            let body = json!({
                "username": self.auth.username.clone().unwrap_or_default(),
                "password": self.auth.password.clone().unwrap_or_default(),
            });
            let resp = self.raw_post_plain("/api2/json/access/ticket", body).await?;
            let data = &resp["data"];
            let ticket = data["ticket"].as_str().unwrap_or_default().to_string();
            let csrf = data["CSRFPreventionToken"].as_str().unwrap_or_default().to_string();
            if ticket.is_empty() {
                return Err("PVE 登录失败：未返回 ticket（请检查用户名/密码与 API 权限）".into());
            }
            self.ticket = Some(ticket);
            self.csrf = Some(csrf);
        }
        let v = self.get("/api2/json/version").await?;
        self.version = v["data"]["version"].as_str().unwrap_or("").to_string();
        Ok("已连接 PVE".into())
    }

    pub fn version(&self) -> &str {
        &self.version
    }

    /// 实体列表：宿主机（实体 0）+ 各 VM。
    pub async fn list_entities(&self) -> Result<Vec<Entity>, String> {
        let mut out = Vec::new();
        let host = self.get(&format!("/api2/json/nodes/{}/status", self.node)).await?;
        let h = &host["data"];
        out.push(Entity {
            kind: "host".into(),
            vmid: None,
            name: format!("宿主机 · {}", self.node),
            status: if h["cpu"].as_f64().is_some() {
                "running".into()
            } else {
                "unknown".into()
            },
            cpu: h["cpu"].as_f64().map(|v| v * 100.0),
            mem: h["memory"].as_f64(),
            mem_total: h["maxmem"].as_f64(),
            node: self.node.clone(),
            pve_version: Some(self.version.clone()),
        });

        let vms = self
            .get("/api2/json/cluster/resources?type=vm")
            .await?;
        if let Some(arr) = vms["data"].as_array() {
            for it in arr {
                out.push(Entity {
                    kind: "vm".into(),
                    vmid: it["vmid"].as_u64().map(|v| v as u32),
                    name: it["name"].as_str().unwrap_or("").to_string(),
                    status: it["status"].as_str().unwrap_or("unknown").to_string(),
                    cpu: it["cpu"].as_f64().map(|v| v * 100.0),
                    mem: it["mem"].as_f64(),
                    mem_total: it["maxmem"].as_f64(),
                    node: it["node"].as_str().unwrap_or(&self.node).to_string(),
                    pve_version: None,
                });
            }
        }
        Ok(out)
    }

    pub async fn vm_detail(&self, vmid: u32) -> Result<VmDetail, String> {
        // 注意：VM 配置端点是 /qemu/{vmid}/config；
        // 裸 /qemu/{vmid} 返回的是子目录列表（config/status/...）
        let cfg = self
            .get(&format!("/api2/json/nodes/{}/qemu/{vmid}/config", self.node))
            .await?;
        let cur = self
            .get(&format!("/api2/json/nodes/{}/qemu/{vmid}/status/current", self.node))
            .await?;
        let c = &cfg["data"];
        // PVE 的 /config 里 memory 可能是字符串（如 "2048"），统一健壮解析
        let cores = as_u64(&c["cores"]).unwrap_or(0) as u32;
        let memory = as_u64(&c["memory"]).unwrap_or(0) as u32;
        let vga = c["vga"].as_str().unwrap_or("").to_string();
        let disk = c
            .get("virtio0")
            .or_else(|| c.get("scsi0"))
            .or_else(|| c.get("ide0"))
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let has_hostpci = c
            .as_object()
            .map(|o| o.keys().any(|k| k.starts_with("hostpci")))
            .unwrap_or(false);
        let mode = mode_label(&vga, has_hostpci);
        Ok(VmDetail {
            vmid,
            name: c["name"].as_str().unwrap_or("").to_string(),
            status: cur["data"]["status"].as_str().unwrap_or("unknown").to_string(),
            cores,
            memory,
            disk,
            vga,
            mode,
        })
    }

    pub async fn vm_action(&self, vmid: u32, action: &str) -> Result<(), String> {
        self.post(
            &format!("/api2/json/nodes/{}/qemu/{vmid}/status/{action}", self.node),
            json!({}),
            true,
        )
        .await
        .map(|_| ())
    }

    pub async fn snapshots(&self, vmid: u32) -> Result<Vec<Snapshot>, String> {
        let v = self
            .get(&format!("/api2/json/nodes/{}/qemu/{vmid}/snapshot", self.node))
            .await?;
        let mut out = Vec::new();
        if let Some(arr) = v["data"]["snapshots"].as_array() {
            for it in arr {
                out.push(Snapshot {
                    name: it["name"].as_str().unwrap_or("").to_string(),
                    parent: it["parent"].as_str().map(|s| s.to_string()),
                    state: it["snapstate"].as_str().unwrap_or("").to_string(),
                });
            }
        }
        Ok(out)
    }

    pub async fn snapshot_create(&self, vmid: u32, name: &str) -> Result<(), String> {
        self.post(
            &format!("/api2/json/nodes/{}/qemu/{vmid}/snapshot", self.node),
            json!({ "snapname": name }),
            true,
        )
        .await
        .map(|_| ())
    }

    pub async fn snapshot_rollback(&self, vmid: u32, name: &str) -> Result<(), String> {
        self.post(
            &format!("/api2/json/nodes/{}/qemu/{vmid}/snapshot/{name}/rollback", self.node),
            json!({}),
            true,
        )
        .await
        .map(|_| ())
    }

    pub async fn snapshot_delete(&self, vmid: u32, name: &str) -> Result<(), String> {
        self.delete(
            &format!("/api2/json/nodes/{}/qemu/{vmid}/snapshot/{name}", self.node),
            true,
        )
        .await
        .map(|_| ())
    }

    // ===== dbus-display 采集启用（V2.0） =====

    /// 给 VM 写入 args: -display dbus（PVE 启动时 QEMU 同时开 dbus 与默认 vnc，已验证共存）。
    /// 需 VM 停机才能改配置。
    pub async fn vm_enable_dbus(&self, vmid: u32) -> Result<(), String> {
        self.put(
            &format!("/api2/json/nodes/{}/qemu/{vmid}/config", self.node),
            json!({ "args": "-display dbus" }),
            true,
        )
        .await
        .map(|_| ())
    }

    /// 移除 VM 的 args（恢复默认，禁用 dbus-display）。
    pub async fn vm_disable_dbus(&self, vmid: u32) -> Result<(), String> {
        self.put(
            &format!("/api2/json/nodes/{}/qemu/{vmid}/config", self.node),
            json!({ "delete": "args" }),
            true,
        )
        .await
        .map(|_| ())
    }

    // ===== 监控（实时 + 历史曲线） =====

    /// 宿主机实时状态（/nodes/{node}/status）
    pub async fn host_live(&self) -> Result<HostLive, String> {
        let v = self
            .get(&format!("/api2/json/nodes/{}/status", self.node))
            .await?;
        let d = &v["data"];
        Ok(HostLive {
            cpu: d["cpu"].as_f64().unwrap_or(0.0) * 100.0,
            mem: d["memory"].as_f64().unwrap_or(0.0),
            mem_total: d["maxmem"].as_f64().unwrap_or(0.0),
            swap: d["swap"].as_f64().unwrap_or(0.0),
            swap_total: d["maxswap"].as_f64().unwrap_or(0.0),
            load1: d["loadavg"][0].as_f64().unwrap_or(0.0),
            load5: d["loadavg"][1].as_f64().unwrap_or(0.0),
            load15: d["loadavg"][2].as_f64().unwrap_or(0.0),
            kversion: d["kversion"].as_str().unwrap_or("").to_string(),
        })
    }

    /// 宿主机历史曲线（/nodes/{node}/rrddata?timeframe=hour）
    pub async fn host_rrd(&self, timeframe: &str) -> Result<Vec<RrdPoint>, String> {
        let v = self
            .get(&format!(
                "/api2/json/nodes/{}/rrddata?timeframe={timeframe}",
                self.node
            ))
            .await?;
        let mut out = Vec::new();
        if let Some(arr) = v["data"].as_array() {
            for it in arr {
                out.push(RrdPoint {
                    time: it["time"].as_i64().unwrap_or(0),
                    cpu: it["cpu"].as_f64().map(|x| x * 100.0),
                    mem: it["mem"].as_f64(),
                    netin: it["netin"].as_f64(),
                    netout: it["netout"].as_f64(),
                    io: it["io"].as_f64(),
                });
            }
        }
        Ok(out)
    }

    /// VM 实时状态（/nodes/{node}/qemu/{vmid}/status/current）
    pub async fn vm_live(&self, vmid: u32) -> Result<VmLive, String> {
        let v = self
            .get(&format!(
                "/api2/json/nodes/{}/qemu/{vmid}/status/current",
                self.node
            ))
            .await?;
        let d = &v["data"];
        Ok(VmLive {
            status: d["status"].as_str().unwrap_or("unknown").to_string(),
            cpu: d["cpu"].as_f64().unwrap_or(0.0) * 100.0,
            mem: d["mem"].as_f64().unwrap_or(0.0),
            mem_total: d["maxmem"].as_f64().unwrap_or(0.0),
        })
    }

    /// VM 历史曲线（/nodes/{node}/qemu/{vmid}/rrddata?timeframe=hour）
    pub async fn vm_rrd(&self, vmid: u32, timeframe: &str) -> Result<Vec<VmRrdPoint>, String> {
        let v = self
            .get(&format!(
                "/api2/json/nodes/{}/qemu/{vmid}/rrddata?timeframe={timeframe}",
                self.node
            ))
            .await?;
        let mut out = Vec::new();
        if let Some(arr) = v["data"].as_array() {
            for it in arr {
                out.push(VmRrdPoint {
                    time: it["time"].as_i64().unwrap_or(0),
                    cpu: it["cpu"].as_f64().map(|x| x * 100.0),
                    mem: it["mem"].as_f64(),
                    diskread: it["diskread"].as_f64(),
                    diskwrite: it["diskwrite"].as_f64(),
                    netin: it["netin"].as_f64(),
                    netout: it["netout"].as_f64(),
                });
            }
        }
        Ok(out)
    }

    /// GPU 指标（nvidia-smi；无 nvidia-smi / 非 NVIDIA 时返回 None）
    pub async fn gpu_metrics() -> Option<GpuMetrics> {
        let out = tokio::process::Command::new("nvidia-smi")
            .args([
                "--query-gpu=name,utilization.gpu,temperature.gpu,memory.used,memory.total,power.draw",
                "--format=csv,noheader,nounits",
            ])
            .output()
            .await
            .ok()?;
        if !out.status.success() {
            return None;
        }
        let text = String::from_utf8_lossy(&out.stdout);
        let line = text.lines().next()?;
        let parts: Vec<&str> = line.split(',').map(|s| s.trim()).collect();
        if parts.len() < 6 {
            return None;
        }
        Some(GpuMetrics {
            name: Some(parts[0].to_string()),
            util: parts[1].parse().ok(),
            temp: parts[2].parse().ok(),
            mem_used: parts[3].parse().ok(),
            mem_total: parts[4].parse().ok(),
            power: parts[5].parse().ok(),
        })
    }

    // ===== 底层 HTTP =====

    async fn get(&self, path: &str) -> Result<Value, String> {
        if self.is_mock() {
            return self.mock(path).await;
        }
        let mut rb = self.http.get(&format!("{}{}", self.base, path));
        if let Some(t) = &self.ticket {
            rb = rb.header("Cookie", format!("PVEAuthCookie={t}"));
        }
        if self.auth.method == "token" {
            if let Some(tk) = &self.auth.token {
                rb = rb.header("Authorization", format!("PVEAPIToken={tk}"));
            }
        }
        parse_resp(rb.send().await.map_err(|e| format!("HTTP 错误: {e}"))?).await
    }

    async fn post(&self, path: &str, body: Value, with_csrf: bool) -> Result<Value, String> {
        if self.is_mock() {
            return self.mock(path).await;
        }
        let mut rb = self
            .http
            .post(&format!("{}{}", self.base, path))
            .json(&body);
        if let Some(t) = &self.ticket {
            rb = rb.header("Cookie", format!("PVEAuthCookie={t}"));
        }
        if with_csrf {
            if let Some(c) = &self.csrf {
                rb = rb.header("CSRFPreventionToken", c);
            }
        }
        if self.auth.method == "token" {
            if let Some(tk) = &self.auth.token {
                rb = rb.header("Authorization", format!("PVEAPIToken={tk}"));
            }
        }
        parse_resp(rb.send().await.map_err(|e| format!("HTTP 错误: {e}"))?).await
    }
    async fn delete(&self, path: &str, with_csrf: bool) -> Result<Value, String> {
        if self.is_mock() {
            return self.mock(path).await;
        }
        let mut rb = self
            .http
            .delete(&format!("{}{}", self.base, path));
        if let Some(t) = &self.ticket {
            rb = rb.header("Cookie", format!("PVEAuthCookie={t}"));
        }
        if with_csrf {
            if let Some(c) = &self.csrf {
                rb = rb.header("CSRFPreventionToken", c);
            }
        }
        if self.auth.method == "token" {
            if let Some(tk) = &self.auth.token {
                rb = rb.header("Authorization", format!("PVEAPIToken={tk}"));
            }
        }
        parse_resp(rb.send().await.map_err(|e| format!("HTTP 错误: {e}"))?).await
    }

    async fn put(&self, path: &str, body: Value, with_csrf: bool) -> Result<Value, String> {
        if self.is_mock() {
            return self.mock(path).await;
        }
        let mut rb = self
            .http
            .put(&format!("{}{}", self.base, path))
            .json(&body);
        if let Some(t) = &self.ticket {
            rb = rb.header("Cookie", format!("PVEAuthCookie={t}"));
        }
        if with_csrf {
            if let Some(c) = &self.csrf {
                rb = rb.header("CSRFPreventionToken", c);
            }
        }
        if self.auth.method == "token" {
            if let Some(tk) = &self.auth.token {
                rb = rb.header("Authorization", format!("PVEAPIToken={tk}"));
            }
        }
        parse_resp(rb.send().await.map_err(|e| format!("HTTP 错误: {e}"))?).await
    }

    /// 无鉴权裸 POST（登录取 ticket 用）
    async fn raw_post_plain(&self, path: &str, body: Value) -> Result<Value, String> {
        let resp = self
            .http
            .post(&format!("{}{}", self.base, path))
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("HTTP 错误: {e}"))?;
        parse_resp(resp).await
    }

    // ===== Mock 后端（开发机离线联调） =====

    async fn mock(&self, path: &str) -> Result<Value, String> {
        if path.contains("/access/ticket") {
            return Ok(json!({"data":{"ticket":"mock-ticket","CSRFPreventionToken":"mock-csrf"}}));
        }
        if path.contains("/api2/json/version") {
            return Ok(json!({"data":{"version":"9.2.0","release":"9.2","repoid":"mock"}}));
        }
        if path.contains("/cluster/resources") {
            return Ok(json!({"data":[
                {"vmid":9000,"name":"Ubuntu 桌面","status":"running","cpu":0.05,"mem":2147483648_i64,"maxmem":8589934592_i64,"node":"pve"},
                {"vmid":100,"name":"Windows 11","status":"stopped","cpu":0.0,"mem":0_i64,"maxmem":8589934592_i64,"node":"pve"},
                {"vmid":200,"name":"Debian Server","status":"paused","cpu":0.0,"mem":1073741824_i64,"maxmem":4294967296_i64,"node":"pve"}
            ]}));
        }
        if path.ends_with("/status") {
            return Ok(json!({"data":{"cpu":0.42,"memory":21474836480_i64,"maxmem":42949672960_i64,"kversion":"7.0.2-6-pve","loadavg":["0.5","0.4","0.3"]}}));
        }
        if path.contains("/status/current") {
            return Ok(json!({"data":{"status":"running","cpu":0.32,"mem":2147483648_i64}}));
        }
        if path.contains("/rrddata") {
            let base = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs() as i64)
                .unwrap_or(0);
            let mut arr = Vec::new();
            for i in 0..60 {
                let t = base - (59 - i) * 60;
                let cpu = (0.3 + ((i as f64) * 0.25).sin() * 0.1 + ((i as f64) % 7.0) * 0.02).min(0.95);
                let mem = 0.5 + ((i as f64) * 0.12).sin() * 0.04;
                let mut p = json!({ "time": t, "cpu": cpu, "mem": mem * 21474836480.0 });
                if path.contains("/qemu/") {
                    p["diskread"] = json!(1048576.0 * (0.4 + ((i as f64) * 0.2).sin()));
                    p["diskwrite"] = json!(1048576.0 * (0.2 + ((i as f64) * 0.15).cos()));
                    p["netin"] = json!(524288.0 * (0.5 + ((i as f64) * 0.3).sin()));
                    p["netout"] = json!(262144.0 * (0.3 + ((i as f64) * 0.2).cos()));
                } else {
                    p["netin"] = json!(1048576.0 * (0.5 + ((i as f64) * 0.3).sin()));
                    p["netout"] = json!(524288.0 * (0.3 + ((i as f64) * 0.2).cos()));
                    p["io"] = json!(3145728.0 * (0.4 + ((i as f64) * 0.25).sin()));
                }
                arr.push(p);
            }
            return Ok(json!({ "data": arr }));
        }
        if path.contains("/snapshot") {
            return Ok(json!({"data":{"snapshots":[
                {"name":"基装","parent":"","snapstate":"ok"},
                {"name":"update-01","parent":"基装","snapstate":"ok"}
            ]}}));
        }
        if path.contains("/status/") {
            return Ok(json!({"data":"UPID:mock:action"}));
        }
        if path.contains("/qemu/") {
            // 忠实复刻真实 PVE：/config 才是配置；裸 /qemu/{vmid} 是子目录列表
            let after = path.split("/qemu/").nth(1).unwrap_or("");
            if after.ends_with("/config") {
                // memory 用字符串模拟真实 PVE 行为
                return Ok(json!({"data":{"name":"Ubuntu 桌面","cores":4,"memory":"8192","vga":"virtio","virtio0":"local-lvm:vm-9000-disk-0,size=32G"}}));
            }
            if !after.contains('/') {
                return Ok(json!({"data":[{"subdir":"config"},{"subdir":"status"}]}));
            }
            return Ok(json!({"data":{}}));
        }
        Ok(json!({"data":{}}))
    }
}

/// 采集模式判定（对应 PRD 2.1.4 三模；模式 2 实际用像素事件路径，见 M2.5 spike 结论）。
fn mode_label(vga: &str, has_hostpci: bool) -> String {
    if has_hostpci {
        "模式 3 · 直通满血（V3.0）".to_string()
    } else if vga.starts_with("virtio") {
        "模式 2 · 像素流 60fps（V2.0）".to_string()
    } else {
        "模式 1 · QMP 办公".to_string()
    }
}

/// 兼容数字或字符串的数字解析（PVE 部分字段返回字符串数字）。
fn as_u64(v: &Value) -> Option<u64> {
    v.as_u64().or_else(|| v.as_str().and_then(|s| s.parse().ok()))
}

async fn parse_resp(resp: reqwest::Response) -> Result<Value, String> {
    let status = resp.status();
    let text = resp.text().await.map_err(|e| format!("读取响应失败: {e}"))?;
    if !status.is_success() {
        return Err(format!("PVE 返回 {status}: {text}"));
    }
    serde_json::from_str(&text).map_err(|e| format!("响应解析失败: {e} :: {text}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mock_client() -> PveClient {
        PveClient::new(&PveAuth {
            method: "token".into(),
            host: "mock://".into(),
            node: "pve".into(),
            token: None,
            username: None,
            password: None,
        })
    }

    #[tokio::test]
    async fn list_entities_host_first_with_parsed_metrics() {
        let c = mock_client();
        let ents = c.list_entities().await.unwrap();
        assert_eq!(ents.len(), 4);
        assert_eq!(ents[0].kind, "host");
        assert_eq!(ents[0].node, "pve");
        // mock cpu=0.42 → 42%
        assert!((ents[0].cpu.unwrap() - 42.0).abs() < 0.01);
        // VMs：cpu 0.05 → 5%
        let vm9000 = ents.iter().find(|e| e.vmid == Some(9000)).unwrap();
        assert_eq!(vm9000.status, "running");
        assert!((vm9000.cpu.unwrap() - 5.0).abs() < 0.01);
        assert_eq!(vm9000.mem_total, Some(8_589_934_592.0));
    }

    #[test]
    fn mode_label_three_modes() {
        assert_eq!(mode_label("std", false), "模式 1 · QMP 办公");
        assert_eq!(mode_label("virtio", false), "模式 2 · 像素流 60fps（V2.0）");
        assert_eq!(mode_label("virtio-gl", false), "模式 2 · 像素流 60fps（V2.0）");
        assert_eq!(mode_label("qxl", true), "模式 3 · 直通满血（V3.0）");
        // 直通优先于 vga
        assert_eq!(mode_label("virtio", true), "模式 3 · 直通满血（V3.0）");
    }

    #[tokio::test]
    async fn vm_detail_parses_config_and_status() {
        let c = mock_client();
        let d = c.vm_detail(9000).await.unwrap();
        // 非空断言：若误用裸 /qemu/{vmid}（子目录列表）会导致字段全空，此测试能抓住
        assert!(!d.name.is_empty());
        assert!(d.cores > 0);
        assert!(d.memory > 0);
        assert!(!d.vga.is_empty());
        assert!(d.disk.contains("32G"));
        assert_eq!(d.status, "running");
        assert!(d.mode.contains("模式 2"));
    }

    #[tokio::test]
    async fn snapshots_parsed_from_mock() {
        let c = mock_client();
        let snaps = c.snapshots(9000).await.unwrap();
        assert_eq!(snaps.len(), 2);
        assert_eq!(snaps[0].name, "基装");
        assert_eq!(snaps[0].state, "ok");
    }

    #[tokio::test]
    async fn host_rrd_cpu_converted_to_percent() {
        let c = mock_client();
        let rrd = c.host_rrd("hour").await.unwrap();
        assert_eq!(rrd.len(), 60);
        let first = &rrd[0];
        // mock cpu 为 0.x 分数 → 已乘 100
        assert!(first.cpu.unwrap() > 10.0 && first.cpu.unwrap() < 100.0);
        assert!(first.mem.is_some());
        assert!(first.netin.is_some());
        assert!(first.io.is_some());
    }

    #[tokio::test]
    async fn vm_rrd_has_disk_and_net_fields() {
        let c = mock_client();
        let rrd = c.vm_rrd(9000, "hour").await.unwrap();
        assert_eq!(rrd.len(), 60);
        let last = &rrd[rrd.len() - 1];
        assert!(last.diskread.is_some());
        assert!(last.diskwrite.is_some());
        assert!(last.netin.is_some());
        assert!(last.netout.is_some());
    }

    #[tokio::test]
    async fn vm_action_and_snapshot_ops_ok() {
        let c = mock_client();
        c.vm_action(9000, "start").await.unwrap();
        c.vm_action(9000, "shutdown").await.unwrap();
        c.snapshot_create(9000, "snap-1").await.unwrap();
        c.snapshot_rollback(9000, "snap-1").await.unwrap();
        c.snapshot_delete(9000, "snap-1").await.unwrap();
    }

    #[tokio::test]
    async fn real_pve_unreachable_returns_error() {
        let mut c = PveClient::new(&PveAuth {
            method: "token".into(),
            host: "https://127.0.0.1:1".into(),
            node: "pve".into(),
            token: Some("x!y=z".into()),
            username: None,
            password: None,
        });
        assert!(c.connect().await.is_err());
    }
}
