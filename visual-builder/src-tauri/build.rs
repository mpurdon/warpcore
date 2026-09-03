use std::process::Command;

/// Stamp the binary with what it was built from, so two running copies can
/// be told apart: `tauri dev` restarts leave the previous instance alive,
/// and both say "1.0.0". The frontend shows these in the title bar, the rail
/// footer and Settings › About.
fn git(args: &[&str]) -> Option<String> {
    let out = Command::new("git").args(args).output().ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if s.is_empty() { None } else { Some(s) }
}

fn main() {
    let sha = git(&["rev-parse", "--short=9", "HEAD"]).unwrap_or_else(|| "unknown".into());
    let dirty = git(&["status", "--porcelain", "--untracked-files=no"]).is_some();
    let build_time = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    println!("cargo:rustc-env=WARPCORE_GIT_SHA={sha}");
    println!("cargo:rustc-env=WARPCORE_GIT_DIRTY={}", if dirty { "1" } else { "0" });
    println!("cargo:rustc-env=WARPCORE_BUILD_TIME={build_time}");
    // Re-stamp when the commit changes; the time re-stamps on every rebuild anyway.
    println!("cargo:rerun-if-changed=../../.git/HEAD");
    println!("cargo:rerun-if-changed=../../.git/refs/heads");

    tauri_build::build()
}
