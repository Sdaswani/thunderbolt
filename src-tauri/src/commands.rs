/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

use anyhow::Result;
use serde::Serialize;
use tauri::command;

#[command]
pub async fn toggle_dock_icon(app_handle: tauri::AppHandle, show: bool) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        use tauri::ActivationPolicy;

        let policy = if show {
            ActivationPolicy::Regular
        } else {
            ActivationPolicy::Accessory
        };

        let _ = app_handle.set_activation_policy(policy);
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = app_handle;
        let _ = show;
    }

    Ok(())
}

// === Interface Style (iOS keyboard/system UI theme) ==========================================

/// Set the native user interface style on iOS to control keyboard and system UI appearance.
/// Android keyboards follow the system dark mode setting and cannot be overridden per-app.
/// Desktop: no-op.
/// style: "system" | "light" | "dark"
#[command]
pub fn set_interface_style(style: String) -> Result<(), String> {
    #[cfg(target_os = "ios")]
    {
        use objc2_foundation::MainThreadMarker;
        use objc2_ui_kit::{UIApplication, UIUserInterfaceStyle, UIWindowScene};

        let ui_style = match style.as_str() {
            "light" => UIUserInterfaceStyle::Light,
            "dark" => UIUserInterfaceStyle::Dark,
            _ => UIUserInterfaceStyle::Unspecified,
        };

        let mtm = MainThreadMarker::new()
            .ok_or_else(|| "set_interface_style must run on the main thread".to_string())?;

        let app = UIApplication::sharedApplication(mtm);
        for scene in app.connectedScenes() {
            if let Some(window_scene) = scene.downcast_ref::<UIWindowScene>() {
                for window in window_scene.windows() {
                    window.setOverrideUserInterfaceStyle(ui_style);
                }
            }
        }
    }

    #[cfg(not(target_os = "ios"))]
    {
        let _ = style;
    }

    Ok(())
}

// === Capabilities ============================================================================

/// List of runtime capabilities that the renderer can query once and cache.
/// Extend this struct whenever we add more feature flags.
#[derive(Serialize)]
pub struct Capabilities {
    /// Whether the application was compiled with the `native_fetch` feature and therefore the
    /// `tauri-plugin-http` plugin is available for native HTTP requests.
    pub native_fetch: bool,
}

#[cfg(feature = "native_fetch")]
const NATIVE_FETCH_ENABLED: bool = true;
#[cfg(not(feature = "native_fetch"))]
const NATIVE_FETCH_ENABLED: bool = false;

/// Returns the set of capabilities supported by the current build.
#[command]
pub fn capabilities() -> Capabilities {
    Capabilities {
        native_fetch: NATIVE_FETCH_ENABLED,
    }
}

// === Zeus bridge installer ===================================================================

/// The canonical one-liner that installs the `zeus` bridge onto the user's PATH —
/// identical to what the connect dialog shows for manual install.
const ZEUS_INSTALL_CMD: &str =
    "curl -fsSL https://raw.githubusercontent.com/thunderbird/thunderbolt/main/zeus/install.sh | bash";

/// Runs the `zeus` bridge installer from the desktop connect dialog so the user
/// can install the bridge without opening a terminal. Spawns the canonical
/// `curl … | bash` one-liner through a login shell (so `node`/`npm`/`curl` and the
/// install target dir are on PATH), off the async runtime so the UI stays
/// responsive. Returns the installer's stdout on success, or its error output on
/// a non-zero exit. Desktop only — the renderer gates the call behind `isDesktop()`.
#[cfg(desktop)]
#[command]
pub async fn install_bridge() -> Result<String, String> {
    let output = tauri::async_runtime::spawn_blocking(|| {
        std::process::Command::new("bash")
            .args(["-lc", ZEUS_INSTALL_CMD])
            .output()
    })
    .await
    .map_err(|e| format!("installer task failed: {e}"))?
    .map_err(|e| format!("failed to spawn installer: {e}"))?;

    if output.status.success() {
        return Ok(String::from_utf8_lossy(&output.stdout).trim().to_string());
    }

    let stderr = String::from_utf8_lossy(&output.stderr);
    let stdout = String::from_utf8_lossy(&output.stdout);
    let detail = if stderr.trim().is_empty() {
        stdout.trim()
    } else {
        stderr.trim()
    };
    Err(format!(
        "installer exited with status {}: {}",
        output.status.code().unwrap_or(-1),
        detail
    ))
}

/// Mobile builds have no shell/terminal, so the installer is desktop-only.
#[cfg(not(desktop))]
#[command]
pub async fn install_bridge() -> Result<String, String> {
    Err("The bridge installer is only available on desktop.".to_string())
}

// === OAuth loopback server ===================================================================

/// Ports pre-registered as redirect URIs in the Google / Microsoft OAuth console.
const OAUTH_PORTS: &[u16] = &[17421, 17422, 17423];

/// Starts the in-house OAuth loopback server and returns the port it bound to.
///
/// The Rust server accepts one HTTP connection, sends an "Authentication Complete"
/// response, emits an `"oauth-callback"` event to the frontend, then shuts down.
/// No external HTTP framework or Tauri plugin is required.
#[command]
pub async fn start_oauth_server(app: tauri::AppHandle) -> Result<u16, String> {
    crate::oauth_server::start(app, OAUTH_PORTS)
}
