// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use regex::Regex;
use std::path::Path;
use std::process::Stdio;
// v2 moved Window::emit onto the Emitter trait; it has to be in scope.
use tauri::Emitter;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command as TokioCommand;
use walkdir::WalkDir;

#[derive(Clone, serde::Serialize)]
struct DeploymentUpdate {
    resource_id: String,
    status: String,
    message: String,
}

// Discovered Strands SDK components
#[derive(Clone, serde::Serialize, serde::Deserialize)]
struct DiscoveredTool {
    name: String,
    description: String,
    file_path: String,
    line_number: usize,
    tool_type: String, // "decorator" or "spec"
    parameters: Vec<ToolParameter>,
}

#[derive(Clone, serde::Serialize, serde::Deserialize)]
struct ToolParameter {
    name: String,
    param_type: String,
    description: String,
    required: bool,
}

#[derive(Clone, serde::Serialize, serde::Deserialize)]
struct DiscoveredAgent {
    name: String,
    system_prompt: Option<String>,
    file_path: String,
    line_number: usize,
    tools: Vec<String>,
}

#[derive(Clone, serde::Serialize, serde::Deserialize)]
struct DiscoveredHandler {
    name: String,
    file_path: String,
    line_number: usize,
    handler_type: String, // "lambda", "api"
}

#[derive(Clone, serde::Serialize, serde::Deserialize)]
struct ProjectDiscovery {
    tools: Vec<DiscoveredTool>,
    agents: Vec<DiscoveredAgent>,
    handlers: Vec<DiscoveredHandler>,
}

// Execute Python CLI command
#[tauri::command]
async fn execute_cli_command(
    _command: String,
    args: Vec<String>,
    window: tauri::Window,
) -> Result<String, String> {
    let mut cmd = warpcore_command();
    cmd.args(&args);
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());

    let mut child = cmd.spawn().map_err(|e| e.to_string())?;

    // Clone window for stdout
    let window_stdout = window.clone();

    // Stream stdout
    if let Some(stdout) = child.stdout.take() {
        let reader = BufReader::new(stdout);
        let mut lines = reader.lines();

        tokio::spawn(async move {
            while let Ok(Some(line)) = lines.next_line().await {
                let _ = window_stdout.emit("cli-output", line);
            }
        });
    }

    // Stream stderr
    if let Some(stderr) = child.stderr.take() {
        let reader = BufReader::new(stderr);
        let mut lines = reader.lines();

        tokio::spawn(async move {
            while let Ok(Some(line)) = lines.next_line().await {
                let _ = window.emit("cli-error", line);
            }
        });
    }

    let status = child.wait().await.map_err(|e| e.to_string())?;

    if status.success() {
        Ok("Command executed successfully".to_string())
    } else {
        Err(format!("Command failed with status: {}", status))
    }
}

// Read YAML configuration file
#[tauri::command]
async fn read_config_file(path: String) -> Result<String, String> {
    tokio::fs::read_to_string(&path)
        .await
        .map_err(|e| e.to_string())
}

// Write YAML configuration file
#[tauri::command]
async fn write_config_file(path: String, content: String) -> Result<(), String> {
    // A copy from the Holodeck lands in a folder that does not exist yet.
    if let Some(dir) = std::path::Path::new(&path).parent() {
        tokio::fs::create_dir_all(dir).await.map_err(|e| e.to_string())?;
    }
    tokio::fs::write(&path, content)
        .await
        .map_err(|e| e.to_string())
}

// Watch file for changes
#[tauri::command]
async fn watch_config_file(path: String, window: tauri::Window) -> Result<(), String> {
    use std::time::Duration;
    use tokio::time::sleep;

    tokio::spawn(async move {
        let mut last_modified = std::fs::metadata(&path).and_then(|m| m.modified()).ok();

        loop {
            sleep(Duration::from_secs(1)).await;

            if let Ok(metadata) = std::fs::metadata(&path) {
                if let Ok(modified) = metadata.modified() {
                    if Some(modified) != last_modified {
                        last_modified = Some(modified);
                        let _ = window.emit("config-file-changed", path.clone());
                    }
                }
            }
        }
    });

    Ok(())
}

// Get deployment status (mock for now, will integrate with real CLI)
#[tauri::command]
async fn get_deployment_status() -> Result<Vec<DeploymentUpdate>, String> {
    // This will be replaced with actual deployment status from CLI
    Ok(vec![])
}

/// Filename of the warpcore CLI on this platform.
const WARPCORE_BIN: &str = if cfg!(windows) { "warpcore.exe" } else { "warpcore" };

/// Locate the warpcore CLI.
///
/// Prefers the sidecar Tauri bundles next to this executable, so the GUI always
/// runs the CLI it was built and tested against. Without this the app resolved
/// a bare `warpcore` against the user's PATH, which fails outright on Windows
/// (Python console scripts install into `Scripts\`, not reliably on PATH) and
/// silently runs the wrong version anywhere else - a GUI sending `--dev` to a
/// CLI that predates the flag just gets "No such option".
///
/// Falls back to PATH so `cargo run` and `tauri dev` still work before a
/// sidecar has been produced by `packaging/build.py --sidecar`.
fn warpcore_path() -> std::path::PathBuf {
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            // Tauri strips the target triple when bundling, so the sidecar is
            // plain `warpcore` at runtime even though it ships as
            // `warpcore-aarch64-apple-darwin` in the source tree.
            let bundled = dir.join(WARPCORE_BIN);
            if bundled.is_file() {
                return bundled;
            }
        }
    }
    std::path::PathBuf::from(WARPCORE_BIN)
}

/// Build a command for the warpcore CLI.
///
/// The single place a warpcore process is constructed, so platform quirks are
/// handled once rather than at five call sites.
fn warpcore_command() -> TokioCommand {
    let mut cmd = TokioCommand::new(warpcore_path());

    // A bundled app is launched with `/` (or the .app) as its working
    // directory, and several CLI paths are CWD-relative: .warpcore/state,
    // .warpcore/logs, limits.json. Default to the home directory so those land
    // somewhere writable; config-bearing commands override this with the
    // config's own directory via with_project_dir().
    if let Some(home) = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")) {
        cmd.current_dir(home);
    }

    #[cfg(windows)]
    {
        // Without this every CLI invocation flashes a console window. The
        // `windows_subsystem = "windows"` attribute at the top of this file
        // only suppresses the console for *our* process, not for children.
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    cmd
}

/// Run a config-bearing command from the config's directory, so state and
/// logs sit beside the warpcore.yaml they belong to instead of in `/`.
fn with_project_dir(mut cmd: TokioCommand, config_path: &str) -> TokioCommand {
    if let Some(dir) = Path::new(config_path).parent() {
        if dir.is_dir() {
            cmd.current_dir(dir);
        }
    }
    cmd
}

// Build a warpcore argv. `--dev` is an option on the top-level click group,
// so it has to come before the subcommand, not after it.
fn warpcore_args(debug: bool, args: &[&str]) -> Vec<String> {
    let mut argv: Vec<String> = Vec::with_capacity(args.len() + 1);
    if debug {
        argv.push("--dev".to_string());
    }
    argv.extend(args.iter().map(|a| a.to_string()));
    argv
}

