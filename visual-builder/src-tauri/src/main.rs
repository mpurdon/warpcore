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

// Execute deployment with real-time status updates
#[tauri::command]
async fn execute_deployment(
    config_path: String,
    environment: String,
    debug: bool,
    window: tauri::Window,
) -> Result<String, String> {
    use std::time::Instant;

    let start = Instant::now();

    // Emit deployment started event
    let _ = window.emit(
        "deployment-update",
        serde_json::json!({
            "type": "deployment_started",
            "resourceId": "all",
            "data": {
                "environment": environment,
                "configPath": config_path,
                "timestamp": chrono::Utc::now().to_rfc3339()
            }
        }),
    );

    let mut cmd = with_project_dir(warpcore_command(), &config_path);
    cmd.args(warpcore_args(
        debug,
        &["deploy", "--env", &environment, "--config", &config_path],
    ));
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());

    let mut child = cmd.spawn().map_err(|e| e.to_string())?;

    let window_stdout = window.clone();
    let window_stderr = window.clone();

    // Parse deployment output to emit structured events
    if let Some(stdout) = child.stdout.take() {
        let reader = BufReader::new(stdout);
        let mut lines = reader.lines();

        tokio::spawn(async move {
            // Regex patterns to detect resource status changes
            let provisioning_re = Regex::new(r"Provisioning:\s*(.+)").ok();
            let success_re = Regex::new(r"✓\s*(.+)").ok();
            let failed_re = Regex::new(r"✗\s*(.+):\s*(.+)").ok();

            while let Ok(Some(line)) = lines.next_line().await {
                // Emit raw output
                let _ = window_stdout.emit("cli-output", &line);

                // Parse for structured events
                if let Some(ref re) = provisioning_re {
                    if let Some(cap) = re.captures(&line) {
                        let resource_id = cap.get(1).map_or("unknown", |m| m.as_str());
                        let _ = window_stdout.emit(
                            "deployment-update",
                            serde_json::json!({
                                "type": "resource_status",
                                "resourceId": resource_id.trim(),
                                "data": { "status": "deploying" }
                            }),
                        );
                    }
                }

                if let Some(ref re) = success_re {
                    if let Some(cap) = re.captures(&line) {
                        let resource_id = cap.get(1).map_or("unknown", |m| m.as_str());
                        let _ = window_stdout.emit(
                            "deployment-update",
                            serde_json::json!({
                                "type": "resource_status",
                                "resourceId": resource_id.trim(),
                                "data": { "status": "deployed" }
                            }),
                        );
                    }
                }

                if let Some(ref re) = failed_re {
                    if let Some(cap) = re.captures(&line) {
                        let resource_id = cap.get(1).map_or("unknown", |m| m.as_str());
                        let error = cap.get(2).map_or("", |m| m.as_str());
                        let _ = window_stdout.emit(
                            "deployment-update",
                            serde_json::json!({
                                "type": "resource_status",
                                "resourceId": resource_id.trim(),
                                "data": {
                                    "status": "failed",
                                    "error": error.trim()
                                }
                            }),
                        );
                    }
                }
            }
        });
    }

    // Stream stderr
    if let Some(stderr) = child.stderr.take() {
        let reader = BufReader::new(stderr);
        let mut lines = reader.lines();

        tokio::spawn(async move {
            while let Ok(Some(line)) = lines.next_line().await {
                let _ = window_stderr.emit("cli-error", &line);
            }
        });
    }

    let status = child.wait().await.map_err(|e| e.to_string())?;
    let duration = start.elapsed().as_secs_f64();

    // Emit deployment completed event
    let final_status = if status.success() {
        "deployed"
    } else {
        "failed"
    };
    let _ = window.emit(
        "deployment-update",
        serde_json::json!({
            "type": "deployment_complete",
            "resourceId": "all",
            "data": {
                "status": final_status,
                "duration": duration,
                "exitCode": status.code()
            }
        }),
    );

    if status.success() {
        Ok(format!("Deployment completed in {:.2}s", duration))
    } else {
        Err(format!("Deployment failed with status: {}", status))
    }
}

// Execute destroy with real-time status updates
#[tauri::command]
async fn execute_destroy(
    config_path: String,
    environment: String,
    debug: bool,
    window: tauri::Window,
) -> Result<String, String> {
    let mut cmd = with_project_dir(warpcore_command(), &config_path);
    cmd.args(warpcore_args(
        debug,
        &[
            "destroy",
            "--env",
            &environment,
            "--config",
            &config_path,
            "-y",
        ],
    ));
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());

    let mut child = cmd.spawn().map_err(|e| e.to_string())?;

    let window_stdout = window.clone();

    if let Some(stdout) = child.stdout.take() {
        let reader = BufReader::new(stdout);
        let mut lines = reader.lines();

        tokio::spawn(async move {
            while let Ok(Some(line)) = lines.next_line().await {
                let _ = window_stdout.emit("cli-output", &line);
            }
        });
    }

    if let Some(stderr) = child.stderr.take() {
        let reader = BufReader::new(stderr);
        let mut lines = reader.lines();

        tokio::spawn(async move {
            while let Ok(Some(line)) = lines.next_line().await {
                let _ = window.emit("cli-error", &line);
            }
        });
    }

    let status = child.wait().await.map_err(|e| e.to_string())?;

    if status.success() {
        Ok("Destroy completed successfully".to_string())
    } else {
        Err(format!("Destroy failed with status: {}", status))
    }
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
        let stderr = String::from_utf8_lossy(&output.stderr);
        let tail: String = stderr.lines().rev().take(8).collect::<Vec<_>>().into_iter().rev().collect::<Vec<_>>().join("\n");
        return Err(format!("warpcore exited with {}:\n{}", output.status, tail));
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
    profile: String,
    regions: Vec<String>,
    all_regions: bool,
    hydrate: bool,
) -> Result<String, String> {
    let mut args: Vec<String> = vec![
        "--profile".into(), profile,
        "discover".into(), "inventory".into(), "--json".into(),
        if hydrate { "--hydrate" } else { "--no-hydrate" }.into(),
    ];
    if all_regions {
        args.push("--all-regions".into());
    } else {
        for region in regions {
            args.push("--region".into());
            args.push(region);
        }
    }
    let borrowed: Vec<&str> = args.iter().map(String::as_str).collect();
    run_warpcore_json(&borrowed).await
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

fn main() {
    tauri::Builder::default()
        // Only the dialog plugin is used: the frontend opens a file picker.
        // All file IO happens in Rust commands via tokio::fs/std::fs, which
        // needs no plugin and is not reachable from the webview.
        .plugin(tauri_plugin_dialog::init())
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
