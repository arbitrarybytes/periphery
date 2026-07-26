// Periphery — Tauri backend entry point.
// Hides the console window on Windows release builds; the app lives in the tray.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    periphery_lib::run();
}