/// Run `warpcore deploy --progress` or `warpcore destroy --progress` and
/// forward what it says.
///
/// The CLI streams NDJSON on stdout: a `plan` event naming every resource the
/// run will touch, a `resource` event each time one starts or finishes, and a
/// `complete` event with the outcome. Each JSON line becomes a
/// `deployment-update` event with the CLI's payload untouched, plus a `kind`
/// so the frontend knows which run it belongs to. Anything that is not JSON
/// (Rich panels, warnings) is forwarded as `cli-output`; stderr as
/// `cli-error`. The frontend gets a synthetic `started` first and `exit` last,
/// so it can tell a CLI that never spoke from one that finished quietly.
async fn run_with_progress(
    kind: &str,
    config_path: String,
    environment: String,
    debug: bool,
    extra_args: &[&str],
    window: tauri::Window,
) -> Result<String, String> {
    use std::time::Instant;

    let start = Instant::now();
    let emit_update = |value: serde_json::Value| {
        let _ = window.emit("deployment-update", value);
    };

    emit_update(serde_json::json!({
        "event": "started",
        "kind": kind,
        "environment": environment,
        "configPath": config_path,
        "timestamp": chrono::Utc::now().to_rfc3339(),
    }));

    let mut args: Vec<&str> = vec![kind, "--env", &environment, "--config", &config_path, "--progress"];
    args.extend_from_slice(extra_args);

    let mut cmd = with_project_dir(warpcore_command(), &config_path);
    cmd.args(warpcore_args(debug, &args));
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());

    let mut child = match cmd.spawn() {
        Ok(child) => child,
        Err(e) => {
            let message = format!("could not start the warpcore CLI: {e}");
            emit_update(serde_json::json!({ "event": "error", "kind": kind, "message": message }));
            emit_update(serde_json::json!({
                "event": "exit", "kind": kind, "code": serde_json::Value::Null,
                "duration": start.elapsed().as_secs_f64(), "success": false,
            }));
            return Err(message);
        }
    };

    let kind_owned = kind.to_string();
    let window_stdout = window.clone();
    let stdout_task = child.stdout.take().map(|stdout| {
        let kind = kind_owned.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let trimmed = line.trim();
                if trimmed.starts_with('{') {
                    if let Ok(mut value) = serde_json::from_str::<serde_json::Value>(trimmed) {
                        if value.get("event").is_some() {
                            if let Some(obj) = value.as_object_mut() {
                                obj.entry("kind").or_insert_with(|| serde_json::Value::String(kind.clone()));
                            }
                            let _ = window_stdout.emit("deployment-update", value);
                            continue;
                        }
                    }
                }
                let _ = window_stdout.emit("cli-output", &line);
            }
        })
    });

    let window_stderr = window.clone();
    let stderr_task = child.stderr.take().map(|stderr| {
        tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let _ = window_stderr.emit("cli-error", &line);
            }
        })
    });

    let status = child.wait().await.map_err(|e| e.to_string())?;
    // Drain the pipes before announcing the exit, so `complete` always
    // precedes `exit`.
    if let Some(task) = stdout_task {
        let _ = task.await;
    }
    if let Some(task) = stderr_task {
        let _ = task.await;
    }

    let duration = start.elapsed().as_secs_f64();
    emit_update(serde_json::json!({
        "event": "exit",
        "kind": kind,
        "code": status.code(),
        "duration": duration,
        "success": status.success(),
    }));

    if status.success() {
        Ok(format!("{kind} finished in {duration:.1}s"))
    } else {
        Err(format!("{kind} failed with status {status}"))
    }
}

// Execute deployment with real-time status updates
#[tauri::command]
async fn execute_deployment(
    config_path: String,
    environment: String,
    debug: bool,
    window: tauri::Window,
) -> Result<String, String> {
    run_with_progress("deploy", config_path, environment, debug, &[], window).await
}

// Execute destroy with real-time status updates. `--progress` implies `-y`:
// the frontend has already asked.
#[tauri::command]
async fn execute_destroy(
    config_path: String,
    environment: String,
    debug: bool,
    window: tauri::Window,
) -> Result<String, String> {
    run_with_progress("destroy", config_path, environment, debug, &["-y"], window).await
}

// Validate configuration
#[tauri::command]
async fn validate_config(config_path: String) -> Result<String, String> {
    let output = warpcore_command()
        .args(&["validate", "--config", &config_path])
        .output()
        .await
        .map_err(|e| e.to_string())?;

    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).to_string())
    }
}

// Get deployment history
#[tauri::command]
async fn get_deployment_history(
    config_path: String,
    environment: String,
    limit: u32,
) -> Result<String, String> {
    let output = warpcore_command()
        .args(&[
            "history",
            "list",
            "--env",
            &environment,
            "--config",
            &config_path,
            "--limit",
            &limit.to_string(),
        ])
        .output()
        .await
        .map_err(|e| e.to_string())?;

    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).to_string())
    }
}

