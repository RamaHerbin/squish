// Release builds on Windows would otherwise spawn a console window behind the
// app. Pinch only ships macOS today; the attribute costs nothing and keeps the
// crate portable.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    pinch_lib::run()
}
