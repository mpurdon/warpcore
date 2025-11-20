// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use tauri::Manager;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command as TokioCommand;

#[derive(Clone, serde::Serialize)]
struct DeploymentUpdate {
    resource_id: String,
    status: String,
    message: String,
}

// Execute Python CLI command
#[tauri::command]
async fn execute_cli_command(
    command: String,
    args: Vec<String>,
    window: tauri::Window,
) -> Result<String, String> {
    let mut cmd = TokioCommand::new("strands");
    cmd.args(&args);
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());

    let mut child = cmd.spawn().map_err(|e| e.to_string())?;

    // Stream stdout
    if let Some(stdout) = child.stdout.take() {
        let reader = BufReader::new(stdout);
        let mut lines = reader.lines();
        
        tokio::spawn(async move {
            while let Ok(Some(line)) = lines.next_line().await {
                let _ = window.emit("cli-output", line);
            }
        });
    }

    // Stream stderr
    if let Some(stderr) = child.stderr.take() {
        let reader = BufReader::new(stderr);
        let mut lines = reader.lines();
        let window_clone = window.clone();
        
        tokio::spawn(async move {
            while let Ok(Some(line)) = lines.next_line().await {
                let _ = window_clone.emit("cli-error", line);
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
        let mut last_modified = std::fs::metadata(&path)
            .and_then(|m| m.modified())
            .ok();

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

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            execute_cli_command,
            read_config_file,
            write_config_file,
            watch_config_file,
            get_deployment_status,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