// Scan a directory for Strands SDK components
#[tauri::command]
async fn scan_project_for_strands(directory: String) -> Result<ProjectDiscovery, String> {
    let mut discovery = ProjectDiscovery {
        tools: Vec::new(),
        agents: Vec::new(),
        handlers: Vec::new(),
    };

    // Regex patterns for Strands SDK patterns
    let tool_decorator_re =
        Regex::new(r#"@tool(?:\([^)]*\))?\s*\n\s*(?:async\s+)?def\s+(\w+)\s*\(([^)]*)\)"#).unwrap();
    let tool_spec_re = Regex::new(
        r#"TOOL_SPEC\s*=\s*\{[^}]*"name"\s*:\s*"([^"]+)"[^}]*"description"\s*:\s*"([^"]+)""#,
    )
    .unwrap();
    // Match Agent() calls - capture the function/variable context
    let agent_re = Regex::new(r#"(?:return\s+)?Agent\s*\("#).unwrap();
    // Match agent factory functions like create_*_agent or make_*_agent (reserved for future use)
    let _agent_factory_re = Regex::new(
        r#"def\s+(create_\w*_?agent|make_\w*_?agent|\w+_agent)\s*\([^)]*\)\s*(?:->.*?)?:"#,
    )
    .unwrap();
    // Match graph node additions: builder.add_node(agent, "node_name") or add_node(agent, "name")
    let graph_node_re =
        Regex::new(r#"\.?add_node\s*\(\s*(\w+)\s*,\s*["']([^"']+)["']\s*\)"#).unwrap();
    // Match GraphBuilder definitions (reserved for future use)
    let _graph_builder_re = Regex::new(r#"(\w+)\s*=\s*GraphBuilder\s*\(\s*\)"#).unwrap();
    // Match graph building functions
    let graph_func_re =
        Regex::new(r#"def\s+(build_\w*graph|\w+_graph)\s*\([^)]*\)\s*(?:->.*?)?:"#).unwrap();
    // Match Lambda handlers AND main entry points
    let handler_re = Regex::new(r#"def\s+(handler|lambda_handler)\s*\(\s*event[^)]*\)"#).unwrap();
    let main_re = Regex::new(r#"def\s+(main)\s*\(\s*\)"#).unwrap();
    // Match strands_tools imports to detect available tools
    let strands_tools_import_re =
        Regex::new(r#"from\s+strands_tools\s+import\s+\(?\s*([^)]+)\)?"#).unwrap();
    let docstring_re = Regex::new(r#""""([^"]*(?:""[^"]*)*?)""""#).unwrap();
    let args_section_re = Regex::new(r#"Args:\s*((?:\s+\w+:[^\n]+\n?)+)"#).unwrap();
    let param_line_re = Regex::new(r#"(\w+):\s*(.+)"#).unwrap();

    let path = Path::new(&directory);
    if !path.exists() {
        return Err(format!("Directory does not exist: {}", directory));
    }

    for entry in WalkDir::new(&directory)
        .follow_links(true)
        .into_iter()
        .filter_map(|e| e.ok())
    {
        let path = entry.path();

        // Skip hidden directories and common non-source directories
        if path.to_string_lossy().contains("/.")
            || path.to_string_lossy().contains("__pycache__")
            || path.to_string_lossy().contains("/node_modules/")
            || path.to_string_lossy().contains("/venv/")
            || path.to_string_lossy().contains("/.venv/")
            || path.to_string_lossy().contains("/dist/")
            || path.to_string_lossy().contains("/build/")
        {
            continue;
        }

        // Only process Python files
        if path.extension().map_or(false, |ext| ext == "py") {
            if let Ok(content) = std::fs::read_to_string(path) {
                let lines: Vec<&str> = content.lines().collect();
                let file_path = path.to_string_lossy().to_string();

                // Find @tool decorated functions
                for cap in tool_decorator_re.captures_iter(&content) {
                    let name = cap.get(1).map_or("", |m| m.as_str()).to_string();
                    let params_str = cap.get(2).map_or("", |m| m.as_str());

                    // Find line number
                    let match_start = cap.get(0).unwrap().start();
                    let line_number = content[..match_start].matches('\n').count() + 1;

                    // Extract parameters
                    let mut parameters = Vec::new();
                    for param in params_str.split(',') {
                        let param = param.trim();
                        if param.is_empty() || param == "self" || param.contains("tool_context") {
                            continue;
                        }

                        let (param_name, param_type) = if param.contains(':') {
                            let parts: Vec<&str> = param.splitn(2, ':').collect();
                            (
                                parts[0].trim().to_string(),
                                parts.get(1).map_or("Any".to_string(), |t| {
                                    t.split('=').next().unwrap_or("Any").trim().to_string()
                                }),
                            )
                        } else {
                            (
                                param.split('=').next().unwrap_or(param).trim().to_string(),
                                "Any".to_string(),
                            )
                        };

                        let required = !param.contains('=');

                        parameters.push(ToolParameter {
                            name: param_name,
                            param_type,
                            description: String::new(),
                            required,
                        });
                    }

                    // Try to extract description from docstring
                    let mut description = String::new();
                    if line_number < lines.len() {
                        // Look for docstring in the next few lines
                        let func_content = lines[line_number..].join("\n");
                        if let Some(doc_cap) = docstring_re.captures(&func_content) {
                            let docstring = doc_cap.get(1).map_or("", |m| m.as_str());
                            // First paragraph is description
                            description = docstring.lines().next().unwrap_or("").trim().to_string();

                            // Try to extract parameter descriptions from Args section
                            if let Some(args_cap) = args_section_re.captures(docstring) {
                                let args_section = args_cap.get(1).map_or("", |m| m.as_str());
                                for line in args_section.lines() {
                                    if let Some(param_cap) = param_line_re.captures(line.trim()) {
                                        let pname = param_cap.get(1).map_or("", |m| m.as_str());
                                        let pdesc = param_cap.get(2).map_or("", |m| m.as_str());
                                        for p in parameters.iter_mut() {
                                            if p.name == pname {
                                                p.description = pdesc.trim().to_string();
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }

                    discovery.tools.push(DiscoveredTool {
                        name,
                        description,
                        file_path: file_path.clone(),
                        line_number,
                        tool_type: "decorator".to_string(),
                        parameters,
                    });
                }

                // Find TOOL_SPEC definitions
                for cap in tool_spec_re.captures_iter(&content) {
                    let name = cap.get(1).map_or("", |m| m.as_str()).to_string();
                    let description = cap.get(2).map_or("", |m| m.as_str()).to_string();

                    let match_start = cap.get(0).unwrap().start();
                    let line_number = content[..match_start].matches('\n').count() + 1;

                    discovery.tools.push(DiscoveredTool {
                        name,
                        description,
                        file_path: file_path.clone(),
                        line_number,
                        tool_type: "spec".to_string(),
                        parameters: Vec::new(), // Would need more complex parsing for TOOL_SPEC params
                    });
                }

                // Find graph nodes: builder.add_node(agent_var, "node_name")
                // These are the actual agents used in the graph
                for cap in graph_node_re.captures_iter(&content) {
                    let agent_var = cap.get(1).map_or("", |m| m.as_str()).to_string();
                    let node_name = cap.get(2).map_or("", |m| m.as_str()).to_string();
                    let match_start = cap.get(0).unwrap().start();
                    let line_number = content[..match_start].matches('\n').count() + 1;

                    // Try to find where this agent variable is created to get more context
                    // Look for pattern like: agent_var = create_*_agent() or agent_var = Agent(...)
                    let agent_creation_re = Regex::new(&format!(
                        r#"{}\s*=\s*(?:create_(\w+)_agent|Agent\s*\()"#,
                        regex::escape(&agent_var)
                    ))
                    .ok();

                    let agent_type = agent_creation_re
                        .and_then(|re| re.captures(&content))
                        .and_then(|c| c.get(1))
                        .map(|m| m.as_str().to_string());

                    let description = if let Some(ref atype) = agent_type {
                        format!("{} agent", atype)
                    } else {
                        format!("Graph node using {}", agent_var)
                    };

                    discovery.agents.push(DiscoveredAgent {
                        name: node_name,
                        system_prompt: Some(description),
                        file_path: file_path.clone(),
                        line_number,
                        tools: Vec::new(),
                    });
                }

                // Find graph building functions
                for cap in graph_func_re.captures_iter(&content) {
                    let name = cap.get(1).map_or("", |m| m.as_str()).to_string();
                    let match_start = cap.get(0).unwrap().start();
                    let line_number = content[..match_start].matches('\n').count() + 1;

                    discovery.handlers.push(DiscoveredHandler {
                        name,
                        file_path: file_path.clone(),
                        line_number,
                        handler_type: "graph".to_string(),
                    });
                }

                // Also find direct Agent() instantiations with variable assignment
                for cap in agent_re.captures_iter(&content) {
                    let match_start = cap.get(0).unwrap().start();
                    let line_number = content[..match_start].matches('\n').count() + 1;

                    // Try to extract a name from variable assignment on the same line
                    let before_match = &content[..match_start];
                    let last_line = before_match.lines().last().unwrap_or("");

                    // Only add if it's a direct assignment (not inside a function return)
                    if last_line.contains('=') && !last_line.trim().starts_with("return") {
                        let name = last_line
                            .split('=')
                            .next()
                            .map(|s| s.trim().to_string())
                            .unwrap_or_else(|| format!("agent_{}", line_number));

                        discovery.agents.push(DiscoveredAgent {
                            name,
                            system_prompt: None,
                            file_path: file_path.clone(),
                            line_number,
                            tools: Vec::new(),
                        });
                    }
                }

                // Find strands_tools imports and add them as available tools
                for cap in strands_tools_import_re.captures_iter(&content) {
                    let imports = cap.get(1).map_or("", |m| m.as_str());
                    let match_start = cap.get(0).unwrap().start();
                    let line_number = content[..match_start].matches('\n').count() + 1;

                    // Parse comma-separated imports
                    for tool_name in imports.split(',') {
                        let tool_name = tool_name.trim().trim_matches('\n').trim();
                        if !tool_name.is_empty() && !tool_name.starts_with('#') {
                            discovery.tools.push(DiscoveredTool {
                                name: tool_name.to_string(),
                                description: format!("Built-in tool from strands_tools"),
                                file_path: file_path.clone(),
                                line_number,
                                tool_type: "builtin".to_string(),
                                parameters: Vec::new(),
                            });
                        }
                    }
                }

                // Find Lambda handlers
                for cap in handler_re.captures_iter(&content) {
                    let name = cap.get(1).map_or("handler", |m| m.as_str()).to_string();

                    let match_start = cap.get(0).unwrap().start();
                    let line_number = content[..match_start].matches('\n').count() + 1;

                    discovery.handlers.push(DiscoveredHandler {
                        name,
                        file_path: file_path.clone(),
                        line_number,
                        handler_type: "lambda".to_string(),
                    });
                }

                // Find main() entry points
                for cap in main_re.captures_iter(&content) {
                    let name = cap.get(1).map_or("main", |m| m.as_str()).to_string();

                    let match_start = cap.get(0).unwrap().start();
                    let line_number = content[..match_start].matches('\n').count() + 1;

                    discovery.handlers.push(DiscoveredHandler {
                        name,
                        file_path: file_path.clone(),
                        line_number,
                        handler_type: "entrypoint".to_string(),
                    });
                }
            }
        }
    }

    Ok(discovery)
}

// ---------------------------------------------------------------------------
// Account discovery
//
// These shell out to the bundled CLI's `discover` commands and hand the JSON
// back to the webview untouched. All the AWS work happens in Python; the Rust
// side only owns process lifecycle.
// ---------------------------------------------------------------------------

/// The scan currently running, if any, so `cancel_scan` can kill it.
///
/// Only one scan makes sense at a time from the UI, so this is a single slot
/// rather than a registry. A tokio Mutex because the slot is held across
/// awaits while the child's output is being read.
#[derive(Default)]
struct ActiveScan(tokio::sync::Mutex<Option<ScanProcess>>);

struct ScanProcess {
    child: tokio::process::Child,
    /// Process-group id, equal to the child's pid because it leads a new group.
    /// The frozen CLI is a PyInstaller onefile: the process we spawn is a
    /// bootloader that forks the real worker and exits, so the worker is
    /// reparented to init and outlives a kill aimed at the bootloader alone.
    /// Killing the whole group reaches the worker.
    #[cfg(unix)]
    pgid: i32,
}

/// Run a warpcore command whose process is registered as the active scan.
///
/// Unlike run_warpcore_json this keeps the Child in shared state while its
/// output streams, so `cancel_scan` can `start_kill()` it. A killed process
/// surfaces as Err("cancelled") rather than a generic non-zero exit, so the
/// UI can tell the two apart.
async fn run_cancellable_scan(
    state: &ActiveScan,
    window: &tauri::Window,
    args: &[&str],
) -> Result<String, String> {
    run_cancellable_scan_in(state, window, args, None).await
}

/// As run_cancellable_scan, optionally from a given working directory. The
/// project command writes deployment state relative to the CWD, so it has
/// to run from the new project's directory.
async fn run_cancellable_scan_in(
    state: &ActiveScan,
    window: &tauri::Window,
    args: &[&str],
    cwd: Option<&Path>,
) -> Result<String, String> {
    use tokio::io::AsyncReadExt;

    let mut cmd = warpcore_command();
    if let Some(dir) = cwd {
        cmd.current_dir(dir);
    }
    cmd.args(args);
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());
    cmd.kill_on_drop(true);

    // Lead a new process group so cancel_scan can signal the whole tree.
    #[cfg(unix)]
    cmd.process_group(0);

    let mut child = cmd.spawn().map_err(|e| format!("could not start warpcore: {e}"))?;
    #[cfg(unix)]
    let pgid = child.id().map(|id| id as i32).unwrap_or(0);

    let stdout = child.stdout.take().ok_or("no stdout")?;
    let mut stderr = child.stderr.take().ok_or("no stderr")?;

    {
        let mut slot = state.0.lock().await;
        if let Some(previous) = slot.take() {
            // A scan was already running; the UI should prevent this, but a
            // second Scan click must not leave the first one orphaned.
            kill_scan(previous);
        }
        *slot = Some(ScanProcess {
            child,
            #[cfg(unix)]
            pgid,
        });
    }

    // stdout is newline-delimited JSON: progress events as they happen, then a
    // final `result` event carrying the inventory. Relaying each line as it
    // arrives is the whole point - buffering to EOF would defeat the progress
    // display this feeds.
    let progress_window = window.clone();
    let reader = BufReader::new(stdout);
    let mut lines = reader.lines();
    let mut result: Option<String> = None;

    // stderr is drained concurrently: it carries logs, and letting it fill its
    // pipe buffer would block the child mid-scan.
    let stderr_task = tokio::spawn(async move {
        let mut buf = Vec::new();
        let _ = stderr.read_to_end(&mut buf).await;
        buf
    });

    while let Ok(Some(line)) = lines.next_line().await {
        if line.is_empty() {
            continue;
        }
        // The result line is the payload, not progress; everything else is
        // forwarded verbatim so the event schema lives in one place.
        if line.contains("\"event\":\"result\"") {
            result = Some(line);
        } else {
            let _ = progress_window.emit("scan-progress", line);
        }
    }

    let err = stderr_task.await.unwrap_or_default();

    let status = {
        let mut slot = state.0.lock().await;
        match slot.take() {
            Some(mut scan) => scan.child.wait().await.map_err(|e| e.to_string())?,
            // cancel_scan already took and killed it.
            None => return Err("cancelled".to_string()),
        }
    };

    if !status.success() {
        // A SIGKILL from cancel_scan shows up here as a signal exit with no
        // code; report it as a cancellation, not a failure.
        #[cfg(unix)]
        {
            use std::os::unix::process::ExitStatusExt;
            if status.signal().is_some() {
                return Err("cancelled".to_string());
            }
        }
        return Err(cli_failure(status, &err));
    }

    match result {
        Some(line) => Ok(line),
        None => Err("scan produced no result event".to_string()),
    }
}

/// SIGKILL the scan's whole process group (Unix), or the process (elsewhere).
fn kill_scan(mut scan: ScanProcess) {
    #[cfg(unix)]
    {
        if scan.pgid > 0 {
            // Negative pid targets the group led by pgid.
            unsafe { libc::kill(-scan.pgid, libc::SIGKILL); }
        }
    }
    // Also kill the spawned process directly, and let kill_on_drop reap it.
    let _ = scan.child.start_kill();
}

/// Kill the in-flight scan, if there is one.
#[tauri::command]
async fn cancel_scan(state: tauri::State<'_, ActiveScan>) -> Result<bool, String> {
    let scan = { state.0.lock().await.take() };
    match scan {
        Some(mut scan) => {
            #[cfg(unix)]
            { if scan.pgid > 0 { unsafe { libc::kill(-scan.pgid, libc::SIGKILL); } } }
            let _ = scan.child.start_kill();
            // Reap so it does not linger as a zombie.
            let _ = scan.child.wait().await;
            Ok(true)
        }
        None => Ok(false),
    }
}

/// Turn the CLI's stderr tail into an error message. A "No such command"
/// from the bundled CLI means the sidecar predates the feature the app just
/// asked for; say so, because "Usage: warpcore discover" on its own sent
/// someone to the wrong place.
fn cli_failure(status: std::process::ExitStatus, stderr: &[u8]) -> String {
    let text = String::from_utf8_lossy(stderr);
    let tail: String = text.lines().rev().take(8).collect::<Vec<_>>().into_iter().rev().collect::<Vec<_>>().join("\n");
    let mut message = format!("warpcore exited with {status}:\n{tail}");
    if text.contains("No such command") || text.contains("No such option") {
        message.push_str(
            "\n\nThe bundled CLI is older than this app. Rebuild it from the repo root with\n  python packaging/build.py --sidecar\nthen restart the app (tauri dev) so it picks the new one up.",
        );
    }
    message
}

/// Run the CLI and return its stdout, which is expected to be JSON.
///
/// stderr carries logs and progress and is folded into the error message on
/// failure, because that is where the reason for the failure will be.
async fn run_warpcore_json(args: &[&str]) -> Result<String, String> {
    let output = warpcore_command()
        .args(args)
        .output()
        .await
        .map_err(|e| format!("could not start warpcore: {e}"))?;

    if !output.status.success() {
        return Err(cli_failure(output.status, &output.stderr));
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

/// Profile names from ~/.aws/config and ~/.aws/credentials.
///
/// Read directly rather than via the CLI so the picker populates instantly
/// without spawning a process.
#[tauri::command]
async fn list_aws_profiles() -> Result<Vec<String>, String> {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map_err(|_| "could not determine home directory".to_string())?;
    let mut profiles = std::collections::BTreeSet::new();

    for file in ["config", "credentials"] {
        let path = Path::new(&home).join(".aws").join(file);
        if let Ok(content) = std::fs::read_to_string(&path) {
            for line in content.lines() {
                let line = line.trim();
                if line.starts_with('[') && line.ends_with(']') {
                    let name = line[1..line.len() - 1].trim();
                    let name = name.strip_prefix("profile ").unwrap_or(name).trim();
                    if !name.starts_with("sso-session") && !name.is_empty() {
                        profiles.insert(name.to_string());
                    }
                }
            }
        }
    }
    Ok(profiles.into_iter().collect())
}

/// Inventory an account. Returns the CLI's JSON verbatim.
#[tauri::command]
async fn discover_account(
    state: tauri::State<'_, ActiveScan>,
    window: tauri::Window,
    profile: String,
    regions: Vec<String>,
    all_regions: bool,
    hydrate: bool,
    parallelism: Option<u32>,
) -> Result<String, String> {
    let mut args: Vec<String> = vec![
        "--profile".into(), profile,
        "discover".into(), "inventory".into(), "--json".into(),
        // Streams progress events; the final line carries the inventory.
        "--progress".into(),
        if hydrate { "--hydrate" } else { "--no-hydrate" }.into(),
    ];
    if let Some(n) = parallelism.filter(|n| *n > 0) {
        args.push("--parallelism".into());
        args.push(n.to_string());
    }
    if all_regions {
        args.push("--all-regions".into());
    } else {
        for region in regions {
            args.push("--region".into());
            args.push(region);
        }
    }
    let borrowed: Vec<&str> = args.iter().map(String::as_str).collect();
    run_cancellable_scan(&state, &window, &borrowed).await
}

/// Turn a scanned account into a Visual Builder project. Streams the same
/// progress events as discover_account and returns the CLI's project JSON.
/// Runs from `project_dir` (created if missing) so `--adopt` writes the
/// deployment state beside the warpcore.yaml the app is about to save there.
#[tauri::command]
async fn create_project_from_account(
    state: tauri::State<'_, ActiveScan>,
    window: tauri::Window,
    profile: String,
    project_dir: String,
    project_name: String,
    environment: String,
    regions: Vec<String>,
    all_regions: bool,
    include: Vec<String>,
    exclude: Vec<String>,
    lambda_as: String,
    include_env_values: bool,
    adopt: bool,
    parallelism: Option<u32>,
) -> Result<String, String> {
    let dir = std::path::PathBuf::from(&project_dir);
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(|e| format!("could not create {project_dir}: {e}"))?;

    let mut args: Vec<String> = vec![
        "--profile".into(), profile,
        "discover".into(), "project".into(),
        "--project-name".into(), project_name,
        "--env".into(), environment,
        "--lambda-as".into(), lambda_as,
        "--progress".into(),
    ];
    if all_regions {
        args.push("--all-regions".into());
    } else {
        for region in regions {
            args.push("--region".into());
            args.push(region);
        }
    }
    for pattern in include {
        args.push("--include".into());
        args.push(pattern);
    }
    for pattern in exclude {
        args.push("--exclude".into());
        args.push(pattern);
    }
    if include_env_values {
        args.push("--include-env-values".into());
    }
    if adopt {
        args.push("--adopt".into());
    }
    if let Some(n) = parallelism.filter(|n| *n > 0) {
        args.push("--parallelism".into());
        args.push(n.to_string());
    }
    let borrowed: Vec<&str> = args.iter().map(String::as_str).collect();
    run_cancellable_scan_in(&state, &window, &borrowed, Some(&dir)).await
}

/// Regions this account has enabled, for the region picker.
#[tauri::command]
async fn list_regions(profile: String) -> Result<Vec<String>, String> {
    let json = run_warpcore_json(&[
        "--profile", &profile, "discover", "regions", "--json",
    ])
    .await?;
    serde_json::from_str(&json).map_err(|e| format!("could not parse regions: {e}"))
}

/// Everything about one resource, by ARN. Returns the CLI's JSON verbatim.
#[tauri::command]
async fn resource_detail(profile: String, arn: String, hours: u32) -> Result<String, String> {
    let hours = hours.to_string();
    run_warpcore_json(&[
        "--profile", &profile,
        "discover", "detail", &arn, "--json", "--hours", &hours,
    ])
    .await
}

/// What is wrong, wasteful or fragile in the open project, judged from what
/// its resources are doing. Returns the CLI's JSON verbatim.
#[tauri::command]
async fn project_findings(
    profile: String,
    config_path: String,
    hours: u32,
    llm_provider: Option<String>,
    llm_model: Option<String>,
) -> Result<String, String> {
    let hours = hours.to_string();
    let mut args: Vec<&str> = vec![
        "--profile", &profile,
        "discover", "findings", "--config", &config_path, "--hours", &hours, "--json",
    ];
    if let Some(provider) = llm_provider.as_deref().filter(|p| !p.is_empty()) {
        args.push("--llm-provider");
        args.push(provider);
    }
    if let Some(model) = llm_model.as_deref().filter(|m| !m.is_empty()) {
        args.push("--llm-model");
        args.push(model);
    }
    run_warpcore_json(&args).await
}

/// Ask the configured model for names or a scenario draft over the canvas's
/// facts. The input is written to a file under ~/.warpcore/cache/assistant
/// for the CLI to read, so a large graph never rides the command line.
#[tauri::command]
async fn assistant_suggest(
    kind: String,
    input: String,
    llm_provider: String,
    llm_model: Option<String>,
    ask: Option<String>,
) -> Result<String, String> {
    if kind != "names" && kind != "scenario" {
        return Err(format!("unknown suggestion kind: {kind}"));
    }
    let dir = home_dir()?.join(".warpcore").join("cache").join("assistant");
    std::fs::create_dir_all(&dir).map_err(|e| format!("could not create {}: {e}", dir.display()))?;
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let path = dir.join(format!("{kind}-{stamp}.json"));
    std::fs::write(&path, input).map_err(|e| format!("could not write {}: {e}", path.display()))?;
    let path_str = path.to_string_lossy().into_owned();
    let mut args: Vec<&str> = vec!["discover", "suggest", &kind, "--input", &path_str, "--llm-provider", &llm_provider];
    if let Some(model) = llm_model.as_deref().filter(|m| !m.is_empty()) {
        args.push("--llm-model");
        args.push(model);
    }
    let ask_text = ask.unwrap_or_default();
    if !ask_text.is_empty() {
        args.push("--ask");
        args.push(&ask_text);
    }
    let result = run_warpcore_json(&args).await;
    let _ = std::fs::remove_file(&path);
    result
}

/// Run a one-shot JSON command inside a project's directory: state, logs
/// and stubs are CWD-relative in the CLI.
async fn run_warpcore_json_in(dir: &Path, args: &[&str]) -> Result<String, String> {
    let output = warpcore_command()
        .current_dir(dir)
        .args(args)
        .output()
        .await
        .map_err(|e| format!("could not start warpcore: {e}"))?;
    if !output.status.success() {
        return Err(cli_failure(output.status, &output.stderr));
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

/// Accept a finding with a reason, or put it back. Written to the project's
/// .warpcore/findings-mutes.yaml, which the team can commit.
#[tauri::command]
async fn mute_finding(config_path: String, finding_id: String, reason: Option<String>, unmute: bool) -> Result<String, String> {
    let path = std::path::PathBuf::from(&config_path);
    let dir = path.parent().ok_or_else(|| format!("{config_path} has no directory"))?.to_path_buf();
    let why = reason.unwrap_or_default();
    let args: Vec<&str> = if unmute {
        vec!["discover", "unmute", &finding_id, "--config", &config_path]
    } else {
        vec!["discover", "mute", &finding_id, "--reason", &why, "--config", &config_path]
    };
    run_warpcore_json_in(&dir, &args).await
}

/// Live health of every discovered resource on the canvas, from the account.
/// Runs in the project directory so the deployment state beside the file
/// says when warpcore last touched each resource.
#[tauri::command]
async fn project_health(profile: String, config_path: String, environment: Option<String>) -> Result<String, String> {
    let path = std::path::PathBuf::from(&config_path);
    let dir = path.parent().ok_or_else(|| format!("{config_path} has no directory"))?.to_path_buf();
    let mut args: Vec<&str> = vec!["--profile", &profile, "discover", "health", "--config", &config_path, "--json"];
    let env_name = environment.unwrap_or_default();
    if !env_name.is_empty() {
        args.push("--env");
        args.push(&env_name);
    }
    run_warpcore_json_in(&dir, &args).await
}

/// The deployment state against the account: what changed behind warpcore's back.
#[tauri::command]
async fn project_drift(profile: String, config_path: String, environment: Option<String>) -> Result<String, String> {
    let path = std::path::PathBuf::from(&config_path);
    let dir = path.parent().ok_or_else(|| format!("{config_path} has no directory"))?.to_path_buf();
    let mut args: Vec<&str> = vec!["--profile", &profile, "discover", "drift", "--config", &config_path, "--json"];
    let env_name = environment.unwrap_or_default();
    if !env_name.is_empty() {
        args.push("--env");
        args.push(&env_name);
    }
    run_warpcore_json_in(&dir, &args).await
}

/// The project's import snapshots and what changed between the last two.
#[tauri::command]
async fn import_history(config_path: String) -> Result<String, String> {
    let path = std::path::PathBuf::from(&config_path);
    let dir = path.parent().ok_or_else(|| format!("{config_path} has no directory"))?.to_path_buf();
    run_warpcore_json_in(&dir, &["discover", "snapshots", "--config", &config_path, "--json"]).await
}

/// Take over adopted resources: from then on the canvas config is what a
/// deploy enforces. Returns the CLI's JSON (items and release steps).
#[tauri::command]
async fn takeover_resources(config_path: String, environment: String, resources: Vec<String>, dry_run: bool) -> Result<String, String> {
    let path = std::path::PathBuf::from(&config_path);
    let dir = path.parent().ok_or_else(|| format!("{config_path} has no directory"))?.to_path_buf();
    let mut args: Vec<&str> = vec!["discover", "takeover", "--env", &environment, "--config", &config_path, "--json"];
    if dry_run {
        args.push("--dry-run");
    }
    for r in &resources {
        args.push(r);
    }
    run_warpcore_json_in(&dir, &args).await
}

/// How to reach an instance from this machine: the checks and the command,
/// by ARN. Advice only; nothing is opened.
#[tauri::command]
async fn instance_connect(profile: String, arn: String) -> Result<String, String> {
    run_warpcore_json(&["--profile", &profile, "discover", "connect", &arn, "--json"]).await
}

/// Open the composed connect command in the user's terminal. The command is
/// recomputed here from the ARN rather than accepted from the webview, so
/// the only strings that reach a shell are the ones the advisor composed.
#[tauri::command]
async fn open_connect_session(profile: String, arn: String) -> Result<String, String> {
    let raw = run_warpcore_json(&["--profile", &profile, "discover", "connect", &arn, "--json"]).await?;
    let plan: serde_json::Value = serde_json::from_str(&raw).map_err(|e| format!("connect plan was not JSON: {e}"))?;
    let command = plan["command"]
        .as_str()
        .filter(|c| !c.is_empty())
        .ok_or_else(|| "No way in from here; see the checks.".to_string())?;
    open_in_terminal(command)?;
    Ok(command.to_string())
}

/// Run a command in a fresh terminal window, the platform's own way.
fn open_in_terminal(command: &str) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        // AppleScript string: escape backslashes and double quotes.
        let escaped = command.replace('\\', "\\\\").replace('"', "\\\"");
        let script = format!("tell application \"Terminal\"\nactivate\ndo script \"{escaped}\"\nend tell");
        let status = std::process::Command::new("osascript")
            .arg("-e")
            .arg(script)
            .status()
            .map_err(|e| format!("could not run osascript: {e}"))?;
        return if status.success() { Ok(()) } else { Err("Terminal did not accept the command".to_string()) };
    }
    #[cfg(target_os = "linux")]
    {
        let shell = format!("{command}; exec $SHELL");
        for (bin, args) in [
            ("x-terminal-emulator", vec!["-e", "bash", "-c", shell.as_str()]),
            ("gnome-terminal", vec!["--", "bash", "-c", shell.as_str()]),
            ("konsole", vec!["-e", "bash", "-c", shell.as_str()]),
            ("xterm", vec!["-e", "bash", "-c", shell.as_str()]),
        ] {
            if std::process::Command::new(bin).args(&args).spawn().is_ok() {
                return Ok(());
            }
        }
        return Err("No terminal emulator found (tried x-terminal-emulator, gnome-terminal, konsole, xterm)".to_string());
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("cmd")
            .args(["/C", "start", "cmd", "/K", command])
            .spawn()
            .map_err(|e| format!("could not open a terminal: {e}"))?;
        return Ok(());
    }
    #[allow(unreachable_code)]
    Err("Opening a terminal is not supported on this platform".to_string())
}

// ------------------------------------------------------------- workstation
//
// Commands about this machine rather than about AWS: where the app keeps its
// files, how big they are, and the bundled CLI. They back the application
// settings view. None of them touch warpcore.yaml.

fn home_dir() -> Result<std::path::PathBuf, String> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(std::path::PathBuf::from)
        .ok_or_else(|| "could not determine home directory".to_string())
}

/// Only paths inside a `.warpcore` directory may be listed, opened or
/// cleared from the webview. Rust commands are not permission-gated, so this
/// is the whole guard; without it a bug in the frontend could clear `~`.
fn warpcore_owned_path(path: &str) -> Result<std::path::PathBuf, String> {
    let p = std::path::PathBuf::from(path);
    let inside = p.components().any(|c| c.as_os_str() == ".warpcore");
    if !inside || p.components().any(|c| matches!(c, std::path::Component::ParentDir)) {
        return Err(format!("{path} is not inside a .warpcore directory"));
    }
    Ok(p)
}

fn unix_seconds(t: std::time::SystemTime) -> u64 {
    t.duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/// `warpcore --version`, run once: a PyInstaller binary takes seconds to
/// start and the answer cannot change while this process lives. A failure
/// is not cached, so a sidecar built later is picked up on the next ask.
static CLI_VERSION: tokio::sync::OnceCell<String> = tokio::sync::OnceCell::const_new();

async fn cli_version() -> (Option<String>, Option<String>) {
    if let Some(v) = CLI_VERSION.get() {
        return (Some(v.clone()), None);
    }
    match warpcore_command().arg("--version").output().await {
        Ok(out) if out.status.success() => {
            let v = String::from_utf8_lossy(&out.stdout).trim().to_string();
            let _ = CLI_VERSION.set(v.clone());
            (Some(v), None)
        }
        Ok(out) => {
            let stderr = String::from_utf8_lossy(&out.stderr);
            let tail = stderr.lines().rev().take(3).collect::<Vec<_>>().into_iter().rev().collect::<Vec<_>>().join("\n");
            (None, Some(format!("warpcore exited with {}: {}", out.status, tail.trim())))
        }
        Err(e) => (None, Some(format!("could not start warpcore: {e}"))),
    }
}

#[derive(Clone, serde::Serialize)]
struct AppPaths {
    home_warpcore: String,
    project_warpcore: Option<String>,
    sidecar_path: String,
    sidecar_bundled: bool,
    app_version: String,
    cli_version: Option<String>,
    cli_error: Option<String>,
    platform: String,
    /// True for `tauri dev` / debug builds. Two copies of the app can be
    /// running after a dev restart; this plus the build stamp tells them apart.
    debug: bool,
    git_sha: String,
    git_dirty: bool,
    /// Unix seconds when this binary was compiled.
    build_time: u64,
    /// Unix seconds the sidecar file was last written: when the CLI was built.
    sidecar_modified: Option<u64>,
}

const GIT_SHA: &str = env!("WARPCORE_GIT_SHA");
const GIT_DIRTY: &str = env!("WARPCORE_GIT_DIRTY");
const BUILD_TIME: &str = env!("WARPCORE_BUILD_TIME");

/// What to call this build in a title bar: "dev a1b2c3d4e*" or "" for release.
fn build_label() -> String {
    if cfg!(debug_assertions) {
        format!("dev {GIT_SHA}{}", if GIT_DIRTY == "1" { "*" } else { "" })
    } else {
        String::new()
    }
}

/// Where the app's files live, plus the bundled CLI's version. The CLI is
/// actually run so "sidecar ok" in the UI means it started, not that a file
/// exists.
#[tauri::command]
async fn app_paths(app: tauri::AppHandle, config_path: Option<String>) -> Result<AppPaths, String> {
    let home = home_dir()?;
    let project_warpcore = config_path
        .as_deref()
        .and_then(|p| Path::new(p).parent())
        .filter(|d| d.is_dir())
        .map(|d| d.join(".warpcore").to_string_lossy().into_owned());

    let sidecar = warpcore_path();
    let sidecar_bundled = sidecar.is_absolute() && sidecar.is_file();
    let (cli_version, cli_error) = cli_version().await;

    Ok(AppPaths {
        home_warpcore: home.join(".warpcore").to_string_lossy().into_owned(),
        project_warpcore,
        sidecar_path: sidecar.to_string_lossy().into_owned(),
        sidecar_bundled,
        app_version: app.package_info().version.to_string(),
        cli_version,
        cli_error,
        platform: std::env::consts::OS.to_string(),
        debug: cfg!(debug_assertions),
        git_sha: GIT_SHA.to_string(),
        git_dirty: GIT_DIRTY == "1",
        build_time: BUILD_TIME.parse().unwrap_or(0),
        sidecar_modified: std::fs::metadata(&sidecar).and_then(|m| m.modified()).ok().map(unix_seconds),
    })
}

#[derive(Clone, serde::Serialize)]
struct DirUsage {
    path: String,
    exists: bool,
    bytes: u64,
    files: u64,
    newest: Option<u64>,
}

/// Size and file count of a directory tree. Missing directories are reported
/// as empty rather than as errors: "no logs yet" is a normal state.
#[tauri::command]
async fn dir_usage(path: String) -> Result<DirUsage, String> {
    let dir = warpcore_owned_path(&path)?;
    tokio::task::spawn_blocking(move || {
        let mut usage = DirUsage { path: path.clone(), exists: dir.is_dir(), bytes: 0, files: 0, newest: None };
        if !usage.exists {
            return usage;
        }
        for entry in WalkDir::new(&dir).into_iter().filter_map(Result::ok) {
            if !entry.file_type().is_file() {
                continue;
            }
            if let Ok(meta) = entry.metadata() {
                usage.files += 1;
                usage.bytes += meta.len();
                if let Ok(modified) = meta.modified() {
                    let secs = unix_seconds(modified);
                    usage.newest = Some(usage.newest.map_or(secs, |n| n.max(secs)));
                }
            }
        }
        usage
    })
    .await
    .map_err(|e| e.to_string())
}

#[derive(Clone, serde::Serialize)]
struct DirEntryInfo {
    name: String,
    path: String,
    bytes: u64,
    modified: u64,
    is_dir: bool,
}

/// Immediate children of a directory, newest first.
#[tauri::command]
async fn list_dir(path: String) -> Result<Vec<DirEntryInfo>, String> {
    let dir = warpcore_owned_path(&path)?;
    if !dir.is_dir() {
        return Ok(Vec::new());
    }
    tokio::task::spawn_blocking(move || list_dir_blocking(&dir))
        .await
        .map_err(|e| e.to_string())?
}

fn list_dir_blocking(dir: &Path) -> Result<Vec<DirEntryInfo>, String> {
    let mut entries = Vec::new();
    for entry in std::fs::read_dir(dir).map_err(|e| e.to_string())?.flatten() {
        let meta = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        let bytes = if meta.is_dir() {
            WalkDir::new(entry.path())
                .into_iter()
                .filter_map(Result::ok)
                .filter(|e| e.file_type().is_file())
                .filter_map(|e| e.metadata().ok())
                .map(|m| m.len())
                .sum()
        } else {
            meta.len()
        };
        entries.push(DirEntryInfo {
            name: entry.file_name().to_string_lossy().into_owned(),
            path: entry.path().to_string_lossy().into_owned(),
            bytes,
            modified: meta.modified().map(unix_seconds).unwrap_or(0),
            is_dir: meta.is_dir(),
        });
    }
    entries.sort_by(|a, b| b.modified.cmp(&a.modified).then_with(|| a.name.cmp(&b.name)));
    Ok(entries)
}

/// Reveal a `.warpcore` path in the desktop's file manager.
#[tauri::command]
async fn open_path(path: String) -> Result<(), String> {
    let target = warpcore_owned_path(&path)?;
    if !target.exists() {
        return Err(format!("{path} does not exist yet"));
    }
    let opener = if cfg!(target_os = "macos") { "open" } else if cfg!(windows) { "explorer" } else { "xdg-open" };
    std::process::Command::new(opener)
        .arg(&target)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("could not open {path}: {e}"))
}

/// Delete the files under a `.warpcore` subdirectory, optionally only those
/// older than N days. Directories are kept. Deployment state is refused: it
/// is not cache, and losing it orphans real AWS resources.
#[tauri::command]
async fn clear_dir(path: String, older_than_days: Option<u32>) -> Result<u64, String> {
    let dir = warpcore_owned_path(&path)?;
    if dir.components().any(|c| c.as_os_str() == "state") {
        return Err("deployment state cannot be cleared from the app".to_string());
    }
    if dir.components().last().map(|c| c.as_os_str() == ".warpcore").unwrap_or(true) {
        return Err("refusing to clear a whole .warpcore directory; pick a subdirectory".to_string());
    }
    if !dir.is_dir() {
        return Ok(0);
    }
    let cutoff = older_than_days.map(|days| {
        std::time::SystemTime::now() - std::time::Duration::from_secs(u64::from(days) * 86_400)
    });
    tokio::task::spawn_blocking(move || {
        let mut removed = 0u64;
        for entry in WalkDir::new(&dir).into_iter().filter_map(Result::ok) {
            if !entry.file_type().is_file() {
                continue;
            }
            if let Some(cutoff) = cutoff {
                match std::fs::metadata(entry.path()).and_then(|m| m.modified()) {
                    Ok(modified) if modified < cutoff => {}
                    _ => continue,
                }
            }
            if std::fs::remove_file(entry.path()).is_ok() {
                removed += 1;
            }
        }
        Ok(removed)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// The last `lines` lines of a text file. Reads at most the final 512 KB so
/// a week of debug logs does not have to come through the IPC bridge.
#[tauri::command]
async fn read_text_tail(path: String, lines: usize) -> Result<String, String> {
    use tokio::io::{AsyncReadExt, AsyncSeekExt};
    let file = warpcore_owned_path(&path)?;
    const WINDOW: u64 = 512 * 1024;
    let mut handle = tokio::fs::File::open(&file).await.map_err(|e| format!("could not read {path}: {e}"))?;
    let len = handle.metadata().await.map_err(|e| e.to_string())?.len();
    let start = len.saturating_sub(WINDOW);
    handle.seek(std::io::SeekFrom::Start(start)).await.map_err(|e| e.to_string())?;
    let mut bytes = Vec::with_capacity((len - start) as usize);
    handle.read_to_end(&mut bytes).await.map_err(|e| e.to_string())?;
    let text = String::from_utf8_lossy(&bytes);
    let mut tail: Vec<&str> = text.lines().rev().take(lines.max(1)).collect();
    tail.reverse();
    Ok(tail.join("\n"))
}

/// Audit entries for one environment as the CLI's JSON, newest first. Runs
/// from the project directory when one is open so the project-local trail is
/// the one that is read.
#[tauri::command]
async fn list_audit_entries(
    config_path: Option<String>,
    environment: String,
    limit: u32,
) -> Result<String, String> {
    let mut cmd = warpcore_command();
    if let Some(cfg) = config_path.as_deref() {
        cmd = with_project_dir(cmd, cfg);
    }
    let limit = limit.max(1).to_string();
    let output = cmd
        .args(["audit", "list", "--env", &environment, "--limit", &limit, "--json"])
        .output()
        .await
        .map_err(|e| format!("could not start warpcore: {e}"))?;
    if !output.status.success() {
        return Err(cli_failure(output.status, &output.stderr));
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

// --------------------------------------------------------------- scan cache
//
// Completed account scans, kept under ~/.warpcore/cache/explorer so the
// Explorer can open instantly and the operator decides how stale is too
// stale (Settings › Exploration). Account scans are not project-specific,
// so the cache is always in the home directory.

fn scan_cache_dir() -> Result<std::path::PathBuf, String> {
    Ok(home_dir()?.join(".warpcore").join("cache").join("explorer"))
}

fn scan_cache_file(key: &str) -> Result<std::path::PathBuf, String> {
    let safe: String = key
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '+' | '.') { c } else { '_' })
        .take(150)
        .collect();
    if safe.is_empty() {
        return Err("empty cache key".to_string());
    }
    Ok(scan_cache_dir()?.join(format!("{safe}.json")))
}

#[derive(Clone, serde::Serialize)]
struct ScanCacheHit {
    saved_at: u64,
    content: String,
}

#[tauri::command]
async fn read_scan_cache(key: String) -> Result<Option<ScanCacheHit>, String> {
    let file = scan_cache_file(&key)?;
    let meta = match tokio::fs::metadata(&file).await {
        Ok(m) => m,
        Err(_) => return Ok(None),
    };
    let content = tokio::fs::read_to_string(&file).await.map_err(|e| e.to_string())?;
    Ok(Some(ScanCacheHit {
        saved_at: meta.modified().map(unix_seconds).unwrap_or(0),
        content,
    }))
}

#[tauri::command]
async fn write_scan_cache(key: String, content: String) -> Result<(), String> {
    let file = scan_cache_file(&key)?;
    if let Some(dir) = file.parent() {
        tokio::fs::create_dir_all(dir).await.map_err(|e| e.to_string())?;
    }
    tokio::fs::write(&file, content).await.map_err(|e| e.to_string())
}

fn main() {
    tauri::Builder::default()
        .manage(ActiveScan::default())
        // Only the dialog plugin is used: the frontend opens a file picker.
        // All file IO happens in Rust commands via tokio::fs/std::fs, which
        // needs no plugin and is not reachable from the webview.
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            // A dev build says so in its title bar, with the commit it was
            // built from, so a stale instance left behind by a `tauri dev`
            // restart is recognisable at a glance.
            let label = build_label();
            if !label.is_empty() {
                use tauri::Manager;
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.set_title(&format!("Warpcore Visual Builder \u{2014} {label}"));
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            execute_cli_command,
            read_config_file,
            write_config_file,
            watch_config_file,
            get_deployment_status,
            scan_project_for_strands,
            execute_deployment,
            execute_destroy,
            validate_config,
            get_deployment_history,
            list_aws_profiles,
            discover_account,
            resource_detail,
            instance_connect,
            open_connect_session,
            project_findings,
            project_health,
            project_drift,
            import_history,
            assistant_suggest,
            takeover_resources,
            mute_finding,
            cancel_scan,
            list_regions,
            app_paths,
            dir_usage,
            list_dir,
            open_path,
            clear_dir,
            read_text_tail,
            list_audit_entries,
            read_scan_cache,
            write_scan_cache,
            create_project_from_account,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
